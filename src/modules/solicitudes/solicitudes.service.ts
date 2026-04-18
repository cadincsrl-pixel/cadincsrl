import { createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateSolicitudDto, UpdateSolicitudDto,
  ComprarItemDto, DespacharItemDto, EnviarItemDto, EditarItemDto,
} from './solicitudes.schema.js'

type ItemEstado = 'pendiente' | 'comprado' | 'de_deposito' | 'enviado' | 'rechazado'

function calcProgreso(items: Array<{ estado: ItemEstado }>): string {
  const actionable = items.filter(i => i.estado !== 'rechazado')
  if (actionable.length === 0) return 'pendiente'
  const allEnviado  = actionable.every(i => i.estado === 'enviado')
  if (allEnviado) return 'enviada'
  const allResuelto = actionable.every(i => ['comprado', 'de_deposito', 'enviado'].includes(i.estado))
  if (allResuelto) return 'en_gestion'
  return 'pendiente'
}

function countResumen(items: Array<{ estado: ItemEstado }>) {
  const actionable = items.filter(i => i.estado !== 'rechazado')
  const resueltos  = actionable.filter(i => ['comprado', 'de_deposito', 'enviado'].includes(i.estado)).length
  const enviados   = actionable.filter(i => i.estado === 'enviado').length
  return { total: actionable.length, resueltos, enviados }
}

export const solicitudesService = {

  async getAll(token: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('solicitud_compra')
      .select('*, items:solicitud_compra_item(*, proveedores(nombre))')
      .order('fecha', { ascending: false })
    if (obra_cod) q = q.eq('obra_cod', obra_cod)
    const { data, error } = await q
    if (error) throw new Error(error.message)

    return (data ?? []).map(s => ({
      ...s,
      progreso: s.estado === 'aprobada' ? calcProgreso(s.items) : null,
      resumen:  s.estado === 'aprobada' ? countResumen(s.items) : null,
    }))
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra')
      .select('*, items:solicitud_compra_item(*, proveedores(nombre), facturas_compra(numero, adjunto_url))')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return {
      ...data,
      progreso: data.estado === 'aprobada' ? calcProgreso(data.items) : null,
      resumen:  data.estado === 'aprobada' ? countResumen(data.items) : null,
    }
  },

  async create(dto: CreateSolicitudDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { items, ...cabecera } = dto

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

    const itemsData = items.map(it => ({
      solicitud_id: solicitud.id,
      descripcion:  it.descripcion,
      cantidad:     it.cantidad,
      unidad:       it.unidad,
      obs:          it.obs ?? null,
      estado:       'pendiente',
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
    if (dto.estado === 'aprobada') updateData.aprobado_por = userId

    const { error } = await supabase
      .from('solicitud_compra')
      .update(updateData)
      .eq('id', id)
    if (error) throw new Error(error.message)
    return this.getById(id, token)
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('solicitud_compra').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Acciones sobre ítems ─────────────────────────────────

  async comprarItem(itemId: number, dto: ComprarItemDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:           'comprado',
        proveedor_id:     dto.proveedor_id,
        precio_unit:      dto.precio_unit,
        factura_id:       dto.factura_id ?? null,
        fecha_resolucion: new Date().toISOString().slice(0, 10),
      })
      .eq('id', itemId)
      .eq('estado', 'pendiente')
      .select('*, solicitud_compra(id, obra_cod)')
      .single()
    if (error) throw new Error(error.message)

    await this._checkAndCreateMateriales(data.solicitud_id, token, userId)
    return data
  },

  async despacharItem(itemId: number, dto: { precio_unit: number }, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:           'de_deposito',
        precio_unit:      dto.precio_unit,
        fecha_resolucion: new Date().toISOString().slice(0, 10),
      })
      .eq('id', itemId)
      .eq('estado', 'pendiente')
      .select('*, solicitud_compra(id, obra_cod)')
      .single()
    if (error) throw new Error(error.message)

    await this._checkAndCreateMateriales(data.solicitud_id, token, userId)
    return data
  },

  async enviarItem(itemId: number, fechaEnvio: string | undefined, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:     'enviado',
        fecha_envio: fechaEnvio ?? new Date().toISOString().slice(0, 10),
      })
      .eq('id', itemId)
      .in('estado', ['comprado', 'de_deposito'])
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async rechazarItem(itemId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({ estado: 'rechazado' })
      .eq('id', itemId)
      .eq('estado', 'pendiente')
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async revertirItem(itemId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:           'pendiente',
        proveedor_id:     null,
        precio_unit:      null,
        factura_id:       null,
        fecha_resolucion: null,
        fecha_envio:      null,
      })
      .eq('id', itemId)
      .in('estado', ['comprado', 'de_deposito', 'rechazado'])
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Borrar registro de materiales_a_cuenta_cliente si existía
    await supabase.from('materiales_a_cuenta_cliente').delete().eq('item_id', itemId)
    return data
  },

  async editarItem(itemId: number, dto: EditarItemDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update(dto)
      .eq('id', itemId)
      .in('estado', ['comprado', 'de_deposito', 'enviado'])
      .select('*, solicitud_compra(id, obra_cod)')
      .single()
    if (error) throw new Error(error.message)

    // Actualizar materiales_a_cuenta_cliente si existe
    const updates: any = {}
    if (dto.precio_unit !== undefined) {
      updates.precio_unit = dto.precio_unit
      updates.precio_total = data.cantidad * dto.precio_unit
    }
    if (dto.proveedor_id !== undefined) updates.proveedor_id = dto.proveedor_id
    if (dto.factura_id !== undefined) updates.factura_id = dto.factura_id
    if (Object.keys(updates).length > 0) {
      updates.updated_by = userId
      await supabase.from('materiales_a_cuenta_cliente').update(updates).eq('item_id', itemId)
    }

    return data
  },

  // ── Genera materiales_a_cuenta_cliente cuando todos los ítems están resueltos ──
  async _checkAndCreateMateriales(solicitudId: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    const { data: items } = await supabase
      .from('solicitud_compra_item')
      .select('*')
      .eq('solicitud_id', solicitudId)

    if (!items) return

    const actionable = items.filter(i => i.estado !== 'rechazado')
    const allResuelto = actionable.every(i => ['comprado', 'de_deposito', 'enviado'].includes(i.estado))
    if (!allResuelto) return

    // Obtener obra_cod de la solicitud
    const { data: sol } = await supabase
      .from('solicitud_compra')
      .select('obra_cod')
      .eq('id', solicitudId)
      .single()
    if (!sol) return

    // Upsert cada ítem resuelto
    for (const item of actionable) {
      const registro = {
        obra_cod:         sol.obra_cod,
        solicitud_id:     solicitudId,
        item_id:          item.id,
        descripcion:      item.descripcion,
        cantidad:         item.cantidad,
        unidad:           item.unidad,
        precio_unit:      item.precio_unit,
        precio_total:     item.cantidad * item.precio_unit,
        origen:           item.estado === 'comprado' ? 'proveedor' : 'deposito',
        proveedor_id:     item.proveedor_id,
        factura_id:       item.factura_id,
        fecha_resolucion: item.fecha_resolucion,
        created_by:       userId,
        updated_by:       userId,
      }

      // Intentar update, si no existe, insert
      const { data: existing } = await supabase
        .from('materiales_a_cuenta_cliente')
        .select('id')
        .eq('item_id', item.id)
        .maybeSingle()

      if (existing) {
        await supabase
          .from('materiales_a_cuenta_cliente')
          .update({ ...registro, updated_by: userId })
          .eq('item_id', item.id)
      } else {
        await supabase
          .from('materiales_a_cuenta_cliente')
          .insert(registro)
      }
    }
  },
}
