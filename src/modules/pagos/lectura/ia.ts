/**
 * Lectura completa de la factura con la API de Anthropic (20260924u).
 *
 * A diferencia del control de `control.service.ts` —que a propósito le pide
 * al modelo sólo número, total y fecha—, acá se le pide TODO lo que el
 * contador necesita para el Libro IVA: emisor, receptor, comprobante, neto
 * por alícuota, IVA por alícuota, no gravado, exento y cada percepción con su
 * jurisdicción. Lo que hace que esto sea razonable ahora:
 *   - structured output con schema: la respuesta es JSON válido con esas
 *     claves o no es nada (las claves van en ASCII: una ñ rompe la llamada);
 *   - el QR de ARCA, cuando está, manda sobre lo leído en lo que trae
 *     (CUIT, tipo, número, fecha, total, CAE);
 *   - la fusión controla que las sumas cierren contra el total y AVISA campo
 *     por campo: nada de esto se guarda sin que una persona lo vea.
 *
 * NUNCA lanza: sin key, con el archivo ilegible o con la API caída devuelve
 * `{ ok: false, motivo }` y la carga sigue con el QR o a mano.
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { TIPOS_TRIBUTO } from './arca.js'
import { getEmpresa, type Empresa } from '../../../lib/empresa.js'

/** Modelo por defecto. Se puede cambiar sin deploy con PAGOS_LECTURA_MODEL. */
// 24/09: Sonnet 5 en vez de Opus 5 (más barato). Probado sobre las 17 facturas
// reales cargadas: Sonnet leyó igual que Opus en todas (CUIT, número, fecha,
// neto, IVA, percepciones, total); Haiku 4.5 erró 6 de 17, así que no.
export const MODELO_LECTURA_DEFAULT = 'claude-sonnet-5'

const MIME_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const Num = z.number().nullable()
const Txt = z.string().nullable()

export const LecturaIASchema = z.object({
  legible: z.boolean(),
  emisor_cuit: Txt,
  emisor_razon_social: Txt,
  receptor_cuit: Txt,
  receptor_razon_social: Txt,
  letra: z.enum(['A', 'B', 'C', 'M', 'E', 'X']).nullable(),
  clase: z.enum(['factura', 'nota_debito', 'nota_credito', 'recibo', 'ticket', 'otro']).nullable(),
  codigo_comprobante: z.number().int().nullable(),
  punto_venta: Txt,
  numero: Txt,
  fecha_emision: Txt,
  fecha_vencimiento_pago: Txt,
  cae: Txt,
  cae_vencimiento: Txt,
  moneda: Txt,
  neto_gravado_total: Num,
  no_gravado: Num,
  exento: Num,
  iva: z.array(z.object({
    alicuota_pct: z.number(),
    base_imponible: Num,
    importe: z.number(),
  })),
  tributos: z.array(z.object({
    tipo: z.enum(TIPOS_TRIBUTO),
    jurisdiccion: Txt,
    descripcion: z.string(),
    alicuota_pct: Num,
    base_imponible: Num,
    importe: z.number(),
  })),
  total: Num,
  // Sólo en notas de crédito/débito: a qué factura(s) se refiere
  // («Comprobante asociado», «s/ Fact. A 0001-00000045»). Claves en ASCII.
  comprobantes_asociados: z.array(z.object({
    letra: z.enum(['A', 'B', 'C', 'M', 'E', 'X']).nullable(),
    punto_venta: Txt,
    numero: Txt,
  })),
  detalle_breve: Txt,
  // El concepto de compra (20260925i), elegido de la lista que se le pasa en
  // el prompt, por id. null si no hay lista o si no se puede decidir.
  concepto_id: z.number().int().nullable(),
  notas: Txt,
})
export type LecturaIA = z.infer<typeof LecturaIASchema>

/** Un concepto de compra activo, tal como se le ofrece al modelo. */
export interface ConceptoOfrecido { id: number; nombre: string }

/**
 * La lista de conceptos para el prompt. Sale de la base en cada lectura (el
 * contador la ajusta desde el sistema), así que no se puede escribir fija.
 */
export function instruccionConcepto(conceptos: readonly ConceptoOfrecido[]): string {
  if (conceptos.length === 0) return `

Concepto
- concepto_id: null.`
  return `

Concepto de compra (cómo lo clasifica la contabilidad)
- concepto_id: el id de UNO de estos conceptos, según lo que se compró (lo mismo que resumiste en detalle_breve). Gasoil, nafta o GNC → Combustible; cemento, hierro, cal, pintura para obra → Materiales de obra; flete o transporte → Fletes y transporte; repuestos o arreglos de vehículos o máquinas → Mantenimiento y repuestos.
${conceptos.map((c) => `  ${c.id} = ${c.nombre}`).join('\n')}
- Si el comprobante mezcla varias cosas, el concepto de lo que más pesa en el total. Si no se puede decidir, null. Nunca un id que no esté en la lista.`
}

export type ResultadoIA =
  | { ok: true; lectura: LecturaIA; modelo: string }
  | { ok: false; motivo: string; modelo: string | null }

/** El prompt de sistema se arma en cada llamada con los datos de la empresa (tanda 6). */
export function sistema(emp: Pick<Empresa, 'razon_social' | 'cuit_fmt'>): string {
  return `Leés comprobantes de compra argentinos (facturas de proveedores) para la contabilidad de ${emp.razon_social} (CUIT ${emp.cuit_fmt}), que es la empresa que COMPRA. Tu salida alimenta el Libro IVA Digital de compras, así que cada número tiene que salir del papel tal cual: si un dato no se ve con seguridad, devolvé null. Es mucho peor un número inventado que un campo vacío.`
}

const INSTRUCCIONES = `Extraé los datos del comprobante adjunto.

Emisor y receptor
- emisor_*: quien EMITE la factura (el proveedor), arriba del comprobante. receptor_*: a quién se le factura (debería ser CADINC). CUIT sólo con dígitos (11).

Comprobante
- letra: la letra grande del recuadro (A, B, C, M, E). clase: factura, nota_debito, nota_credito, recibo, ticket u otro.
- codigo_comprobante: el "COD." impreso junto a la letra (Factura A = 01, B = 06, C = 11, NC A = 03…), como entero. null si no está impreso.
- punto_venta y numero: con los ceros impresos, por separado ("00011" y "00000194"). Suele verse como "Punto de Venta: 00011 Comp. Nro: 00000194" o "0012-00402141".
- fecha_emision: la de emisión (AAAA-MM-DD; el papel argentino es día/mes/año). No confundir con el vencimiento del CAE ni con el período facturado.
- fecha_vencimiento_pago: "Fecha de Vto. para el pago" si está; si no, null.
- cae y cae_vencimiento: el CAE (14 dígitos) y su fecha de vencimiento.
- moneda: código como "PES" o "DOL" si se indica; null si no dice nada (se asume pesos).

Importes (números con punto decimal, sin separador de miles: 24994.52)
- iva: una fila por cada alícuota que discrimine el comprobante (21, 10.5, 27, 5, 2.5 o 0), con su base imponible (el neto gravado a esa alícuota) y el importe de IVA. Si el comprobante muestra un solo "Neto gravado" y un solo "IVA 21%", es una fila. Si es B o C y no discrimina IVA, la lista va vacía.
- neto_gravado_total: la suma del neto gravado (en A = el "Subtotal" o "Importe neto gravado"; en B/C sin IVA discriminado, el subtotal o el total sin otros tributos).
- no_gravado: "Importe no gravado" / "Conceptos no gravados". exento: "Importe exento". null si no figuran.
- tributos: cada percepción o impuesto que se suma al total, uno por fila:
  percepcion_iva (Percepción IVA, RG 2408/3337), percepcion_iibb (Percepción Ingresos Brutos, con la provincia en jurisdiccion: "Tucumán", "Buenos Aires", "CABA", "Córdoba"…), percepcion_ganancias, percepcion_municipal (tasas municipales, con el municipio en jurisdiccion), impuestos_internos, otro (cualquier otro tributo sumado al total). descripcion = el texto tal como figura. alicuota_pct y base_imponible si están impresas.
  No pongas en tributos el IVA común ni descuentos.
- total: el IMPORTE TOTAL final del comprobante (en una nota de crédito, también en positivo).

Comprobantes asociados (sólo notas de crédito o de débito)
- comprobantes_asociados: cada factura a la que se refiere la nota, como figura en el papel («Comprobante asociado», «Cbte. Asoc.», «s/ Factura A 0001-00000045», «Ref. FC 00012-00004557»): letra, punto_venta y numero por separado, con los ceros impresos. Lista vacía si no menciona ninguno o si es una factura.
- detalle_breve: qué se compró, en pocas palabras y en castellano, para que quien aprueba lo entienda (ej.: "silicona neutra y cinceles", "perfil perimetral PVC"). Máximo 80 caracteres.

Controles que tenés que hacer antes de responder
- neto_gravado_total + no_gravado + exento + Σ iva.importe + Σ tributos.importe tiene que dar total (±0,05). Si no te cierra, revisá qué leíste mal; si no podés resolverlo, explicalo en notas.
- En notas, en una o dos frases, cualquier cosa rara (manuscrito, borroso, varias páginas, moneda extranjera, no es una factura). null si no hay nada que decir.
- legible: false si el comprobante no se puede leer con confianza.`

export function bloqueDelArchivo(base64: string, mime: string): Anthropic.Beta.BetaContentBlockParam | null {
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
  }
  if (MIME_IMAGEN.has(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg', data: base64 } }
  }
  return null
}

/**
 * Lee la factura. `archivo` son los bytes tal como están en el bucket.
 * Refusal fallbacks prendidos (recomendación para claude-opus-5): si el
 * modelo declina, la API reintenta sola con otro modelo en la misma llamada.
 */
export async function leerFacturaConIA(archivo: Buffer, mime: string, conceptos: readonly ConceptoOfrecido[] = []): Promise<ResultadoIA> {
  const modelo = process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, motivo: 'SIN_API_KEY', modelo: null }
  const bloque = bloqueDelArchivo(archivo.toString('base64'), mime)
  if (!bloque) return { ok: false, motivo: 'FORMATO_NO_SOPORTADO', modelo }

  try {
    const client = new Anthropic({ timeout: 150_000, maxRetries: 1 })
    const r = await client.beta.messages.parse({
      model: modelo,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: sistema(await getEmpresa()),
      output_config: { format: betaZodOutputFormat(LecturaIASchema) },
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES + instruccionConcepto(conceptos) }] }],
    })
    if (r.stop_reason === 'refusal') return { ok: false, motivo: 'RECHAZADO', modelo: r.model }
    if (r.stop_reason === 'max_tokens') return { ok: false, motivo: 'RESPUESTA_CORTADA', modelo: r.model }
    const lectura = r.parsed_output
    if (!lectura) return { ok: false, motivo: 'RESPUESTA_INVALIDA', modelo: r.model }
    return { ok: true, lectura, modelo: r.model }
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { ok: false, motivo: 'LIMITE_DE_USO', modelo }
    if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, motivo: 'TIEMPO_AGOTADO', modelo }
    if (e instanceof Anthropic.APIError) return { ok: false, motivo: `API_${e.status ?? 'ERROR'}`, modelo }
    return { ok: false, motivo: e instanceof Error ? e.message.slice(0, 200) : 'ERROR', modelo }
  }
}
