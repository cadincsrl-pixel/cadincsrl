import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateChoferDto, UpdateChoferDto } from './choferes.schema.js'

export const choferesService = {
  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('choferes')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateChoferDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('choferes')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateChoferDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('choferes')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('choferes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
