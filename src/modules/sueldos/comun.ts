/**
 * Helpers compartidos por los services de Sueldos.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { mapRpcError, SueldosHttpError, type PgError } from './sueldos.errors.js'

/**
 * Cliente del request: el per-request (header x-cadinc-user para los
 * triggers de auditoría) si hay token; si no, el admin. Los dos son
 * service_role, que es el único que ejecuta las RPC `sueldos_*`.
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

/** Resultado de un select: error → 500 DB_ERROR (o el código si es de la base). */
export function filas<T>(r: { data: T[] | null; error: PgError | null }): T[] {
  if (r.error) throw mapRpcError(r.error)
  return r.data ?? []
}

export function unaFila<T>(r: { data: T | null; error: PgError | null }, noExiste: string, detail?: Record<string, unknown>): T {
  if (r.error) throw mapRpcError(r.error)
  if (!r.data) throw new SueldosHttpError(404, noExiste, detail)
  return r.data
}

/** Hoy en Argentina (UTC−3), YYYY-MM-DD. */
export function hoyAR(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
}

/** CUIL, CBU y DNI son PII del módulo: sin `ver_pii` se ven como `***1234`. */
export function enmascarar(v: unknown, verPii: boolean): string | null {
  if (v == null || v === '') return null
  const s = String(v)
  if (verPii) return s
  return '***' + s.slice(-4)
}

const CLAVES_PII = ['cuil', 'cbu', 'dni'] as const

/** Enmascara cuil/cbu/dni de una fila (y del `snapshot.legajo` de un recibo). */
export function enmascararFila<T extends Record<string, unknown>>(row: T, verPii: boolean): T {
  if (verPii || !row || typeof row !== 'object') return row
  const out: Record<string, unknown> = { ...row }
  for (const k of CLAVES_PII) if (k in out) out[k] = enmascarar(out[k], false)
  const snap = out.snapshot
  if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
    const s = { ...(snap as Record<string, unknown>) }
    if (s.legajo && typeof s.legajo === 'object') s.legajo = enmascararFila(s.legajo as Record<string, unknown>, false)
    out.snapshot = s
  }
  return out as T
}

/** Número de un numeric de PostgREST (puede venir como string). */
export function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** Texto de búsqueda seguro para un filtro `or=(…ilike…)` de PostgREST. */
export function textoBusqueda(q: string): string {
  return q.replace(/[,()*%\\]/g, ' ').trim()
}
