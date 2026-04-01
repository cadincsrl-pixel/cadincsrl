import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateLugarDto, UpdateLugarDto, CreateRutaDto } from './lugares.schema.js'

export const lugaresService = {
  async getCanteras(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('canteras').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getDepositos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('depositos').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getRutas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .select('*, canteras(nombre), depositos(nombre)')
      .order('id')
    if (error) throw new Error(error.message)
    return data
  },

  async createCantera(dto: CreateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('canteras')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createDeposito(dto: CreateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('depositos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createRuta(dto: CreateRutaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCantera(id: number, dto: UpdateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('canteras')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateDeposito(id: number, dto: UpdateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('depositos')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteRuta(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('rutas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
