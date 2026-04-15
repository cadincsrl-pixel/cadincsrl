import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateTramoDto, UpdateTramoDto, RegistrarDescargaDto } from './tramos.schema.js'

export const tramosService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tramos')
      .select('*')
      .order('fecha_carga', { ascending: true, nullsFirst: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateTramoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // Los tramos vacíos quedan completados de inmediato
    const estado = dto.tipo === 'vacio' ? 'completado' : 'en_curso'
    const { data, error } = await supabase
      .from('tramos')
      .insert({ ...dto, estado, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateTramoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tramos')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async registrarDescarga(id: number, dto: RegistrarDescargaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tramos')
      .update({ ...dto, estado: 'completado', updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    await supabase.from('liquidacion_tramos').delete().eq('tramo_id', id)
    const { error } = await supabase.from('tramos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
