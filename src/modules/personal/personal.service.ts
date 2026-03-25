import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreatePersonalDto, UpdatePersonalDto } from './personal.schema.js'

export const personalService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('personal')
      .select(`
        *,
        personal_cat_historial (
          cat_id,
          desde
        )
      `)
      .order('leg')

    if (error) throw new Error(error.message)
    return data
  },

  async getByLeg(leg: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('personal')
      .select(`
        *,
        personal_cat_historial (
          cat_id,
          desde
        )
      `)
      .eq('leg', leg)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreatePersonalDto, token: string) {
    const supabase = createSupabaseClient(token)

    const { data, error } = await supabase
      .from('personal')
      .insert({
        leg: dto.leg,
        nom: dto.nom,
        dni: dto.dni,
        cat_id: dto.cat_id,
        tel: dto.tel,
        dir: dto.dir,
        obs: dto.obs,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Insertar primer registro en historial de categorías
    await supabase
      .from('personal_cat_historial')
      .insert({
        leg: dto.leg,
        cat_id: dto.cat_id,
        desde: new Date().toISOString().slice(0, 10),
      })

    return data
  },

  async update(leg: string, dto: UpdatePersonalDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('personal')
      .update(dto)
      .eq('leg', leg)
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Si cambió la categoría, registrar en historial
    if (dto.cat_id) {
      await supabase
        .from('personal_cat_historial')
        .insert({
          leg,
          cat_id: dto.cat_id,
          desde: new Date().toISOString().slice(0, 10),
        })
    }

    return data
  },

  async delete(leg: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('personal')
      .delete()
      .eq('leg', leg)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}