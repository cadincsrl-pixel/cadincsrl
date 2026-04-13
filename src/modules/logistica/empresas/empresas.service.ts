import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateEmpresaDto, UpdateEmpresaDto, UpsertTarifaEmpresaDto } from './empresas.schema.js'

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

  // ── Tarifas por empresa × cantera ──

  async getTarifas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .select('*, empresas_transportistas(nombre), canteras(nombre, localidad)')
      .order('empresa_id')
    if (error) throw new Error(error.message)
    return data
  },

  async getTarifasByEmpresa(empresaId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .select('*, canteras(nombre, localidad)')
      .eq('empresa_id', empresaId)
      .order('cantera_id')
    if (error) throw new Error(error.message)
    return data
  },

  async upsertTarifa(dto: UpsertTarifaEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .upsert(
        { ...dto, updated_by: userId, updated_at: new Date().toISOString() },
        { onConflict: 'empresa_id,cantera_id' }
      )
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
