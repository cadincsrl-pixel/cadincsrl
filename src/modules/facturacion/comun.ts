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
