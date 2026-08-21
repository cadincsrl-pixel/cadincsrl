import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateCamionDto, UpdateCamionDto } from './camiones.schema.js'

export const camionesService = {
  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('camiones')
      .select('*')
      .order('patente')
    if (error) throw new Error(error.message)

    // RTO vigente por camión (el vence_el más nuevo de tipo 'rto') para la
    // columna de vencimientos del listado — espejo de bateas.service. Best
    // effort: si falla, el listado sale igual sin la fecha.
    const { data: rtos } = await supabase
      .from('camion_documentos')
      .select('camion_id, vence_el')
      .eq('tipo', 'rto')
      .not('vence_el', 'is', null)
    const rtoPorCamion = new Map<number, string>()
    for (const r of rtos ?? []) {
      const prev = rtoPorCamion.get(r.camion_id)
      if (!prev || r.vence_el > prev) rtoPorCamion.set(r.camion_id, r.vence_el)
    }
    return (data ?? []).map(c => ({ ...c, rto_vence_el: rtoPorCamion.get(c.id) ?? null }))
  },

  async create(dto: CreateCamionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('camiones')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateCamionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('camiones')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('camiones').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
