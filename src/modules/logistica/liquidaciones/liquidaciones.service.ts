import type { PostgrestError } from '@supabase/supabase-js'
import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateLiquidacionDto, UpdateLiquidacionDto, CreateAdelantoDto, UpdateAdelantoDto } from './liquidaciones.schema.js'

// Mapeo mínimo de errores de RPC (reabrir/eliminar). Usa la misma forma
// de HttpError que solicitudes.service: status numérico + code + detail.
export class LiqHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'LiqHttpError'
  }
}

function mapLiqRpcError(error: PostgrestError): LiqHttpError {
  const msg = error.message || ''
  const code =
    /NO_AUTH/.test(msg)                   ? 'NO_AUTH' :
    /SIN_PERFIL/.test(msg)                ? 'SIN_PERFIL' :
    /SIN_PERMISO/.test(msg)               ? 'SIN_PERMISO' :
    /LIQUIDACION_NO_EXISTE/.test(msg)     ? 'LIQUIDACION_NO_EXISTE' :
    /LIQUIDACION_YA_EN_BORRADOR/.test(msg) ? 'LIQUIDACION_YA_EN_BORRADOR' :
    error.code || 'UNKNOWN'

  switch (code) {
    case 'NO_AUTH':                     return new LiqHttpError(401, code)
    case 'SIN_PERFIL':                  return new LiqHttpError(403, code)
    case 'SIN_PERMISO':                 return new LiqHttpError(403, code, error.details ?? undefined)
    case 'LIQUIDACION_NO_EXISTE':       return new LiqHttpError(404, code)
    case 'LIQUIDACION_YA_EN_BORRADOR':  return new LiqHttpError(409, code)
    default:                            return new LiqHttpError(500, 'DB_ERROR', { dbMessage: msg })
  }
}

export const liquidacionesService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('liquidaciones')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async getAdelantos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('adelantos')
      .select('*')
      .order('fecha', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateLiquidacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Delegamos al RPC transaccional — garantiza que si algún vínculo
    // falla (tramo/adelanto/gasto no valido), nada se persiste y la
    // liquidación no queda a medio crear. Ver migración 20260423_liquidaciones_reintegros.
    const { data, error } = await supabase.rpc('create_liquidacion_con_reintegros', {
      p_chofer_id:        dto.chofer_id,
      p_fecha_desde:      dto.fecha_desde,
      p_fecha_hasta:      dto.fecha_hasta,
      p_dias_trabajados:  dto.dias_trabajados,
      p_basico_dia:       dto.basico_dia,
      p_km_totales:       dto.km_totales ?? 0,
      p_precio_km:        dto.precio_km ?? 0,
      p_subtotal_basico:  dto.subtotal_basico,
      p_subtotal_km:      dto.subtotal_km ?? 0,
      p_total_adelantos:  dto.total_adelantos,
      p_total_reintegros: dto.total_reintegros ?? 0,
      p_total_neto:       dto.total_neto,
      p_obs:              dto.obs ?? '',
      p_tramo_ids:        dto.tramo_ids ?? [],
      p_adelanto_ids:     dto.adelanto_ids ?? [],
      p_gasto_ids:        dto.gasto_ids ?? [],
      p_user_id:          userId,
    })
    if (error) {
      const err = new Error(error.message) as Error & { code?: string; detail?: string | null }
      // Pasar el mensaje tal cual — el route lo mapea por texto.
      // Conserva el detail (JSON con esperados/encontrados/ids) para debug.
      err.detail = error.details ?? null
      throw err
    }
    // Las RPCs que retornan un row suelen devolverlo como objeto único.
    return data
  },

  async update(id: number, dto: UpdateLiquidacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('liquidaciones')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async cerrar(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Al cerrar, los gastos vinculados (pagado_por='chofer') transicionan
    // 'aprobado' → 'pagado'. Semánticamente el chofer acaba de recibir
    // el reintegro como parte de esta liquidación.
    const { error: eGas } = await supabase
      .from('gastos_logistica')
      .update({ estado: 'pagado', updated_by: userId })
      .eq('liquidacion_id', id)
      .eq('estado', 'aprobado')  // idempotente: si ya estaban pagados por otro camino, no se tocan
    if (eGas) throw new Error(eGas.message)

    const { data, error } = await supabase
      .from('liquidaciones')
      .update({ estado: 'cerrada', updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async reabrir(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // RPC transaccional: desliga tramos/adelantos/gastos y pone estado='borrador'
    // atómicamente con FOR UPDATE. Migración 20260424_rpc_reabrir_eliminar_liquidacion.
    const { data, error } = await supabase.rpc('reabrir_liquidacion', {
      p_liquidacion_id: id,
      p_user_id:        userId,
    })
    if (error) throw mapLiqRpcError(error)

    // Para mantener el shape del endpoint (el frontend espera la liquidación
    // actualizada, no el conteo), hacemos un getById post-RPC.
    const { data: liq, error: selErr } = await supabase
      .from('liquidaciones')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)
    return liq ?? data
  },

  async delete(id: number, token: string, userId?: string) {
    const supabase = createSupabaseClient(token)
    // RPC transaccional: desliga children y borra.
    const { data, error } = await supabase.rpc('eliminar_liquidacion', {
      p_liquidacion_id: id,
      p_user_id:        userId ?? null,
    })
    if (error) throw mapLiqRpcError(error)
    return data as {
      success: boolean
      liquidacion_id: number
      tramos_desligados: number
      adelantos_desligados: number
      gastos_revertidos: number
    }
  },

  async createAdelanto(dto: CreateAdelantoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('adelantos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateAdelanto(id: number, dto: UpdateAdelantoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('adelantos')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteAdelanto(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('adelantos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
