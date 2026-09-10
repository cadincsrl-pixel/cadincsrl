import { supabase } from '../../lib/supabase.js'

export interface PreciosFiltros {
  user_id?: string
  /** 'renglon' (lo que se le cobra al cliente) | 'catalogo' (precio de referencia) */
  tipo?: string
  obra_cod?: string
  fuente?: string
  q?: string
  desde?: string
  hasta?: string
  limit?: number
  offset?: number
}

export const LIMITE_MAX = 1000
const LIMITE_DEFAULT = 200

/**
 * Movimientos de precio, de los dos orígenes, desde `v_movimientos_precio`
 * (migración 20260913c). Es la pantalla de control del dueño: quién cambió
 * qué precio, cuándo, de cuánto a cuánto y en qué obra.
 *
 * Se lee con el cliente admin y la ruta ya exige rol admin, igual que la
 * auditoría: no hay filtro de obra_scope acá a propósito — el que mira es el
 * que controla a todos.
 */
export const preciosService = {
  async getAll(filters: PreciosFiltros = {}): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const limit  = Math.min(Math.max(filters.limit ?? LIMITE_DEFAULT, 1), LIMITE_MAX)
    const offset = Math.max(filters.offset ?? 0, 0)

    let q = supabase
      .from('v_movimientos_precio')
      .select('*', { count: 'exact' })
      .order('fecha', { ascending: false })
      .range(offset, offset + limit - 1)

    if (filters.user_id) q = q.eq('user_id', filters.user_id)
    if (filters.tipo)    q = q.eq('tipo', filters.tipo)
    if (filters.obra_cod) q = q.eq('obra_cod', filters.obra_cod)
    if (filters.fuente)  q = q.eq('fuente', filters.fuente)
    if (filters.desde)   q = q.gte('fecha', filters.desde)
    if (filters.hasta)   q = q.lte('fecha', filters.hasta)
    // Texto libre sobre lo que se ve: descripción del renglón y nombre de ficha.
    if (filters.q) {
      const s = filters.q.replace(/[%,()]/g, ' ').trim()
      if (s) q = q.or(`descripcion.ilike.%${s}%,ficha.ilike.%${s}%,obra_cod.ilike.%${s}%`)
    }

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { items: data ?? [], total: count ?? 0 }
  },
}
