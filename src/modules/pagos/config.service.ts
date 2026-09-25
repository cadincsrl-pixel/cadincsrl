/**
 * Configuración de Compras (tanda 6; base 20260929f, `pagos_config`).
 *
 * Por ahora una sola clave: `tributo_jurisdiccion_default_id`, la
 * jurisdicción que propone el alta de un tributo (IIBB de Tucumán). El ítem 8
 * (avisos de pago, plazos de cheque) suma claves a la tabla, a la RPC y a
 * esta respuesta, sin cambiar lo que ya está.
 *
 * Escritura: SOLO `pagos_guardar_config` (vuelve a chequear el flag
 * `pagos.configurar`). Cache de 60 s, invalidada en cada escritura.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from '../../lib/supabase.js'
import { mapRpcError } from './pagos.errors.js'

export const PagosConfigPatchSchema = z.object({
  tributo_jurisdiccion_default_id: z.number().int().positive().nullable().optional(),
}).strict().refine((o) => Object.keys(o).length > 0, { message: 'SIN_CAMBIOS' })
export type PagosConfigPatch = z.infer<typeof PagosConfigPatchSchema>

export interface PagosConfig {
  tributos: { jurisdiccion_default_id: number | null }
}

/** Pura: la fila de `pagos_config_json()` → la respuesta de la API. */
export function configDesdeJson(raw: unknown): PagosConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = Number(r.tributo_jurisdiccion_default_id)
  return { tributos: { jurisdiccion_default_id: Number.isInteger(id) && id > 0 ? id : null } }
}

const TTL_MS = 60_000
let cache: { at: number; valor: PagosConfig } | null = null

export const pagosConfigService = {
  async obtener(db: SupabaseClient = supabase): Promise<PagosConfig> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.valor
    const { data, error } = await db.rpc('pagos_config_json')
    if (error) throw mapRpcError(error)
    const valor = configDesdeJson(data)
    cache = { at: Date.now(), valor }
    return valor
  },

  async guardar(cambios: PagosConfigPatch, userId: string, db: SupabaseClient = supabase): Promise<PagosConfig> {
    const { data, error } = await db.rpc('pagos_guardar_config', { p_cambios: cambios, p_user_id: userId })
    if (error) throw mapRpcError(error)
    const valor = configDesdeJson(data)
    cache = { at: Date.now(), valor }
    return valor
  },

  olvidarCache(): void {
    cache = null
  },
}
