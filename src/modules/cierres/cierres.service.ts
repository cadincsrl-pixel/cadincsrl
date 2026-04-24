import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateCierreDto, UpdateCierreDto } from './cierres.schema.js'

export const cierresService = {

  async getByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cierres')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('sem_key', { ascending: false })

    if (error) throw new Error(error.message)
    return data
  },

  async getBySemKey(obraCod: string, semKey: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cierres')
      .select('*')
      .eq('obra_cod', obraCod)
      .eq('sem_key', semKey)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateCierreDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const estado = dto.estado ?? 'pendiente'
    const { data, error } = await supabase
      .from('cierres')
      .insert({
        obra_cod:   dto.obra_cod,
        sem_key:    dto.sem_key,
        estado,
        cerrado_en: estado === 'cerrado' ? new Date().toISOString() : null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async updateEstado(obraCod: string, semKey: string, dto: UpdateCierreDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cierres')
      .update({
        estado: dto.estado,
        cerrado_en: dto.estado === 'cerrado' ? new Date().toISOString() : null,
        updated_by: userId,
      })
      .eq('obra_cod', obraCod)
      .eq('sem_key', semKey)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },
}
