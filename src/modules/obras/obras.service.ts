import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateObraDto, UpdateObraDto } from './obras.schema.js'

export const obrasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('archivada', false)
      .order('created_at')

    if (error) throw new Error(error.message)
    return data
  },

  async getArchivadas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('archivada', true)
      .order('fecha_archivo', { ascending: false })

    if (error) throw new Error(error.message)
    return data
  },

  async getByCod(cod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('cod', cod)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Verificar que el código no exista
    const { data: existing } = await supabase
      .from('obras')
      .select('cod')
      .eq('cod', dto.cod)
      .single()

    if (existing) throw new Error(`El código ${dto.cod} ya existe`)

    const { data, error } = await supabase
      .from('obras')
      .insert({
        cod: dto.cod,
        nom: dto.nom,
        cc: dto.cc,
        dir: dto.dir,
        resp: dto.resp,
        obs: dto.obs,
        archivada: false,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async update(cod: string, dto: UpdateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({ ...dto, updated_by: userId })
      .eq('cod', cod)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async archivar(cod: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({
        archivada: true,
        fecha_archivo: new Date().toISOString().slice(0, 10),
        updated_by: userId,
      })
      .eq('cod', cod)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(cod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('obras')
      .delete()
      .eq('cod', cod)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
