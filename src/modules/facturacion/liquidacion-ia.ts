/**
 * Lectura de la liquidación del cliente con la API de Anthropic, cuando el
 * texto del PDF no alcanza (escaneo, otro formato) — 20260930k. Mismo patrón
 * que `pagos/lectura/cheque-ia.ts`: structured output con claves en ASCII,
 * refusal fallbacks y NUNCA lanza (sin key, ilegible o con la API caída
 * devuelve `{ ok: false, motivo }` y el endpoint responde 422
 * LIQUIDACION_ILEGIBLE).
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { MODELO_LECTURA_DEFAULT, bloqueDelArchivo } from '../pagos/lectura/ia.js'
import { getEmpresa } from '../../lib/empresa.js'
import type { LiquidacionLeida } from './liquidacion.js'

const Num = z.number().nullable()
const Txt = z.string().nullable()

/** Claves en ASCII: una ñ en el schema rompe la llamada (400). */
export const LecturaLiquidacionIASchema = z.object({
  legible: z.boolean(),
  numero: Txt,
  fecha: Txt,
  emisor_nombre: Txt,
  emisor_cuit: Txt,
  comprobantes: z.array(z.object({
    pto_vta: Num,
    numero: Num,
    fecha: Txt,
    bruto: Num,
    comision: Num,
    subtotal: Num,
  })),
  subtotal: Num,
  deducciones: z.array(z.object({ texto: Txt, codigo: Txt, fecha: Txt, importe: Num })),
  neto: Num,
  cheques: z.array(z.object({
    tipo: Txt,
    numero: Txt,
    banco: Txt,
    fecha_cobro: Txt,
    importe: Num,
    propio: z.boolean().nullable(),
    librador: Txt,
    librador_cuit: Txt,
  })),
  notas: Txt,
})
export type LecturaLiquidacionIA = z.infer<typeof LecturaLiquidacionIASchema>

export type ResultadoLiquidacionIA =
  | { ok: true; lectura: LiquidacionLeida; modelo: string }
  | { ok: false; motivo: string; modelo: string | null }

const INSTRUCCIONES = `Es una LIQUIDACIÓN (cuenta de venta y líquido producto) con la que un cliente le paga a CADINC los comprobantes que vendió por cuenta y orden. Extraé:

- numero: el número de la liquidación ("Liquidación Nro."), sólo dígitos.
- fecha: la fecha de la liquidación (AAAA-MM-DD; el papel es día/mes/año).
- emisor_nombre y emisor_cuit: quien liquida y paga (NO es CADINC). CUIT sólo con los 11 dígitos.
- comprobantes: cada comprobante de CADINC que se cancela (C.LIQ / CVLP, punto de venta y número). bruto = el importe del comprobante; comision = lo que descuenta quien liquida por ese comprobante (CTA.A), negativo; subtotal = bruto + comision.
- subtotal: el "Subtotal" del papel.
- deducciones: todo lo que se descuenta después del subtotal (Recupero Ley 25413, seguro de carga, pagos de playa, faltantes…). texto = lo que dice el renglón; codigo = el código del concepto si figura; importe POSITIVO.
- neto: el "Total Liquidación" o "Saldo Neto".
- cheques: cada renglón del "Detalle de Pagos". tipo tal como figura (CH/PROP = cheque propio de quien liquida); numero; banco; fecha_cobro (vencimiento, AAAA-MM-DD); importe; propio = true si es cheque propio de quien liquida; librador y librador_cuit si figuran.
- Si el PDF trae la misma liquidación dos veces (original y copia), cada cosa va UNA sola vez.
- Importes con punto decimal y sin separador de miles. Si algo no se lee con seguridad, null: es mucho peor un número inventado que un campo vacío.
- legible: false si no es una liquidación o no se puede leer. notas: cualquier cosa rara, en una frase.`

const r2 = (n: number) => Math.round(n * 100) / 100
const iso = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)

/** La lectura de la IA → la misma forma que el lector de texto. null si le falta lo mínimo. Pura. */
export function liquidacionDesdeIA(l: LecturaLiquidacionIA): LiquidacionLeida | null {
  if (!l.legible) return null
  const numero = (l.numero ?? '').replace(/\D/g, '')
  const comprobantes = l.comprobantes
    .filter((c) => c.pto_vta != null && c.numero != null && (c.subtotal != null || c.bruto != null))
    .map((c) => {
      const bruto = c.bruto ?? c.subtotal ?? 0
      const comision = c.comision == null ? 0 : -Math.abs(c.comision)
      return { pto_vta: Number(c.pto_vta), numero: Number(c.numero), fecha: iso(c.fecha), bruto, comision, subtotal: r2(c.subtotal ?? bruto + comision) }
    })
  if (!numero || comprobantes.length === 0 || l.neto == null) return null
  const cuit = (l.emisor_cuit ?? '').replace(/\D/g, '')
  return {
    numero,
    fecha: iso(l.fecha),
    emisor_cuit: cuit.length === 11 ? cuit : null,
    emisor_nombre: l.emisor_nombre,
    comprobantes,
    subtotal: l.subtotal,
    deducciones: l.deducciones
      .filter((d) => d.importe != null && d.importe !== 0)
      .map((d) => ({ texto: (d.texto ?? d.codigo ?? 'Descuento').trim(), codigo: d.codigo, comprobante: null, fecha: iso(d.fecha), importe: r2(Math.abs(d.importe ?? 0)) })),
    neto: l.neto,
    cheques: l.cheques
      .filter((c) => c.numero && c.importe != null)
      .map((c) => {
        const tipo = (c.tipo ?? 'CH').toUpperCase()
        const cuitLib = (c.librador_cuit ?? '').replace(/\D/g, '')
        return {
          tipo, numero: (c.numero ?? '').replace(/\D/g, ''), banco: (c.banco ?? '').trim(), fecha_cobro: iso(c.fecha_cobro),
          importe: r2(Math.abs(c.importe ?? 0)), propio: c.propio ?? tipo === 'CH/PROP',
          librador: c.librador?.trim() || null, librador_cuit: cuitLib.length === 11 ? cuitLib : null,
        }
      }),
    avisos: l.notas ? [`IA: ${l.notas}`] : [],
  }
}

export async function leerLiquidacionConIA(archivo: Buffer, mime: string): Promise<ResultadoLiquidacionIA> {
  const modelo = process.env.LIQUIDACION_LECTURA_MODEL ?? process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT
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
      system: `Leés liquidaciones de clientes para la tesorería de ${emp.razon_social} (CUIT ${emp.cuit_fmt}). Cada dato tiene que salir del documento tal cual.`,
      output_config: { format: betaZodOutputFormat(LecturaLiquidacionIASchema) },
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
    })
    if (r.stop_reason === 'refusal') return { ok: false, motivo: 'RECHAZADO', modelo: r.model }
    if (r.stop_reason === 'max_tokens') return { ok: false, motivo: 'RESPUESTA_CORTADA', modelo: r.model }
    const out = r.parsed_output
    if (!out) return { ok: false, motivo: 'RESPUESTA_INVALIDA', modelo: r.model }
    const lectura = liquidacionDesdeIA(out)
    if (!lectura) return { ok: false, motivo: 'NO_ES_LIQUIDACION', modelo: r.model }
    return { ok: true, lectura, modelo: r.model }
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { ok: false, motivo: 'LIMITE_DE_USO', modelo }
    if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, motivo: 'TIEMPO_AGOTADO', modelo }
    if (e instanceof Anthropic.APIError) return { ok: false, motivo: `API_${e.status ?? 'ERROR'}`, modelo }
    return { ok: false, motivo: e instanceof Error ? e.message.slice(0, 200) : 'ERROR', modelo }
  }
}
