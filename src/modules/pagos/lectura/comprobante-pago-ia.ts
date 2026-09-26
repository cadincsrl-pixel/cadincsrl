/**
 * Lectura con IA de un comprobante de PAGO a un proveedor (2026-09-25): lo
 * que documenta que CADINC le pagó. Puede ser el comprobante de una
 * transferencia, el de un e-cheq emitido o endosado, la foto de un cheque,
 * el RECIBO que manda el proveedor (qué facturas cancela y con qué valores) o
 * su resumen de cuenta. Un archivo = un documento.
 *
 * Mismo patrón que `cheque-ia.ts`: structured output con claves en ASCII y
 * NUNCA lanza (sin key, ilegible o con la API caída devuelve
 * `{ ok: false, motivo }`).
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { MODELO_LECTURA_DEFAULT, bloqueDelArchivo } from './ia.js'
import { getEmpresa } from '../../../lib/empresa.js'

const Num = z.number().nullable()
const Txt = z.string().nullable()

/** Claves en ASCII: una ñ en el schema rompe la llamada (400). */
export const LecturaComprobantePagoIASchema = z.object({
  legible: z.boolean(),
  tipo_documento: Txt,
  fecha: Txt,
  proveedor_nombre: Txt,
  proveedor_cuit: Txt,
  medios: z.array(z.object({
    forma: Txt,
    importe: Num,
    numero: Txt,
    banco: Txt,
    fecha_cobro: Txt,
    librador: Txt,
    librador_cuit: Txt,
    es_endoso: z.boolean().nullable(),
    cuenta_origen: Txt,
    entregado_a: Txt,
    entregado_a_cuit: Txt,
  })),
  comprobantes: z.array(z.object({
    tipo: Txt,
    pto_vta: Num,
    numero: Num,
    importe: Num,
  })),
  recibo_numero: Txt,
  total: Num,
  notas: Txt,
})
export type LecturaComprobantePagoIA = z.infer<typeof LecturaComprobantePagoIASchema>

export type ResultadoComprobantePagoIA =
  | { ok: true; lectura: LecturaComprobantePagoIA; modelo: string }
  | { ok: false; motivo: string; modelo: string | null }

const INSTRUCCIONES = `Es un comprobante de que CADINC le PAGÓ a un proveedor. Puede ser:
- el comprobante de una transferencia bancaria ("transferencia");
- el comprobante de un e-cheq emitido o endosado por CADINC, o la foto de un cheque ("echeq" / "cheque");
- el RECIBO que el proveedor le da a CADINC: dice qué facturas cancela y con qué valores ("recibo");
- el resumen de cuenta corriente del proveedor ("resumen_cuenta");
- otra cosa ("otro").

Extraé:
- tipo_documento: uno de los de arriba.
- fecha: la del pago o del documento (AAAA-MM-DD; el papel argentino es día/mes/año).
- proveedor_nombre y proveedor_cuit: el PROVEEDOR que cobra (el beneficiario, el endosatario o quien emite el recibo). Nunca CADINC. CUIT sólo con los 11 dígitos.
- medios: cada forma de pago, una vez cada una. forma = "transferencia", "echeq", "cheque" o "efectivo". importe; numero (del cheque, o de operación/comprobante de la transferencia); banco (el del cheque, o el de la cuenta de CADINC de donde salió la transferencia); fecha_cobro (fecha de pago del cheque, o la de la transferencia); librador y librador_cuit (sólo cheques: el TITULAR de la cuenta, la razón social impresa, no quien firma); es_endoso = true si es un cheque de un tercero que CADINC endosó; cuenta_origen (sólo transferencias: el banco, CBU o número de la cuenta de CADINC de donde salió, tal como figura); entregado_a y entregado_a_cuit: a quién se le entregó ESE medio (beneficiario o endosatario). Un PDF del banco puede traer cheques endosados a proveedores DISTINTOS: cada uno con el suyo. En un resumen de cuenta, los pagos que figuran como recibos también van acá, con forma null si no dice cuál.
- comprobantes: las facturas o notas de débito del PROVEEDOR que se pagan o que figuran (en un resumen, las que siguen abiertas). tipo tal como figura; pto_vta y numero como números (de "0012-00007486" sale pto_vta 12 y numero 7486); importe (lo que se paga de cada una, o su saldo en un resumen).
- recibo_numero: el número del recibo del proveedor, si es un recibo.
- total: el total del pago si figura.
- Importes con punto decimal y sin separador de miles. Si algo no se lee con seguridad, null: es mucho peor un número inventado que un campo vacío. Si el documento aparece dos veces (original y copia), cada cosa va UNA sola vez.
- legible: false si no documenta un pago o no se puede leer. notas: cualquier cosa rara, en una o dos frases.`

export async function leerComprobantePagoConIA(archivo: Buffer, mime: string): Promise<ResultadoComprobantePagoIA> {
  const modelo = process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT
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
      system: `Leés comprobantes de pagos que ${emp.razon_social} (CUIT ${emp.cuit_fmt}) le hizo a sus proveedores, para su tesorería. CADINC es quien PAGA. Cada dato tiene que salir del documento tal cual.`,
      output_config: { format: betaZodOutputFormat(LecturaComprobantePagoIASchema) },
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
