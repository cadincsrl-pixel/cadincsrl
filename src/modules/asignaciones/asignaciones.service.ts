import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateAsignacionDto, BajaAsignacionDto } from './asignaciones.schema.js'

export const asignacionesService = {

  async getByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asignaciones')
      .select('*')
      .eq('obra_cod', obraCod)

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateAsignacionDto, token: string) {
    const supabase = createSupabaseClient(token)

    // Verificar que no exista ya
    const { data: existing } = await supabase
      .from('asignaciones')
      .select('*')
      .eq('obra_cod', dto.obra_cod)
      .eq('leg', dto.leg)
      .single()

    if (existing) throw new Error('El trabajador ya está asignado a esta obra')

    const { data, error } = await supabase
      .from('asignaciones')
      .insert({ obra_cod: dto.obra_cod, leg: dto.leg })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async baja(obraCod: string, leg: string, dto: BajaAsignacionDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asignaciones')
      .update({ baja_desde: dto.baja_desde })
      .eq('obra_cod', obraCod)
      .eq('leg', leg)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(obraCod: string, leg: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('asignaciones')
      .delete()
      .eq('obra_cod', obraCod)
      .eq('leg', leg)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}