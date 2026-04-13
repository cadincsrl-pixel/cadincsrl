import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateLiquidacionDto, CreateAdelantoDto } from './liquidaciones.schema.js'

export const liquidacionesService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('liquidaciones')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async getAdelantos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('adelantos')
      .select('*')
      .order('fecha', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateLiquidacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { tramo_ids, adelanto_ids, ...rest } = dto

    const { data, error } = await supabase
      .from('liquidaciones')
      .insert({ ...rest, estado: 'borrador', created_by: userId, updated_by: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Vincular tramos
    if (tramo_ids.length) {
      await supabase
        .from('liquidacion_tramos')
        .insert(tramo_ids.map(tid => ({ liquidacion_id: data.id, tramo_id: tid })))
    }

    // Vincular adelantos — marcarlos como liquidados
    if (adelanto_ids.length) {
      await supabase
        .from('adelantos')
        .update({ liquidacion_id: data.id, updated_by: userId })
        .in('id', adelanto_ids)
    }

    return data
  },

  async cerrar(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('liquidaciones')
      .update({ estado: 'cerrada', updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    await supabase.from('liquidacion_tramos').delete().eq('liquidacion_id', id)
    const { error } = await supabase.from('liquidaciones').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  async createAdelanto(dto: CreateAdelantoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('adelantos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteAdelanto(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('adelantos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
