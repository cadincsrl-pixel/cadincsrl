import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateSolicitudDto, UpdateSolicitudDto } from './solicitudes.schema.js'

export const solicitudesService = {

  async getAll(token: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('solicitud_compra')
      .select('*, items:solicitud_compra_item(*)')
      .order('fecha', { ascending: false })
    if (obra_cod) q = q.eq('obra_cod', obra_cod)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra')
      .select('*, items:solicitud_compra_item(*)')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateSolicitudDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { items, ...cabecera } = dto

    // Insertar cabecera
    const { data: solicitud, error } = await supabase
      .from('solicitud_compra')
      .insert({
        ...cabecera,
        fecha: new Date().toISOString().slice(0, 10),
        solicitante: userId,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Insertar ítems
    const itemsData = items.map(it => ({
      solicitud_id: solicitud.id,
      descripcion:  it.descripcion,
      cantidad:     it.cantidad,
      unidad:       it.unidad,
      obs:          it.obs ?? null,
    }))

    const { error: itemsErr } = await supabase
      .from('solicitud_compra_item')
      .insert(itemsData)
    if (itemsErr) throw new Error(itemsErr.message)

    return this.getById(solicitud.id, token)
  },

  async update(id: number, dto: UpdateSolicitudDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const updateData: any = { ...dto, updated_by: userId }

    // Si se aprueba, registrar quién aprobó
    if (dto.estado === 'aprobada') {
      updateData.aprobado_por = userId
    }

    const { data, error } = await supabase
      .from('solicitud_compra')
      .update(updateData)
      .eq('id', id)
      .select('*, items:solicitud_compra_item(*)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Items se eliminan por cascade
    const { error } = await supabase.from('solicitud_compra').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
