import type { PostgrestError } from '@supabase/supabase-js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import type {
  CreateSolicitudDto, UpdateSolicitudDto,
  ComprarItemDto, DespacharItemDto, EnviarItemDto, EditarItemDto,
} from './solicitudes.schema.js'

type ItemEstado = 'pendiente' | 'comprado' | 'de_deposito' | 'enviado' | 'rechazado'

// ── Feature flag ─────────────────────────────────────────────
// Si USE_RPC_RESOLVER === 'true', resolverItem{Compra,Despacho} usan las
// RPCs transaccionales en Postgres. Por defecto (flag ausente o distinto)
// se mantiene el camino legacy no-transaccional para poder hacer rollback
// instantáneo sin redeploy.
function useRpcResolver(): boolean {
  return process.env.USE_RPC_RESOLVER === 'true'
}

// ── HttpError + mapper de errores de RPC ──────────────────────
// El handler de rutas (itemHandler) respeta esta clase: si se lanza,
// devuelve status/code/detail como JSON. Si se lanza un Error común,
// cae al flujo anterior (legacy).
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
  ) {
    super(code)
    this.name = 'HttpError'
  }
}

function parseDetail(details: string | null | undefined): unknown {
  if (!details) return undefined
  try {
    return JSON.parse(details)
  } catch {
    return details
  }
}

export function mapRpcError(error: PostgrestError): HttpError {
  const msg = error.message || ''
  const code =
    /NO_AUTH/.test(msg)             ? 'NO_AUTH' :
    /SIN_PERFIL/.test(msg)          ? 'SIN_PERFIL' :
    /SIN_PERMISO/.test(msg)         ? 'SIN_PERMISO' :
    /SOLICITUD_NO_EXISTE/.test(msg) ? 'SOLICITUD_NO_EXISTE' :
    /SOLICITUD_TIENE_REMITOS/.test(msg) ? 'SOLICITUD_TIENE_REMITOS' :
    /ITEM_NO_EXISTE/.test(msg)      ? 'ITEM_NO_EXISTE' :
    /ITEM_NO_DISPONIBLE/.test(msg)  ? 'ITEM_NO_DISPONIBLE' :
    /PROVEEDOR_INVALIDO/.test(msg)  ? 'PROVEEDOR_INVALIDO' :
    /FACTURA_INVALIDA/.test(msg)    ? 'FACTURA_INVALIDA' :
    /STOCK_INSUFICIENTE/.test(msg)  ? 'STOCK_INSUFICIENTE' :
    /ITEM_YA_REGISTRADO/.test(msg)  ? 'ITEM_YA_REGISTRADO' :
    error.code || 'UNKNOWN'

  switch (code) {
    case 'NO_AUTH':               return new HttpError(401, code)
    case 'SIN_PERFIL':            return new HttpError(403, code)
    case 'SIN_PERMISO':           return new HttpError(403, code, parseDetail(error.details))
    case 'SOLICITUD_NO_EXISTE':   return new HttpError(404, code)
    case 'SOLICITUD_TIENE_REMITOS': return new HttpError(409, code)
    case 'ITEM_NO_EXISTE':        return new HttpError(404, code)
    case 'ITEM_NO_DISPONIBLE':    return new HttpError(404, code) // mantiene 404 legacy
    case 'PROVEEDOR_INVALIDO':    return new HttpError(400, code)
    case 'FACTURA_INVALIDA':      return new HttpError(400, code)
    case 'STOCK_INSUFICIENTE':    return new HttpError(400, code, parseDetail(error.details))
    case 'ITEM_YA_REGISTRADO':    return new HttpError(409, code)
    case '23503':                 return new HttpError(500, 'INTEGRIDAD_REFERENCIAL')
    default:                      return new HttpError(500, 'DB_ERROR', { dbMessage: msg })
  }
}

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

  async getAll(token: string, userId: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('solicitud_compra')
      .select('*, items:solicitud_compra_item(*, proveedores(nombre))')
      .order('fecha', { ascending: false })
    if (obra_cod) q = q.eq('obra_cod', obra_cod)

    // Filtrar por las obras del usuario (no admin con asignaciones).
    const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
    if (allowed != null) {
      if (allowed.length === 0) return []
      q = q.in('obra_cod', allowed)
    }

    const { data, error } = await q
    if (error) throw new Error(error.message)

    return (data ?? []).map(s => ({
      ...s,
      progreso: s.estado === 'aprobada' ? calcProgreso(s.items) : null,
      resumen:  s.estado === 'aprobada' ? countResumen(s.items) : null,
    }))
  },

  async getById(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra')
      .select('*, items:solicitud_compra_item(*, proveedores(nombre), facturas_compra(numero, adjunto_url))')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)

    // Validar acceso a la obra.
    const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
    if (allowed != null && !allowed.includes(data.obra_cod)) {
      throw new HttpError(403, 'OBRA_SIN_ACCESO')
    }

    return {
      ...data,
      progreso: data.estado === 'aprobada' ? calcProgreso(data.items) : null,
      resumen:  data.estado === 'aprobada' ? countResumen(data.items) : null,
    }
  },

  async create(dto: CreateSolicitudDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { items, ...cabecera } = dto

    // Validar que el user pueda crear solicitudes en esa obra.
    const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
    if (allowed != null && !allowed.includes(cabecera.obra_cod)) {
      throw new HttpError(403, 'OBRA_SIN_ACCESO')
    }

    const { data: solicitud, error } = await supabase
      .from('solicitud_compra')
      .insert({
        ...cabecera,
        estado: 'aprobada',
        fecha: new Date().toISOString().slice(0, 10),
        solicitante: userId,
        aprobado_por: userId,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)

    const itemsData = items.map(it => {
      const row: any = {
        solicitud_id: solicitud.id,
        descripcion:  it.descripcion,
        cantidad:     it.cantidad,
        unidad:       it.unidad,
        obs:          it.obs ?? null,
        estado:       'pendiente',
      }
      if (it.material_id) row.material_id = it.material_id
      return row
    })

    const { error: itemsErr } = await supabase
      .from('solicitud_compra_item')
      .insert(itemsData)
    if (itemsErr) throw new Error(itemsErr.message)

    return this.getById(solicitud.id, token, userId)
  },

  async update(id: number, dto: UpdateSolicitudDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Validar acceso a la obra de esta solicitud antes de cualquier mutación.
    const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
    if (allowed != null) {
      const { data: cab, error: errCab } = await supabase
        .from('solicitud_compra').select('obra_cod').eq('id', id).maybeSingle()
      if (errCab) throw new Error(errCab.message)
      if (!cab) throw new HttpError(404, 'SOLICITUD_NO_EXISTE')
      if (!allowed.includes(cab.obra_cod)) throw new HttpError(403, 'OBRA_SIN_ACCESO')
    }

    // Actualizar cabecera
    const { items, remove_items, ...cabFields } = dto
    const updateData: any = { ...cabFields, updated_by: userId }
    if (dto.estado === 'aprobada') updateData.aprobado_por = userId

    // Solo actualizar cabecera si hay campos
    if (Object.keys(cabFields).length > 0) {
      const { error } = await supabase
        .from('solicitud_compra')
        .update(updateData)
        .eq('id', id)
      if (error) throw new Error(error.message)
    }

    // Eliminar ítems
    if (remove_items && remove_items.length > 0) {
      const { error } = await supabase
        .from('solicitud_compra_item')
        .delete()
        .in('id', remove_items)
        .eq('solicitud_id', id)
        .eq('estado', 'pendiente') // solo pendientes se pueden borrar
      if (error) throw new Error(error.message)
    }

    // Agregar/actualizar ítems
    if (items && items.length > 0) {
      for (const it of items) {
        if (it.id) {
          // Actualizar ítem existente (solo si pendiente)
          const updateItem: any = {
            descripcion: it.descripcion,
            cantidad:    it.cantidad,
            unidad:      it.unidad,
            obs:         it.obs ?? null,
          }
          if (it.material_id) updateItem.material_id = it.material_id
          const { error: updErr } = await supabase
            .from('solicitud_compra_item')
            .update(updateItem)
            .eq('id', it.id)
            .eq('estado', 'pendiente')
          if (updErr) throw new Error(`Error actualizando ítem ${it.id}: ${updErr.message}`)
        } else {
          // Nuevo ítem
          const row: any = {
            solicitud_id: id,
            descripcion:  it.descripcion,
            cantidad:     it.cantidad,
            unidad:       it.unidad,
            obs:          it.obs ?? null,
            estado:       'pendiente',
          }
          if (it.material_id) row.material_id = it.material_id
          const { error: insErr } = await supabase.from('solicitud_compra_item').insert(row)
          if (insErr) throw new Error(`Error insertando ítem: ${insErr.message}`)
        }
      }
    }

    return this.getById(id, token, userId)
  },

  async delete(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Validar acceso a la obra antes de borrar.
    const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
    if (allowed != null) {
      const { data: cab, error: errCab } = await supabase
        .from('solicitud_compra').select('obra_cod').eq('id', id).maybeSingle()
      if (errCab) throw new Error(errCab.message)
      if (!cab) throw new HttpError(404, 'SOLICITUD_NO_EXISTE')
      if (!allowed.includes(cab.obra_cod)) throw new HttpError(403, 'OBRA_SIN_ACCESO')
    }

    // RPC transaccional: revierte stock con FOR UPDATE, valida remitos_envio,
    // y borra solicitud_compra (CASCADE borra items + MCC).
    // Migración 20260424_rpc_eliminar_solicitud.
    const { data, error } = await supabase.rpc('eliminar_solicitud', {
      p_solicitud_id: id,
      p_user_id:      userId,
    })
    if (error) throw mapRpcError(error)
    return data as { success: boolean; solicitud_id: number; items_revertidos: number }
  },

  // ── Acciones sobre ítems ─────────────────────────────────

  // Dispatcher: según feature flag, usa RPC transaccional o camino legacy.
  // Si dto.queda_en_proveedor=true, en cambio dispara la RPC de
  // 'en_proveedor' (no hay camino legacy: feature nuevo).
  async comprarItem(itemId: number, dto: ComprarItemDto, token: string, userId: string) {
    if (dto.queda_en_proveedor) return this.comprarItemEnProveedor(itemId, dto, token, userId)
    if (useRpcResolver()) return this.comprarItemViaRPC(itemId, dto, token, userId)
    return this.comprarItemLegacy(itemId, dto, token, userId)
  },

  // RPC `resolver_item_en_proveedor`: marca item='en_proveedor' + suma
  // entrada en stock_proveedor_movimientos. NO inserta en MCC todavía
  // (la facturación al cliente espera al retiro real, decisión B).
  async comprarItemEnProveedor(itemId: number, dto: ComprarItemDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.rpc('resolver_item_en_proveedor', {
      p_item_id:      itemId,
      p_proveedor_id: dto.proveedor_id,
      p_precio_unit:  dto.precio_unit,
      p_factura_id:   dto.factura_id ?? null,
      p_user_id:      userId,
    })
    if (error) throw mapRpcError(error)

    // Post-RPC: persistir `pagado_por` en el item (la RPC no acepta el param
    // aún). Cuando se retire del proveedor, _registrarMaterialCliente lee del
    // item y copia el valor al MCC. Si caller no pasó nada o 'cadinc', el
    // default de DB ya está correcto.
    if (dto.pagado_por === 'cliente') {
      await supabase.from('solicitud_compra_item')
        .update({ pagado_por: 'cliente' })
        .eq('id', itemId)
    }

    const { data: item, error: selErr } = await supabase
      .from('solicitud_compra_item')
      .select('*, solicitud_compra(id, obra_cod)')
      .eq('id', itemId)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)
    return item
  },

  // `forzarSinStock` es un parámetro **explícito** (no se lee del dto).
  // La autorización de este modo se valida en el route (permiso
  // `certificaciones.forzar_despacho`); cualquier caller directo del
  // service debe pasar el flag a conciencia. Defensa en profundidad:
  // el service no confía en que la capa de arriba haya validado.
  async despacharItem(
    itemId: number,
    dto: DespacharItemDto,
    token: string,
    userId: string,
    forzarSinStock: boolean = false,
  ) {
    if (useRpcResolver()) return this.despacharItemViaRPC(itemId, dto, token, userId, forzarSinStock)
    return this.despacharItemLegacy(itemId, dto, token, userId, forzarSinStock)
  },

  // Camino RPC — transaccional en Postgres (resolver_item_compra).
  //
  // Shape de respuesta elegido: (b) getById del item post-RPC.
  // Razón: el frontend (useComprarItem/useDespacharItem) consume el row
  // de solicitud_compra_item con join a solicitud_compra(id, obra_cod)
  // tal como lo devuelve el legacy. La RPC devuelve 12 columnas con un
  // shape distinto. Para no romper el contrato durante el rollout con
  // flag, hacemos un SELECT extra tras la RPC y devolvemos el mismo
  // shape que el legacy. Costo: un round-trip adicional (despreciable
  // comparado con mantener estabilidad del frontend).
  async comprarItemViaRPC(itemId: number, dto: ComprarItemDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.rpc('resolver_item_compra', {
      p_item_id:      itemId,
      p_proveedor_id: dto.proveedor_id,
      p_precio_unit:  dto.precio_unit,
      p_factura_id:   dto.factura_id ?? null,
      p_user_id:      userId,
    })
    if (error) throw mapRpcError(error)
    // La RPC ya registra en materiales_a_cuenta_cliente (y en stock,
    // si corresponde) dentro de la transacción. NO llamar a
    // _registrarMaterialCliente acá — sería doble registro.

    // Post-RPC: persistir `pagado_por` si el caller especificó 'cliente'.
    // La RPC no acepta el param aún (default 'cadinc' en DB). Hacemos un
    // UPDATE adicional en item Y en el MCC recién insertado. Si el caller
    // no pasó nada o pasó 'cadinc', el default de la DB ya quedó correcto.
    // TODO: cuando se actualice la RPC para aceptar p_pagado_por, eliminar
    // este post-update y pasar el param atómicamente.
    if (dto.pagado_por === 'cliente') {
      await supabase.from('solicitud_compra_item')
        .update({ pagado_por: 'cliente' })
        .eq('id', itemId)
      await supabase.from('materiales_a_cuenta_cliente')
        .update({ pagado_por: 'cliente', updated_by: userId })
        .eq('item_id', itemId)
    }

    const { data: item, error: selErr } = await supabase
      .from('solicitud_compra_item')
      .select('*, solicitud_compra(id, obra_cod)')
      .eq('id', itemId)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)
    return item
  },

  async despacharItemViaRPC(
    itemId: number,
    dto: DespacharItemDto,
    token: string,
    userId: string,
    forzarSinStock: boolean = false,
  ) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.rpc('resolver_item_despacho', {
      p_item_id:          itemId,
      p_precio_unit:      dto.precio_unit,
      p_user_id:          userId,
      p_forzar_sin_stock: forzarSinStock,
    })
    if (error) throw mapRpcError(error)
    // La RPC ya registra en materiales_a_cuenta_cliente (y en stock,
    // si corresponde) dentro de la transacción. NO llamar a
    // _registrarMaterialCliente acá — sería doble registro.

    const { data: item, error: selErr } = await supabase
      .from('solicitud_compra_item')
      .select('*, solicitud_compra(id, obra_cod)')
      .eq('id', itemId)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)
    return item
  },

  // ── Camino legacy (fallback de rollback) ──────────────────
  // NO TOCAR sin coordinar: es el path que se activa cuando
  // USE_RPC_RESOLVER no está en 'true'. Preserva el comportamiento
  // histórico (múltiples llamadas no-transaccionales).
  async comprarItemLegacy(itemId: number, dto: ComprarItemDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:           'comprado',
        proveedor_id:     dto.proveedor_id,
        precio_unit:      dto.precio_unit,
        factura_id:       dto.factura_id ?? null,
        fecha_resolucion: new Date().toISOString().slice(0, 10),
        pagado_por:       dto.pagado_por ?? 'cadinc',
      })
      .eq('id', itemId)
      .eq('estado', 'pendiente')
      .select('*, solicitud_compra(id, obra_cod)')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o ya fue procesado')

    // Si la obra es depósito y el ítem tiene material_id, sumar stock
    if (data.material_id && data.solicitud_compra?.obra_cod) {
      const { data: obra } = await supabase
        .from('obras')
        .select('es_deposito')
        .eq('cod', data.solicitud_compra.obra_cod)
        .maybeSingle()
      if (obra?.es_deposito) {
        const { data: mat } = await supabase
          .from('stock_materiales')
          .select('stock_actual')
          .eq('id', data.material_id)
          .maybeSingle()
        if (mat) {
          await supabase
            .from('stock_materiales')
            .update({
              stock_actual: mat.stock_actual + data.cantidad,
              precio_ref: dto.precio_unit,
              updated_by: userId,
            })
            .eq('id', data.material_id)
        }
        await supabase.from('stock_movimientos').insert({
          material_id:       data.material_id,
          tipo:              'entrada',
          cantidad:          data.cantidad,
          motivo:            'compra',
          obra_cod:          data.solicitud_compra.obra_cod,
          solicitud_item_id: itemId,
          fecha:             new Date().toISOString().slice(0, 10),
          created_by:        userId,
        })
      }
    }

    await this._registrarMaterialCliente(itemId, data.solicitud_id, token, userId)
    return data
  },

  // El legacy nunca validó saldo — siempre permitía quedar en negativo.
  // El parámetro `forzarSinStock` se acepta por consistencia de firma
  // con el dispatcher, pero no cambia el comportamiento.
  async despacharItemLegacy(
    itemId: number,
    dto: DespacharItemDto,
    token: string,
    userId: string,
    _forzarSinStock: boolean = false,
  ) {
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
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o ya fue procesado')

    // Descontar stock si el ítem tiene material_id vinculado
    if (data.material_id) {
      const { data: mat } = await supabase
        .from('stock_materiales')
        .select('stock_actual')
        .eq('id', data.material_id)
        .maybeSingle()
      if (mat) {
        await supabase
          .from('stock_materiales')
          .update({ stock_actual: mat.stock_actual - data.cantidad, updated_by: userId })
          .eq('id', data.material_id)
      }
      await supabase.from('stock_movimientos').insert({
        material_id:       data.material_id,
        tipo:              'salida',
        cantidad:          data.cantidad,
        motivo:            'despacho_obra',
        obra_cod:          data.solicitud_compra?.obra_cod ?? null,
        solicitud_item_id: itemId,
        fecha:             new Date().toISOString().slice(0, 10),
        created_by:        userId,
      })
    }

    await this._registrarMaterialCliente(itemId, data.solicitud_id, token, userId)
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
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o no está listo para enviar')
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
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o ya fue procesado')
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
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o no se puede revertir')

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
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o no se puede editar')

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

  // Registra UN ítem resuelto en materiales_a_cuenta_cliente (se llama al comprar o despachar)
  async _registrarMaterialCliente(itemId: number, solicitudId: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    const { data: item } = await supabase
      .from('solicitud_compra_item')
      .select('*')
      .eq('id', itemId)
      .maybeSingle()
    if (!item || !['comprado', 'de_deposito', 'enviado'].includes(item.estado)) return

    const { data: sol } = await supabase
      .from('solicitud_compra')
      .select('obra_cod')
      .eq('id', solicitudId)
      .maybeSingle()
    if (!sol) return

    // No registrar si la obra es depósito (es reposición de stock, no a cuenta del cliente)
    const { data: obra } = await supabase
      .from('obras')
      .select('es_deposito')
      .eq('cod', sol.obra_cod)
      .maybeSingle()
    if (obra?.es_deposito) return

    // Despacho de depósito interno siempre es 'cadinc' (el material es propio
    // de CADINC, no aplica "cliente paga directo" aunque el item lo tenga seteado).
    // Para compras 'comprado' o 'enviado' (retirado vía remito), respetar el
    // `pagado_por` del item.
    const pagadoPor = item.estado === 'de_deposito'
      ? 'cadinc'
      : (item.pagado_por ?? 'cadinc')

    const registro = {
      obra_cod:         sol.obra_cod,
      solicitud_id:     solicitudId,
      item_id:          item.id,
      descripcion:      item.descripcion,
      cantidad:         item.cantidad,
      unidad:           item.unidad,
      precio_unit:      item.precio_unit ?? 0,
      precio_total:     item.cantidad * (item.precio_unit ?? 0),
      origen:           item.estado === 'comprado' ? 'proveedor' : 'deposito',
      proveedor_id:     item.proveedor_id,
      factura_id:       item.factura_id,
      fecha_resolucion: item.fecha_resolucion ?? new Date().toISOString().slice(0, 10),
      pagado_por:       pagadoPor,
      created_by:       userId,
      updated_by:       userId,
    }

    const { data: existing } = await supabase
      .from('materiales_a_cuenta_cliente')
      .select('id')
      .eq('item_id', item.id)
      .maybeSingle()

    if (existing) {
      await supabase.from('materiales_a_cuenta_cliente').update({ ...registro, updated_by: userId }).eq('item_id', item.id)
    } else {
      await supabase.from('materiales_a_cuenta_cliente').insert(registro)
    }
  },
}
