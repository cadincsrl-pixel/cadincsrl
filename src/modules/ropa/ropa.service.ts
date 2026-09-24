import { HTTPException } from 'hono/http-exception'
import { createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateCategoriaDto, UpdateCategoriaDto, CreateEntregaDto, CreateEntregasLoteDto,
  CreateEntregasTandaDto,
} from './ropa.schema.js'
import { filasDeEntrega } from './ropa.filas.js'

/** Hoy en hora Argentina (UTC−3). Mismo helper que usa gastos de logística. */
function hoyAR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * Una entrega con fecha futura NUNCA vence: el vencimiento se calcula sumándole
 * los meses de la categoría, así que queda todavía más adelante y la prenda
 * figura "al día" para siempre, invisible en el filtro de vencidos.
 *
 * Pasó de verdad: 9 entregas de la carga inicial quedaron con 10/12/2026 cuando
 * se habían cargado el 10/04/2026 (mes mal tipeado). Tres legajos llevan cinco
 * meses figurando al día. El front también lo bloquea (`max` en el input), esto
 * es el candado real.
 */
function exigirFechaNoFutura(fecha: string): void {
  const hoy = hoyAR()
  if (fecha > hoy) {
    throw new HTTPException(400, {
      message: `No se puede registrar una entrega con fecha futura (${fecha}). Hoy es ${hoy}.`,
    })
  }
}

export const ropaService = {

  // ── Categorías ──

  async createCategoria(dto: CreateCategoriaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('ropa_categorias')
      .insert({
        nombre:            dto.nombre,
        icono:             dto.icono ?? null,
        // meses_vencimiento es NOT NULL en DB; 0 = sin vencimiento programado.
        meses_vencimiento: dto.meses_vencimiento ?? 0,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCategoria(id: number, dto: UpdateCategoriaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('ropa_categorias')
      .update({ meses_vencimiento: dto.meses_vencimiento })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Soft delete: marca activo=false en vez de borrar (preserva FKs hacia
  // ropa_entregas que ya quedaron históricas).
  async deleteCategoria(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('ropa_categorias')
      .update({ activo: false })
      .eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Entregas ──

  async createEntrega(dto: CreateEntregaDto, token: string, userId: string) {
    exigirFechaNoFutura(dto.fecha_entrega)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('ropa_entregas')
      .insert({
        leg:           dto.leg,
        categoria_id:  dto.categoria_id,
        fecha_entrega: dto.fecha_entrega,
        obs:           dto.obs ?? null,
        cantidad:      dto.cantidad ?? 1,
        talle:         (dto.talle ?? '').trim(),
        created_by:    userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createEntregasLote(dto: CreateEntregasLoteDto, token: string, userId: string) {
    exigirFechaNoFutura(dto.fecha_entrega)
    const supabase = createSupabaseClient(token)
    const items = dto.items ?? (dto.categoria_ids ?? []).map(categoria_id => ({ categoria_id }))
    const filas = filasDeEntrega(dto.leg, items, dto.fecha_entrega, dto.obs, userId)
    const { data, error } = await supabase.from('ropa_entregas').insert(filas).select()
    if (error) throw new Error(error.message)
    return data ?? []
  },

  /** Entrega por obra: toda la tanda en un INSERT (todo o nada). */
  async createEntregasTanda(dto: CreateEntregasTandaDto, token: string, userId: string) {
    exigirFechaNoFutura(dto.fecha_entrega)
    const legs = dto.entregas.map(e => e.leg)
    if (new Set(legs).size !== legs.length) {
      throw new HTTPException(400, { message: 'Un trabajador aparece dos veces en la tanda' })
    }
    const supabase = createSupabaseClient(token)
    const { data: existen, error: e1 } = await supabase.from('personal').select('leg').in('leg', legs)
    if (e1) throw new Error(e1.message)
    const faltan = legs.filter(l => !(existen ?? []).some(p => p.leg === l))
    if (faltan.length) throw new HTTPException(400, { message: `Legajo inexistente: ${faltan.join(', ')}` })

    const filas = dto.entregas.flatMap(e => filasDeEntrega(e.leg, e.items, dto.fecha_entrega, dto.obs, userId))
    const { data, error } = await supabase.from('ropa_entregas').insert(filas).select()
    if (error) throw new Error(error.message)
    return data ?? []
  },

  async deleteEntrega(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('ropa_entregas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
