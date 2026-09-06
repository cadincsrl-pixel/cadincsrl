import { supabase } from '../../lib/supabase.js'

export interface AuditEntry {
  user_id: string
  user_nombre: string
  modulo: string
  accion: string
  entidad: string
  entidad_id?: string
  detalle?: string
  ip?: string
}

export interface AuditFiltros {
  user_id?: string
  modulo?: string
  accion?: string
  q?: string
  desde?: string
  hasta?: string
  /** Módulos a dejar afuera (ej. 'horas' para sacar la carga de tarja). */
  excluir?: string[]
  limit?: number
  offset?: number
}

export const LIMITE_MAX = 1000
const LIMITE_DEFAULT = 500

/**
 * audit_log se escribe y se lee SOLO con el cliente admin (service_role): la
 * migración 20260906m le sacó a `authenticated` todo acceso a la tabla, y un
 * trigger la hace de solo agregar (ni UPDATE ni DELETE, ni con service_role).
 * El chequeo de "solo admin lee" está en la ruta (admin.routes.ts).
 */
export const auditService = {
  async log(entry: AuditEntry, _token?: string) {
    try {
      const { error } = await supabase.from('audit_log').insert(entry)
      if (error) console.error('[audit] Error al guardar log:', error.message, entry)
    } catch (err) {
      // No fallar nunca por el log.
      console.error('[audit] Error al guardar log:', err, entry)
    }
  },

  async getAll(filters: AuditFiltros = {}): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const limit = Math.min(Math.max(filters.limit ?? LIMITE_DEFAULT, 1), LIMITE_MAX)
    const offset = Math.max(filters.offset ?? 0, 0)

    let q = supabase
      .from('audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    if (filters.user_id) q = q.eq('user_id', filters.user_id)
    if (filters.modulo) q = q.eq('modulo', filters.modulo)
    if (filters.accion) q = q.eq('accion', filters.accion)
    for (const m of filters.excluir ?? []) q = q.neq('modulo', m)
    // Búsqueda de texto SERVER-SIDE sobre toda la tabla: matchea detalle,
    // entidad, entidad_id y el nombre del usuario. La coma y los paréntesis
    // se quitan (separadores del .or de PostgREST); `%` y `_` se ESCAPAN
    // (no se quitan: "contrat_id" tiene que matchear literal).
    if (filters.q) {
      const safe = filters.q
        .replace(/[,()\\]/g, ' ')
        .replace(/([%_])/g, '\\$1')
        .trim()
      if (safe) {
        q = q.or(`detalle.ilike.%${safe}%,entidad.ilike.%${safe}%,entidad_id.ilike.%${safe}%,user_nombre.ilike.%${safe}%`)
      }
    }
    if (filters.desde) q = q.gte('created_at', filters.desde)
    if (filters.hasta) q = q.lte('created_at', filters.hasta)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { items: (data ?? []) as Record<string, unknown>[], total: count ?? 0 }
  },
}
