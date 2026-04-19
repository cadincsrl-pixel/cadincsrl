import { createSupabaseClient } from '../../lib/supabase.js'

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

export const auditService = {
  async log(entry: AuditEntry, token: string) {
    try {
      const supabase = createSupabaseClient(token)
      await supabase.from('audit_log').insert(entry)
    } catch {
      // No fallar si el log falla
      console.error('[audit] Error al guardar log:', entry)
    }
  },

  async getAll(token: string, filters?: { user_id?: string; modulo?: string; desde?: string; hasta?: string; limit?: number }) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(filters?.limit ?? 500)

    if (filters?.user_id) q = q.eq('user_id', filters.user_id)
    if (filters?.modulo) q = q.eq('modulo', filters.modulo)
    if (filters?.desde) q = q.gte('created_at', filters.desde)
    if (filters?.hasta) q = q.lte('created_at', filters.hasta)

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },
}
