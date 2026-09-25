/**
 * Lectura con IA de un comprobante de COBRO (2026-09-25): lo que un cliente
 * manda cuando paga. Puede ser la foto de un cheque, el comprobante de un
 * e-cheq, el de una transferencia o un depósito, o su ORDEN DE PAGO (qué
 * facturas paga, con qué medios y qué retiene). Un archivo = un documento;
 * trae todos los medios, retenciones y comprobantes que figuren.
 *
 * Mismo patrón que `liquidacion-ia.ts`: structured output con claves en ASCII,
 * y NUNCA lanza (sin key, ilegible o con la API caída devuelve
 * `{ ok: false, motivo }`).
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { MODELO_LECTURA_DEFAULT, bloqueDelArchivo } from '../pagos/lectura/ia.js'
import { getEmpresa } from '../../lib/empresa.js'

const Num = z.number().nullable()
const Txt = z.string().nullable()

/** Claves en ASCII: una ñ en el schema rompe la llamada (400). */
export const LecturaComprobanteCobroIASchema = z.object({
  legible: z.boolean(),
  tipo_documento: Txt,
  fecha: Txt,
  pagador_nombre: Txt,
  pagador_cuit: Txt,
  medios: z.array(z.object({
    forma: Txt,
    importe: Num,
    numero: Txt,
    banco: Txt,
    fecha_cobro: Txt,
    librador: Txt,
    librador_cuit: Txt,
    cuenta_destino: Txt,
  })),
  retenciones: z.array(z.object({
    tipo: Txt,
    jurisdiccion: Txt,
    certificado_numero: Txt,
    fecha: Txt,
    importe: Num,
  })),
  comprobantes: z.array(z.object({
    tipo: Txt,
    pto_vta: Num,
    numero: Num,
    importe: Num,
  })),
  total: Num,
  notas: Txt,
})
export type LecturaComprobanteCobroIA = z.infer<typeof LecturaComprobanteCobroIASchema>

export type ResultadoComprobanteCobroIA =
  | { ok: true; lectura: LecturaComprobanteCobroIA; modelo: string }
  | { ok: false; motivo: string; modelo: string | null }

const INSTRUCCIONES = `Es un comprobante con el que un CLIENTE le paga a CADINC. Puede ser:
- la foto de un cheque de papel o el comprobante de un e-cheq (tipo_documento "cheque" o "echeq");
- el comprobante de una transferencia o de un depósito bancario ("transferencia" / "deposito");
- la ORDEN DE PAGO o el aviso de pago del cliente, que detalla qué facturas de CADINC paga, con qué medios y qué le retiene ("orden_pago");
- otra cosa ("otro").

Extraé:
- tipo_documento: uno de los de arriba.
- fecha: la del pago o del documento (AAAA-MM-DD; el papel argentino es día/mes/año).
- pagador_nombre y pagador_cuit: el CLIENTE que paga (nunca CADINC). En un cheque es el librador, salvo que esté endosado a CADINC por otro: ahí el pagador es quien lo endosó. En una transferencia, el ordenante/titular de la cuenta de origen. CUIT sólo con los 11 dígitos.
- medios: cada forma en que se paga, una vez cada una. forma = "cheque", "echeq", "transferencia", "deposito" o "efectivo". importe; numero (del cheque, o de operación/comprobante de la transferencia); banco (el del cheque, o el de origen de la transferencia); fecha_cobro (la fecha de pago del cheque, o la de la transferencia); librador y librador_cuit (sólo cheques: el TITULAR de la cuenta, la razón social impresa en el cheque, no la persona que firma); cuenta_destino (sólo transferencias o depósitos: el CBU, alias o banco de la cuenta de CADINC donde entró, tal como figura).
- retenciones: lo que el cliente retiene (Ingresos Brutos, Ganancias, SUSS, IVA, TEM o tasa municipal, otra). tipo = "iibb", "ganancias", "suss", "iva", "tem" u "otra"; jurisdiccion (provincia o municipio, si figura); certificado_numero; fecha; importe POSITIVO.
- comprobantes: las facturas o notas de débito de CADINC que se pagan, si el documento las detalla. tipo tal como figura (FA, FC, ND, FCE…); pto_vta y numero como números (de "0004-00000123" sale pto_vta 4 y numero 123); importe que se paga de cada uno.
- total: el total que figura en el documento (en una orden de pago puede ser el neto pagado o el bruto de las facturas: ponelo tal cual).
- Importes con punto decimal y sin separador de miles. Si algo no se lee con seguridad, null: es mucho peor un número inventado que un campo vacío. Si el documento aparece dos veces (original y copia), cada cosa va UNA sola vez.
- legible: false si no es un comprobante de pago o no se puede leer. notas: cualquier cosa rara, en una o dos frases.`

export async function leerComprobanteCobroConIA(archivo: Buffer, mime: string): Promise<ResultadoComprobanteCobroIA> {
  const modelo = process.env.COBROS_LECTURA_MODEL ?? process.env.CARTERA_LECTURA_MODEL ?? process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, motivo: 'SIN_API_KEY', modelo: null }
  const bloque = bloqueDelArchivo(archivo.toString('base64'), mime)
  if (!bloque) return { ok: false, motivo: 'FORMATO_NO_SOPORTADO', modelo }
  try {
    const emp = await getEmpresa()
    const client = new Anthropic({ timeout: 120_000, maxRetries: 1 })
    const r = await client.beta.messages.parse({
      model: modelo,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: `Leés comprobantes de pago que los clientes le mandan a la tesorería de ${emp.razon_social} (CUIT ${emp.cuit_fmt}), que es quien COBRA. Cada dato tiene que salir del documento tal cual.`,
      output_config: { format: betaZodOutputFormat(LecturaComprobanteCobroIASchema) },
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
    })
    if (r.stop_reason === 'refusal') return { ok: false, motivo: 'RECHAZADO', modelo: r.model }
    if (r.stop_reason === 'max_tokens') return { ok: false, motivo: 'RESPUESTA_CORTADA', modelo: r.model }
    const out = r.parsed_output
    if (!out) return { ok: false, motivo: 'RESPUESTA_INVALIDA', modelo: r.model }
    return { ok: true, lectura: out, modelo: r.model }
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { ok: false, motivo: 'LIMITE_DE_USO', modelo }
    if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, motivo: 'TIEMPO_AGOTADO', modelo }
    if (e instanceof Anthropic.APIError) return { ok: false, motivo: `API_${e.status ?? 'ERROR'}`, modelo }
    return { ok: false, motivo: e instanceof Error ? e.message.slice(0, 200) : 'ERROR', modelo }
  }
}
