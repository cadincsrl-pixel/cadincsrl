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
    return data
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
