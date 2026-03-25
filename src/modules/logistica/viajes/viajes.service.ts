import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateViajeDto, CargaDto, DescargaDto } from './viajes.schema.js'

export const viajesService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('viajes')
      .select(`
        *,
        cargas(*),
        descargas(*)
      `)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateViajeDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('viajes')
      .insert({ ...dto, estado: 'en_curso' })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async registrarCarga(dto: CargaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cargas')
      .insert(dto)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async registrarDescarga(dto: DescargaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('descargas')
      .insert(dto)
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Marcar viaje como completado
    await supabase
      .from('viajes')
      .update({ estado: 'completado' })
      .eq('id', dto.viaje_id)

    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    await supabase.from('cargas').delete().eq('viaje_id', id)
    await supabase.from('descargas').delete().eq('viaje_id', id)
    const { error } = await supabase.from('viajes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}