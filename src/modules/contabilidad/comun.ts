/**
 * Helpers compartidos por los services de Contabilidad.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { mapRpcError, type PgError } from './contabilidad.errors.js'

/**
 * Cliente de Supabase para el request: el per-request (header x-cadinc-user,
 * que usan los triggers de auditoría) si hay token; si no, el admin. Los dos
 * son service_role: las RPC `cont_*` solo las ejecuta service_role.
 */
export function dbDe(accessToken?: string | null): SupabaseClient {
  return accessToken ? createSupabaseClient(accessToken) : supabase
}

/** Llama una RPC y mapea sus errores. */
export async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>, opts: { unicoComo?: string } = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw mapRpcError(error as PgError, opts)
  return data as T
}

/** Importe a centavos (numeric(14,2)): evita 0.1 + 0.2 y los .005 de redondeo. */
export function aCentavos(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

/** Página de un listado: lo que devuelve la RPC más limit/offset/hasMore. */
export function pagina<T>(items: T[], total: number, limit: number, offset: number) {
  return { items, total, limit, offset, hasMore: offset + items.length < total }
}
