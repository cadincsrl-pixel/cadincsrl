// src/modules/categorias/categorias.service.ts
import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateCategoriaDto, UpdateCategoriaDto } from './categorias.schema.js'

export const categoriasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .select('*')
      .order('id')

    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateCategoriaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .insert({ nom: dto.nom, vh: dto.vh })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateCategoriaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .update({ ...dto })
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('categorias')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}