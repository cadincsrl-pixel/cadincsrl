import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateBateaDto, UpdateBateaDto } from './bateas.schema.js'

export const bateasService = {
  async getAll(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb.from('bateas').select('*').order('patente')
    if (error) throw new Error(error.message)
    return data
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
