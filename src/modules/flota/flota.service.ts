import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateVehiculoDto, UpdateVehiculoDto } from './flota.schema.js'

export const flotaService = {

  async getAll(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_vehiculos')
      .select('*')
      .order('patente')
    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_vehiculos')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('VEHICULO_NO_EXISTE')
    return data
  },

  async create(dto: CreateVehiculoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_vehiculos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateVehiculoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_vehiculos')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { error } = await sb.from('flota_vehiculos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // Notificaciones del módulo: papeles vencidos / por vencer.
  // Lee la vista v_vehiculo_documentos_vencimientos filtrando entidad='flota'.
  // El umbral (días hasta el vencimiento) se decide en el frontend.
  async getNotificaciones(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('v_vehiculo_documentos_vencimientos')
      .select('*')
      .eq('entidad', 'flota')
      .order('vence_el', { ascending: true })
    if (error) throw new Error(error.message)
    return data
  },
}
