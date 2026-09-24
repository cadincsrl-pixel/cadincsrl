/**
 * Imputar las facturas importadas de ARCA (20260927b): les falta el concepto
 * y el reparto por obra. Hasta imputarlas no se aprueban ni se pagan
 * (FACTURA_SIN_IMPUTAR en `pagos_aprobar_factura` y `_pagos_validar_pagable`).
 *
 *   - Una: `pagos_imputar_factura` con el reparto (Σ = total − percepciones).
 *   - Lote: `pagos_imputar_lote`, un concepto y UNA obra al 100 %, todo o nada.
 *
 * Con «otros tributos» de ARCA sin clasificar no se imputa
 * (TRIBUTOS_A_REVISAR): lo imputable depende de las percepciones, que hay que
 * clasificar primero con «Completar desglose».
 */
import { supabase } from '../../lib/supabase.js'
import { PagosHttpError, mapRpcError } from './pagos.errors.js'
import { enmascararRespuesta, validarImportes } from './pagos.service.js'
import { aCentavos } from './pagos.util.js'
import type { ImputarFacturaDto, ImputarLoteDto } from './pagos.schema.js'

interface FilaImputable {
  id: number; estado: string; fecha: string; total: number | string; percepciones: number | string | null
  sin_imputar: boolean; tributos_a_revisar: boolean
}

const COLS = 'id, estado, fecha, total, percepciones, sin_imputar, tributos_a_revisar'

/** Las precondiciones de la RPC, adelantadas (la RPC las repite con FOR UPDATE). */
export function controlarImputable(f: FilaImputable | null | undefined, id: number): FilaImputable {
  if (!f) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: id })
  if (f.estado === 'anulada') throw new PagosHttpError(409, 'FACTURA_CERRADA', { factura_id: id })
  if (!f.sin_imputar) throw new PagosHttpError(409, 'FACTURA_YA_IMPUTADA', { factura_id: id })
  if (f.tributos_a_revisar) throw new PagosHttpError(409, 'TRIBUTOS_A_REVISAR', { factura_id: id })
  return f
}

export const imputarService = {
  async imputar(id: number, dto: ImputarFacturaDto, userId: string, verPii: boolean) {
    const { data, error } = await supabase.from('pagos_facturas').select(COLS).eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    const f = controlarImputable(data as FilaImputable | null, id)
    // Sin obra repetida y Σ reparto = total − percepciones (±0,01), con el campo.
    validarImportes({ fecha: f.fecha, total: Number(f.total), percepciones: f.percepciones == null ? null : Number(f.percepciones) },
      dto.imputaciones, { validarFecha: false })
    const r = await supabase.rpc('pagos_imputar_factura', {
      p_factura_id:   id,
      p_concepto_id:  dto.concepto_id,
      p_imputaciones: dto.imputaciones.map((i) => ({ obra_cod: i.obra_cod, monto: aCentavos(i.monto), obs: i.obs ?? '' })),
      p_descripcion:  dto.descripcion ?? null,
      p_user_id:      userId,
    })
    if (r.error) throw mapRpcError(r.error)
    console.info(`[pagos] factura ${id} imputada (concepto ${dto.concepto_id}, ${dto.imputaciones.length} obra(s)) por ${userId}`)
    return enmascararRespuesta((r.data ?? {}) as { factura?: Record<string, unknown> }, verPii)
  },

  async imputarLote(dto: ImputarLoteDto, userId: string) {
    const ids = [...new Set(dto.ids)].sort((a, b) => a - b)
    const { data, error } = await supabase.from('pagos_facturas').select(COLS).in('id', ids)
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    const porId = new Map(((data ?? []) as FilaImputable[]).map((f) => [Number(f.id), f]))
    for (const id of ids) controlarImputable(porId.get(id), id)
    const r = await supabase.rpc('pagos_imputar_lote', {
      p_ids: ids, p_concepto_id: dto.concepto_id, p_obra_cod: dto.obra_cod, p_user_id: userId,
    })
    if (r.error) throw mapRpcError(r.error)
    console.info(`[pagos] ${ids.length} factura(s) imputadas en lote a ${dto.obra_cod} (concepto ${dto.concepto_id}) por ${userId}`)
    return (r.data ?? { imputadas: 0, ids: [] }) as { imputadas: number; ids: number[] }
  },
}
