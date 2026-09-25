/**
 * Reportes contables (20260926f): libro diario, mayor y sumas y saldos. Son
 * RPC que devuelven UN jsonb (una sola fila de PostgREST: el tope de 1000
 * filas no aplica) y paginan adentro. Acá solo se agregan limit/offset/hasMore.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ContabilidadHttpError } from './contabilidad.errors.js'
import { rpc } from './comun.js'
import { esBoolQ, type BalanceQuery, type DiarioQuery, type MayorQuery, type ResultadosQuery, type SumasSaldosQuery } from './contabilidad.schema.js'

function rango(desde: string, hasta: string): void {
  if (desde > hasta) throw new ContabilidadHttpError(400, 'RANGO_INVALIDO', { campo: 'desde', desde, hasta })
}

export const reportesService = {
  async diario(q: DiarioQuery, db: SupabaseClient = supabase) {
    rango(q.desde, q.hasta)
    if (q.modo === 'dia' || q.modo === 'mes') {
      // Resumido (20260928i): los automáticos agrupados por circuito y período.
      const rr = await rpc<{ total_items: number; items: unknown[] } & Record<string, unknown>>(db, 'cont_libro_diario_resumido', {
        p_desde: q.desde, p_hasta: q.hasta, p_agrupar: q.modo, p_limit: q.limit, p_offset: q.offset,
      })
      const its = rr?.items ?? []
      return { ...rr, modo: q.modo, items: its, limit: q.limit, offset: q.offset, hasMore: q.offset + its.length < Number(rr?.total_items ?? 0) }
    }
    const r = await rpc<{ total_asientos: number; items: unknown[] } & Record<string, unknown>>(db, 'cont_libro_diario', {
      p_desde: q.desde, p_hasta: q.hasta, p_limit: q.limit, p_offset: q.offset,
    })
    const items = r?.items ?? []
    return { ...r, modo: 'detallado' as const, items, limit: q.limit, offset: q.offset, hasMore: q.offset + items.length < Number(r?.total_asientos ?? 0) }
  },

  async mayor(q: MayorQuery, db: SupabaseClient = supabase) {
    rango(q.desde, q.hasta)
    const r = await rpc<{ total_movimientos: number; items: unknown[] } & Record<string, unknown>>(db, 'cont_mayor', {
      p_cuenta_id: q.cuenta_id, p_desde: q.desde, p_hasta: q.hasta,
      p_obra_cod: q.obra_cod ?? null, p_aux_id: q.aux_id ?? null,
      p_limit: q.limit, p_offset: q.offset,
    })
    const items = r?.items ?? []
    return { ...r, items, limit: q.limit, offset: q.offset, hasMore: q.offset + items.length < Number(r?.total_movimientos ?? 0) }
  },

  async sumasSaldos(q: SumasSaldosQuery, db: SupabaseClient = supabase) {
    rango(q.desde, q.hasta)
    return rpc<Record<string, unknown>>(db, 'cont_sumas_saldos', {
      p_desde: q.desde, p_hasta: q.hasta, p_nivel: q.nivel ?? null,
      p_incluir_sin_movimiento: esBoolQ(q.incluir_sin_movimiento),
    })
  },

  /** Estado de situación patrimonial a una fecha (20260928j). */
  async balance(q: BalanceQuery, db: SupabaseClient = supabase) {
    return rpc<Record<string, unknown>>(db, 'cont_balance', {
      p_fecha: q.fecha, p_nivel: q.nivel, p_incluir_cero: esBoolQ(q.incluir_cero),
    })
  },

  /** Estado de resultados de un rango, opcionalmente por mes (20260928j). */
  async resultados(q: ResultadosQuery, db: SupabaseClient = supabase) {
    rango(q.desde, q.hasta)
    return rpc<Record<string, unknown>>(db, 'cont_estado_resultados', {
      p_desde: q.desde, p_hasta: q.hasta, p_nivel: q.nivel,
      p_comparativo: esBoolQ(q.comparativo), p_incluir_cero: esBoolQ(q.incluir_cero),
    })
  },
}
