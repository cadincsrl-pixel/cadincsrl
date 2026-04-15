import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateMaterialDto, UpdateMaterialDto, CreateAdicionalDto, UpdateAdicionalDto } from './certificaciones.schema.js'

export const certificacionesService = {

  // ── Materiales ────────────────────────────────────────
  async getMateriales(token: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase.from('cert_materiales').select('*').order('fecha', { ascending: false })
    if (obra_cod) q = q.eq('obra_cod', obra_cod)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async createMaterial(dto: CreateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cert_materiales')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMaterial(id: number, dto: UpdateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cert_materiales')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMaterial(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('cert_materiales').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Adicionales ───────────────────────────────────────
  async getAdicionales(token: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase.from('cert_adicionales').select('*').order('fecha', { ascending: false })
    if (obra_cod) q = q.eq('obra_cod', obra_cod)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async createAdicional(dto: CreateAdicionalDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cert_adicionales')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateAdicional(id: number, dto: UpdateAdicionalDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cert_adicionales')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteAdicional(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('cert_adicionales').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
