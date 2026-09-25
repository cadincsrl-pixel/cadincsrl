/**
 * Helpers compartidos por los services de Facturación.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { ARCA_PTO_VTA_DEFAULT, type ArcaAmbiente } from '../../lib/arca/index.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import type { FJ } from './reglas.js'

/**
 * Cliente de Supabase para el request: el per-request (header x-cadinc-user,
 * que usan los triggers de auditoría) si hay token; si no (cron), el admin.
 * Los dos son service_role: las RPC `ventas_*` solo las ejecuta service_role.
 */
export function dbDe(accessToken?: string | null): SupabaseClient {
  return accessToken ? createSupabaseClient(accessToken) : supabase
}

/**
 * Ambiente y punto de venta del PROCESO (ARCA_AMBIENTE / ARCA_PTO_VTA). Para
 * guardar un borrador alcanza con el ambiente: el certificado recién hace
 * falta al emitir. Sin ambiente válido → 503 ARCA_NO_CONFIGURADO.
 */
export function ambienteProceso(env: Record<string, string | undefined> = process.env): ArcaAmbiente | null {
  const a = (env.ARCA_AMBIENTE ?? '').trim()
  return a === 'homo' || a === 'prod' ? a : null
}

export function talonarioProceso(env: Record<string, string | undefined> = process.env): { ambiente: ArcaAmbiente; ptoVta: number } {
  const ambiente = ambienteProceso(env)
  if (!ambiente) throw new FacturacionHttpError(503, 'ARCA_NO_CONFIGURADO', { falta: ['ARCA_AMBIENTE'] })
  const pv = (env.ARCA_PTO_VTA ?? '').trim()
  const ptoVta = pv && /^\d{1,5}$/.test(pv) ? Number(pv) : ARCA_PTO_VTA_DEFAULT
  return { ambiente, ptoVta }
}

/**
 * Talonario de un borrador (tanda 6, 20260929d). Orden:
 *   1. el PV pedido (body), si está ACTIVO en `ventas_puntos_venta` para el
 *      ambiente del proceso; si la tabla tiene filas y no lo está →
 *      409 PTO_VTA_NO_HABILITADO;
 *   2. el `anterior` (el PV que ya tenía el borrador), si sigue activo;
 *   3. el PV por defecto de la tabla;
 *   4. ARCA_PTO_VTA (tabla vacía para el ambiente: la base de antes).
 */
export async function talonario(
  db: SupabaseClient,
  pvPedido?: number | null,
  anterior?: number | null,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ambiente: ArcaAmbiente; ptoVta: number }> {
  const proc = talonarioProceso(env)
  const { data, error } = await db.from('ventas_puntos_venta')
    .select('numero, activo, por_defecto').eq('ambiente', proc.ambiente)
  if (error) throw mapRpcError(error as PgError)
  const filas = (data ?? []) as Array<{ numero: number; activo: boolean; por_defecto: boolean }>
  if (!filas.length) {
    if (pvPedido != null && pvPedido !== proc.ptoVta) {
      throw new FacturacionHttpError(409, 'PTO_VTA_NO_HABILITADO', { campo: 'pto_vta', pto_vta: pvPedido, ambiente: proc.ambiente })
    }
    return proc
  }
  const activos = filas.filter((f) => f.activo).map((f) => Number(f.numero))
  if (pvPedido != null) {
    if (!activos.includes(pvPedido)) {
      throw new FacturacionHttpError(409, 'PTO_VTA_NO_HABILITADO', { campo: 'pto_vta', pto_vta: pvPedido, ambiente: proc.ambiente })
    }
    return { ambiente: proc.ambiente, ptoVta: pvPedido }
  }
  if (anterior != null && activos.includes(Number(anterior))) return { ambiente: proc.ambiente, ptoVta: Number(anterior) }
  const def = filas.find((f) => f.por_defecto && f.activo)
  return { ambiente: proc.ambiente, ptoVta: def ? Number(def.numero) : proc.ptoVta }
}

/** Llama una RPC y mapea sus errores. */
export async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw mapRpcError(error as PgError)
  return data as T
}

/** El FJ actual de una factura (o 404). */
export async function leerFJ(db: SupabaseClient, id: number): Promise<FJ> {
  const fj = await rpc<FJ | null>(db, '_ventas_factura_json', { p_id: id })
  if (!fj || !fj.factura) throw new FacturacionHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: id })
  return fj
}
