import type { PostgrestError } from '@supabase/supabase-js'
import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import { registrarItemEvento } from '../../lib/item-eventos.js'
import type {
  CreateSolicitudDto, UpdateSolicitudDto,
  ComprarItemDto, DespacharItemDto, EnviarItemDto, EditarItemDto,
} from './solicitudes.schema.js'

type ItemEstado = 'pendiente' | 'comprado' | 'de_deposito' | 'en_proveedor' | 'retirado' | 'enviado' | 'rechazado'

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

// Estados que cuentan como "gestionado" (la compra/despacho/retiro ya se actuó).
// Incluye en_proveedor (comprado, esperando retiro) y retirado (traído, listo
// para enviar) — antes faltaban y dejaban la solicitud en 'pendiente' aunque
// todos sus ítems estuvieran en gestión.
const ESTADOS_RESUELTOS: ItemEstado[] = ['comprado', 'de_deposito', 'en_proveedor', 'retirado', 'enviado']

function calcProgreso(items: Array<{ estado: ItemEstado }>): string {
  const actionable = items.filter(i => i.estado !== 'rechazado')
  if (actionable.length === 0) return 'pendiente'
  const allEnviado  = actionable.every(i => i.estado === 'enviado')
  if (allEnviado) return 'enviada'
  const allResuelto = actionable.every(i => ESTADOS_RESUELTOS.includes(i.estado))
  if (allResuelto) return 'en_gestion'
  return 'pendiente'
}

function countResumen(items: Array<{ estado: ItemEstado }>) {
  const actionable = items.filter(i => i.estado !== 'rechazado')
  const resueltos  = actionable.filter(i => ESTADOS_RESUELTOS.includes(i.estado)).length
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

  // Historial de transiciones de un ítem (timeline de trazabilidad).
  // Devuelve los eventos CRUDOS en orden cronológico ASC (el front muestra el
  // más reciente como "actual"). El nombre del usuario lo resuelve el front con
  // usePerfilesMap: user_id -> auth.users, no hay FK a profiles para embeber.
  // El obra-scope lo valida `requireItemObraScope` en el route (no se duplica).
  async getItemEventos(itemId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_item_eventos')
      .select('*')
      .eq('item_id', itemId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    if (error) throw new Error(error.message)
    return data ?? []
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

    const { data: itemsCreados, error: itemsErr } = await supabase
      .from('solicitud_compra_item')
      .insert(itemsData)
      .select('id, cantidad')
    if (itemsErr) throw new Error(itemsErr.message)

    // Evento 'creado': arranca el timeline de trazabilidad de cada ítem.
    for (const it of itemsCreados ?? []) {
      await registrarItemEvento(supabase, {
        itemId:      it.id,
        solicitudId: solicitud.id,
        accion:      'creado',
        estadoNuevo: 'pendiente',
        cantidad:    it.cantidad,
        userId,
      })
    }

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
          const { data: nuevo, error: insErr } = await supabase
            .from('solicitud_compra_item').insert(row).select('id, cantidad').maybeSingle()
          if (insErr) throw new Error(`Error insertando ítem: ${insErr.message}`)
          if (nuevo) {
            await registrarItemEvento(supabase, {
              itemId:      nuevo.id,
              solicitudId: id,
              accion:      'creado',
              estadoNuevo: 'pendiente',
              cantidad:    nuevo.cantidad,
              userId,
            })
          }
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
    // Vía supabaseAdmin: es SECURITY DEFINER y la migración 20260527 revocó
    // EXECUTE para `authenticated` (rol efectivo del token client). Ver P0.
    const { data, error } = await supabaseAdmin.rpc('eliminar_solicitud', {
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
    // en_proveedor: la RPC hace el cambio de estado; el evento se escribe
    // acá best-effort (pendiente de mover adentro de la RPC — plan #2 B2).
    if (dto.queda_en_proveedor) {
      const item = await this.comprarItemEnProveedor(itemId, dto, token, userId)
      await registrarItemEvento(createSupabaseClient(token), {
        itemId,
        solicitudId:    (item as any)?.solicitud_id ?? null,
        accion:         'en_proveedor',
        estadoAnterior: 'pendiente',
        estadoNuevo:    'en_proveedor',
        cantidad:       dto.cantidad_comprada ?? null,
        meta: {
          proveedor_id:       dto.proveedor_id,
          precio_unit:        dto.precio_unit,
          factura_id:         dto.factura_id ?? null,
          pagado_por:         dto.pagado_por ?? 'cadinc',
          queda_en_proveedor: true,
        },
        userId,
      })
      return item
    }

    // Camino RPC: el evento 'comprado' lo escribe la RPC DENTRO de la TX
    // (atómico). No escribir acá para no duplicar.
    if (useRpcResolver()) {
      return await this.comprarItemViaRPC(itemId, dto, token, userId)
    }

    // Camino legacy: escribe su propio evento al final del método.
    return await this.comprarItemLegacy(itemId, dto, token, userId)
  },

  // RPC `resolver_item_en_proveedor`: marca item='en_proveedor' + suma
  // entrada en stock_proveedor_movimientos. NO inserta en MCC todavía
  // (la facturación al cliente espera al retiro real, decisión B).
  async comprarItemEnProveedor(itemId: number, dto: ComprarItemDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { error } = await supabaseAdmin.rpc('resolver_item_en_proveedor', {
      p_item_id:      itemId,
      p_proveedor_id: dto.proveedor_id,
      p_precio_unit:  dto.precio_unit,
      p_factura_id:   dto.factura_id ?? null,
      p_user_id:      userId,
    })
    if (error) throw mapRpcError(error)

    // Post-RPC: persistir `pagado_por` y `cantidad_comprada` en el item (la
    // RPC no acepta esos params aún). Cuando se retire del proveedor,
    // _registrarMaterialCliente lee del item y usa COALESCE(cantidad_comprada,
    // cantidad) al insertar el MCC.
    const itemPatch: Record<string, unknown> = {}
    if (dto.pagado_por === 'cliente') itemPatch.pagado_por = 'cliente'
    if (dto.cantidad_comprada != null) itemPatch.cantidad_comprada = dto.cantidad_comprada
    if (Object.keys(itemPatch).length > 0) {
      await supabase.from('solicitud_compra_item').update(itemPatch).eq('id', itemId)
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
    // Camino RPC: el evento 'despachado' lo escribe la RPC DENTRO de la TX.
    // Camino legacy: lo escribe al final del método. Sin doble escritura.
    return useRpcResolver()
      ? await this.despacharItemViaRPC(itemId, dto, token, userId, forzarSinStock)
      : await this.despacharItemLegacy(itemId, dto, token, userId, forzarSinStock)
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
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { error } = await supabaseAdmin.rpc('resolver_item_compra', {
      p_item_id:           itemId,
      p_proveedor_id:      dto.proveedor_id,
      p_precio_unit:       dto.precio_unit,
      p_factura_id:        dto.factura_id ?? null,
      p_user_id:           userId,
      p_pagado_por:        dto.pagado_por ?? 'cadinc',
      p_cantidad_comprada: dto.cantidad_comprada ?? null,
    })
    if (error) throw mapRpcError(error)
    // La RPC registra item + materiales_a_cuenta_cliente (con pagado_por y
    // cantidad efectiva) + el evento del timeline, todo DENTRO de la
    // transacción. No hay parches post-RPC ni doble registro.

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
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { error } = await supabaseAdmin.rpc('resolver_item_despacho', {
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
        estado:            'comprado',
        proveedor_id:      dto.proveedor_id,
        precio_unit:       dto.precio_unit,
        factura_id:        dto.factura_id ?? null,
        fecha_resolucion:  new Date().toISOString().slice(0, 10),
        pagado_por:        dto.pagado_por ?? 'cadinc',
        cantidad_comprada: dto.cantidad_comprada ?? null,
      })
      .eq('id', itemId)
      .eq('estado', 'pendiente')
      .select('*, solicitud_compra(id, obra_cod)')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o ya fue procesado')

    // NOTA: comprar = pedido al proveedor, el material todavía no llegó.
    // Para destino depósito, el stock NO entra acá — entra al RECIBIR
    // (cuando se marca enviado vía remito, ver remitos-envio.service).
    // Acá solo se registra la compra.
    await this._registrarMaterialCliente(itemId, data.solicitud_id, token, userId)

    // Evento del timeline (el camino RPC lo escribe adentro de la TX; acá,
    // en legacy, es best-effort). cantidad = la comprada si difiere.
    await registrarItemEvento(supabase, {
      itemId,
      solicitudId:    data.solicitud_id ?? null,
      accion:         'comprado',
      estadoAnterior: 'pendiente',
      estadoNuevo:    'comprado',
      cantidad:       data.cantidad_comprada ?? data.cantidad ?? null,
      meta: {
        proveedor_id:       dto.proveedor_id,
        precio_unit:        dto.precio_unit,
        factura_id:         dto.factura_id ?? null,
        pagado_por:         dto.pagado_por ?? 'cadinc',
        queda_en_proveedor: false,
      },
      userId,
    })
    return data
  },

  // El legacy nunca validó saldo — siempre permitía quedar en negativo.
  // El parámetro `forzarSinStock` no cambia el comportamiento del despacho
  // (el legacy no valida saldo), pero se registra en el evento del timeline.
  async despacharItemLegacy(
    itemId: number,
    dto: DespacharItemDto,
    token: string,
    userId: string,
    forzarSinStock: boolean = false,
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

    // Evento del timeline (el camino RPC lo escribe adentro de la TX; acá,
    // en legacy, es best-effort).
    await registrarItemEvento(supabase, {
      itemId,
      solicitudId:    data.solicitud_id ?? null,
      accion:         'despachado',
      estadoAnterior: 'pendiente',
      estadoNuevo:    'de_deposito',
      cantidad:       data.cantidad ?? null,
      meta:           { precio_unit: dto.precio_unit, forzar_sin_stock: forzarSinStock },
      userId,
    })
    return data
  },

  async enviarItem(itemId: number, fechaEnvio: string | undefined, token: string, userId?: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:     'enviado',
        fecha_envio: fechaEnvio ?? new Date().toISOString().slice(0, 10),
      })
      .eq('id', itemId)
      // 'retirado' = traído del proveedor, listo para enviar (flujo §5.8).
      .in('estado', ['comprado', 'de_deposito', 'retirado'])
      .select()
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o no está listo para enviar')
    await registrarItemEvento(supabase, {
      itemId,
      solicitudId: data.solicitud_id ?? null,
      accion:      'enviado',
      estadoNuevo: 'enviado',
      cantidad:    data.cantidad ?? null,
      meta:        { fecha_envio: data.fecha_envio },
      userId:      userId ?? null,
    })
    return data
  },

  async rechazarItem(itemId: number, token: string, userId?: string) {
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
    await registrarItemEvento(supabase, {
      itemId,
      solicitudId:    data.solicitud_id ?? null,
      accion:         'rechazado',
      estadoAnterior: 'pendiente',
      estadoNuevo:    'rechazado',
      userId:         userId ?? null,
    })
    return data
  },

  async revertirItem(itemId: number, token: string, userId?: string) {
    const supabase = createSupabaseClient(token)
    // Estado previo (entre comprado/de_deposito/rechazado) para la traza.
    const { data: prev } = await supabase
      .from('solicitud_compra_item').select('estado').eq('id', itemId).maybeSingle()
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({
        estado:            'pendiente',
        proveedor_id:      null,
        precio_unit:       null,
        factura_id:        null,
        fecha_resolucion:  null,
        fecha_envio:       null,
        cantidad_comprada: null,
      })
      .eq('id', itemId)
      .in('estado', ['comprado', 'de_deposito', 'rechazado'])
      .select()
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('Ítem no encontrado o no se puede revertir')

    // Revertir los movimientos de stock que generó la resolución:
    //  - despacho de depósito → 'salida' (hay que reponer)
    //  - compra a obra depósito → 'entrada' (hay que descontar)
    // Se reversan por la cantidad EFECTIVAMENTE movida (stock_movimientos.cantidad)
    // y se borran, para no dejar stock_actual descuadrado ni movimientos
    // huérfanos. (rechazado → pendiente nunca generó movimientos: no-op.)
    // Cubre los dos caminos (legacy y RPC), ambos taggean solicitud_item_id.
    const { data: movs } = await supabase
      .from('stock_movimientos')
      .select('id, material_id, tipo, cantidad')
      .eq('solicitud_item_id', itemId)
    for (const mov of movs ?? []) {
      if (mov.material_id != null) {
        const { data: mat } = await supabase
          .from('stock_materiales')
          .select('stock_actual')
          .eq('id', mov.material_id)
          .maybeSingle()
        if (mat) {
          const delta = mov.tipo === 'entrada' ? -Number(mov.cantidad) : Number(mov.cantidad)
          await supabase
            .from('stock_materiales')
            .update({ stock_actual: Number(mat.stock_actual) + delta })
            .eq('id', mov.material_id)
        }
      }
      await supabase.from('stock_movimientos').delete().eq('id', mov.id)
    }

    // Borrar registro de materiales_a_cuenta_cliente si existía
    await supabase.from('materiales_a_cuenta_cliente').delete().eq('item_id', itemId)

    await registrarItemEvento(supabase, {
      itemId,
      solicitudId:    data.solicitud_id ?? null,
      accion:         'revertido',
      estadoAnterior: prev?.estado ?? null,
      estadoNuevo:    'pendiente',
      userId:         userId ?? null,
    })
    return data
  },

  // Deshace SOLO el envío de un item (estado='enviado'). Lo devuelve a su
  // estado previo (comprado o de_deposito según cómo se resolvió la compra),
  // limpia fecha_envio y lo desvincula del remito_envio. Si el remito queda
  // sin items, lo borra (era un remito de un solo item, ya huérfano).
  //
  // NO toca proveedor/precio/factura ni el MCC: la compra/despacho se mantiene.
  // Para deshacer también la compra, el usuario usa `revertir` desde el estado
  // resultante (comprado/de_deposito → pendiente).
  async revertirEnvioItem(itemId: number, token: string, userId?: string) {
    const supabase = createSupabaseClient(token)

    // 1) Validar que esté enviado y determinar el estado previo.
    const { data: item, error: selErr } = await supabase
      .from('solicitud_compra_item')
      .select('id, estado, proveedor_id')
      .eq('id', itemId)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)
    if (!item || item.estado !== 'enviado') {
      throw new Error('Ítem no encontrado o no está enviado')
    }
    // Estado al que vuelve el ítem al deshacer el envío. Se deriva del último
    // evento de resolución en el timeline (fuente de verdad de la máquina de
    // estados), no de proveedor_id: inferir por proveedor rompía dos casos —
    //   (a) un ítem retirado-de-proveedor (§5.8) tiene proveedor_id y volvía a
    //       'comprado' en vez de 'retirado', huerfanando su MCC/stock proveedor;
    //   (b) un ítem despachado al que el comprador le agregó proveedor_id como
    //       corrección volvía a 'comprado' en vez de 'de_deposito'.
    // Fallback a la inferencia vieja para ítems previos a los eventos (<2026-05-30).
    const RESUELTOS = ['comprado', 'de_deposito', 'retirado']
    const { data: ev } = await supabase
      .from('solicitud_item_eventos')
      .select('estado_nuevo')
      .eq('item_id', itemId)
      .in('estado_nuevo', RESUELTOS)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    const estadoPrevio = ev?.estado_nuevo ?? (item.proveedor_id != null ? 'comprado' : 'de_deposito')

    // 2) Desvincular del remito y borrar el remito si queda vacío.
    const { data: reItems } = await supabase
      .from('remitos_envio_item')
      .select('remito_id')
      .eq('item_id', itemId)
    const remitoIds = [...new Set((reItems ?? []).map(r => r.remito_id))]

    await supabase.from('remitos_envio_item').delete().eq('item_id', itemId)

    for (const remitoId of remitoIds) {
      const { count } = await supabase
        .from('remitos_envio_item')
        .select('id', { count: 'exact', head: true })
        .eq('remito_id', remitoId)
      if ((count ?? 0) === 0) {
        await supabase.from('remitos_envio').delete().eq('id', remitoId)
      }
    }

    // 3) Volver el item a su estado previo, limpiar fecha_envio.
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .update({ estado: estadoPrevio, fecha_envio: null })
      .eq('id', itemId)
      .eq('estado', 'enviado')
      .select('*, solicitud_compra(id, obra_cod)')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('No se pudo revertir el envío')

    // Si era una compra a depósito, el stock ingresó al RECIBIR (este envío).
    // Al deshacer, ese ingreso se revierte: el material vuelve a "comprado,
    // por llegar". Solo se tocan los movimientos entrada/compra del ítem; los
    // de despacho (salida) NO, porque el material ya había salido del depósito
    // al despacharse y el ítem vuelve a 'de_deposito' (sigue por enviar).
    const { data: movsEntrada } = await supabase
      .from('stock_movimientos')
      .select('id, material_id, cantidad')
      .eq('solicitud_item_id', itemId)
      .eq('tipo', 'entrada')
      .eq('motivo', 'compra')
    for (const mov of movsEntrada ?? []) {
      if (mov.material_id != null) {
        const { data: mat } = await supabase
          .from('stock_materiales').select('stock_actual').eq('id', mov.material_id).maybeSingle()
        if (mat) {
          await supabase
            .from('stock_materiales')
            .update({ stock_actual: Number(mat.stock_actual) - Number(mov.cantidad) })
            .eq('id', mov.material_id)
        }
      }
      await supabase.from('stock_movimientos').delete().eq('id', mov.id)
    }

    await registrarItemEvento(supabase, {
      itemId,
      solicitudId:    (data as any).solicitud_id ?? null,
      accion:         'envio_revertido',
      estadoAnterior: 'enviado',
      estadoNuevo:    estadoPrevio,
      userId:         userId ?? null,
    })
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
      // Recalcular con la cantidad EFECTIVA (la comprada si difiere de la
      // solicitada), igual que _registrarMaterialCliente. Antes usaba
      // data.cantidad (solicitada) y descuadraba el precio_total del MCC
      // cuando cantidad_comprada != cantidad.
      const cantidadEfectiva = data.cantidad_comprada ?? data.cantidad
      updates.precio_unit = dto.precio_unit
      updates.precio_total = cantidadEfectiva * dto.precio_unit
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

    // Cantidad efectiva: la comprada si difiere de la solicitada, si no la solicitada.
    const cantidadEfectiva = item.cantidad_comprada ?? item.cantidad

    const registro = {
      obra_cod:         sol.obra_cod,
      solicitud_id:     solicitudId,
      item_id:          item.id,
      descripcion:      item.descripcion,
      cantidad:         cantidadEfectiva,
      unidad:           item.unidad,
      precio_unit:      item.precio_unit ?? 0,
      precio_total:     cantidadEfectiva * (item.precio_unit ?? 0),
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
