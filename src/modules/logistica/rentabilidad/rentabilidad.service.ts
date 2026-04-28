import { createSupabaseClient } from '../../../lib/supabase.js'
import type { ParametrosDto, CreateViajeDto, UpdateViajeDto } from './rentabilidad.schema.js'

export const rentabilidadService = {

  // Trae el set de parámetros vigente (el único con vigente_hasta IS NULL).
  async getParametros(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('rentabilidad_parametros')
      .select('*')
      .is('vigente_hasta', null)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data
  },

  // Versionado: cierra el vigente con vigente_hasta=today y abre uno nuevo.
  // Mantiene el histórico para auditoría futura. La transacción es ligera —
  // las dos operaciones a la misma tabla con un constraint UNIQUE parcial
  // las hacemos secuencial; si la segunda falla por race, hay que correr
  // de nuevo.
  async updateParametros(dto: ParametrosDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const hoy = new Date().toISOString().slice(0, 10)

    // 1) Cerrar el vigente actual (si lo hay).
    const { error: e0 } = await sb
      .from('rentabilidad_parametros')
      .update({ vigente_hasta: hoy, updated_by: userId })
      .is('vigente_hasta', null)
    if (e0) throw new Error(e0.message)

    // 2) Insertar el nuevo vigente.
    const { data, error } = await sb
      .from('rentabilidad_parametros')
      .insert({
        ...dto,
        vigente_desde: hoy,
        vigente_hasta: null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async listViajes(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('rentabilidad_viajes')
      .select('*')
      .order('id', { ascending: true })
    if (error) throw new Error(error.message)
    return data
  },

  async createViaje(dto: CreateViajeDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('rentabilidad_viajes')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateViaje(id: number, dto: UpdateViajeDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('rentabilidad_viajes')
      .update({ ...dto, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteViaje(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { error } = await sb.from('rentabilidad_viajes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
