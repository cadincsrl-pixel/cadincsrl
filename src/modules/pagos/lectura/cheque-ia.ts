/**
 * Lectura de la foto de un cheque físico (o de la captura de un e-cheq) con
 * la API de Anthropic (20260925p). Mismo patrón que `ia.ts`: structured
 * output con claves en ASCII, el mismo modelo (PAGOS_LECTURA_MODEL o
 * claude-opus-5) y refusal fallbacks.
 *
 * NUNCA lanza: sin key, con la foto ilegible o con la API caída devuelve
 * `{ ok: false, motivo }` y quien la llama decide (el endpoint responde 422
 * CHEQUE_ILEGIBLE y la persona tipea los datos).
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { MODELO_LECTURA_DEFAULT, bloqueDelArchivo } from './ia.js'
import { getEmpresa, type Empresa } from '../../../lib/empresa.js'

const Num = z.number().nullable()
const Txt = z.string().nullable()

export const LecturaChequeIASchema = z.object({
  legible: z.boolean(),
  numero: Txt,
  banco: Txt,
  sucursal: Txt,
  fecha_emision: Txt,
  fecha_pago: Txt,
  importe: Num,
  importe_en_letras: Txt,
  importe_letras_coincide: z.boolean().nullable(),
  librador: Txt,
  librador_cuit: Txt,
  es_echeq: z.boolean().nullable(),
  es_diferido: z.boolean().nullable(),
  a_la_orden_de: Txt,
  notas: Txt,
})
export type LecturaChequeIA = z.infer<typeof LecturaChequeIASchema>

export type ResultadoChequeIA =
  | { ok: true; lectura: LecturaChequeIA; modelo: string }
  | { ok: false; motivo: string; modelo: string | null }

/** El prompt de sistema se arma en cada llamada con los datos de la empresa (tanda 6). */
export function sistema(emp: Pick<Empresa, 'razon_social' | 'cuit_fmt'>): string {
  return `Leés cheques argentinos (papel o captura de un e-cheq) para la tesorería de ${emp.razon_social} (CUIT ${emp.cuit_fmt}), que los ENTREGA para pagarle a un proveedor: pueden ser cheques propios de CADINC o de terceros que CADINC endosa. Cada dato tiene que salir de la imagen tal cual: si algo no se ve con seguridad, devolvé null. Es mucho peor un número inventado que un campo vacío.`
}

const INSTRUCCIONES = `Extraé los datos del cheque de la imagen.

- numero: el número del cheque (serie impresa, normalmente 8 dígitos, arriba a la derecha o en la banda magnética). Sólo el número, sin la letra de serie ni el código del banco.
- banco: el nombre del banco emisor tal como figura ("Banco de Galicia", "Banco Macro", "Banco Nación"…). sucursal: si se lee.
- fecha_emision: la fecha en que se libró (AAAA-MM-DD; el papel argentino es día/mes/año).
- fecha_pago: la fecha a partir de la cual se puede cobrar (en un cheque de pago diferido es la "Fecha de pago"; en un cheque común, la misma de emisión). AAAA-MM-DD.
- importe: el importe en números, con punto decimal y sin separador de miles (1250000.50).
- importe_en_letras: la cantidad escrita en letras, tal como figura. importe_letras_coincide: true si el importe en letras dice lo mismo que el importe en números, false si no, null si no se puede leer.
- librador: quién firma o emite el cheque (titular de la cuenta, razón social o nombre). librador_cuit: su CUIT/CUIL, sólo los 11 dígitos, si está impreso.
- es_echeq: true si es un e-cheq (captura de home banking, comprobante electrónico) y no un cheque de papel.
- es_diferido: true si es un cheque de pago diferido (dice "Cheque de pago diferido" o tiene una fecha de pago posterior a la de emisión).
- a_la_orden_de: a quién está hecho, si figura.
- notas: en una o dos frases, cualquier cosa rara (tachaduras, enmiendas, no es un cheque, falta la firma, "no a la orden"). null si no hay nada que decir.
- legible: false si la imagen no es un cheque o no se puede leer con confianza.`

/** Lee la foto del cheque. `archivo` son los bytes tal como están en el bucket. */
export async function leerChequeConIA(archivo: Buffer, mime: string): Promise<ResultadoChequeIA> {
  const modelo = process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, motivo: 'SIN_API_KEY', modelo: null }
  const bloque = bloqueDelArchivo(archivo.toString('base64'), mime)
  if (!bloque) return { ok: false, motivo: 'FORMATO_NO_SOPORTADO', modelo }

  try {
    const client = new Anthropic({ timeout: 120_000, maxRetries: 1 })
    const r = await client.beta.messages.parse({
      model: modelo,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: sistema(await getEmpresa()),
      output_config: { format: betaZodOutputFormat(LecturaChequeIASchema) },
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
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
