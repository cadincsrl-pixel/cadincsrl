import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateProveedorDto, UpdateProveedorDto } from './proveedores.schema.js'

export const proveedoresService = {
  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('proveedores')
      .select('*')
      .eq('activo', true)
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateProveedorDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('proveedores')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateProveedorDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('proveedores')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // Soft delete
    const { data, error } = await supabase
      .from('proveedores')
      .update({ activo: false, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },
}
