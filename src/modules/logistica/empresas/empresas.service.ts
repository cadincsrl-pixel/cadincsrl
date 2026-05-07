import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateEmpresaDto, UpdateEmpresaDto, CreateTarifaEmpresaDto, UpdateTarifaEmpresaDto } from './empresas.schema.js'

export const empresasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('empresas_transportistas')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('empresas_transportistas')
      .insert({ ...dto, created_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('empresas_transportistas')
      .update({ ...dto, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('empresas_transportistas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Tarifas históricas por empresa × cantera ──

  async getTarifas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .select('*, empresas_transportistas(nombre), canteras(nombre, localidad)')
      .order('empresa_id')
      .order('cantera_id')
      .order('vigente_desde', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createTarifa(dto: CreateTarifaEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .insert({ ...dto, updated_by: userId, updated_at: new Date().toISOString() })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateTarifa(id: number, dto: UpdateTarifaEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .update({ ...dto, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteTarifa(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('tarifas_empresa_cantera').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
