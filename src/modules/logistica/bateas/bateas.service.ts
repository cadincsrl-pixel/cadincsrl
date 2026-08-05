import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateBateaDto, UpdateBateaDto } from './bateas.schema.js'

export const bateasService = {
  async getAll(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb.from('bateas').select('*').order('patente')
    if (error) throw new Error(error.message)

    // RTO vigente por batea (el vence_el más nuevo de tipo 'rto') para la
    // columna de vencimientos del listado. Best-effort: si falla, el listado
    // sale igual sin la fecha.
    const { data: rtos } = await sb
      .from('batea_documentos')
      .select('batea_id, vence_el')
      .eq('tipo', 'rto')
      .not('vence_el', 'is', null)
    const rtoPorBatea = new Map<number, string>()
    for (const r of rtos ?? []) {
      const prev = rtoPorBatea.get(r.batea_id)
      if (!prev || r.vence_el > prev) rtoPorBatea.set(r.batea_id, r.vence_el)
    }
    return (data ?? []).map(b => ({ ...b, rto_vence_el: rtoPorBatea.get(b.id) ?? null }))
  },

  async create(dto: CreateBateaDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('bateas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateBateaDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('bateas')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { error } = await sb.from('bateas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
