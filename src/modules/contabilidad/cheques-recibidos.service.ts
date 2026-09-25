/**
 * Cartera de cheques recibidos (20260930f/n): la vista de Tesorería.
 *
 * Los cheques entran solos (cobros de Logística y de Ventas) o a mano. Acá se
 * listan con de dónde vinieron y a dónde fueron (v_cheques_recibidos) y se
 * cargan los que no pasaron por un cobro. La puerta de escritura es la misma
 * RPC de siempre (cheques_recibidos_registrar): no duplica y vincula los que
 * ya se endosaron.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { pagina } from './comun.js'
import type { ChequesRecibidosQuery, ChequeRecibidoAManoDto, ChequesCambiarEstadoDto } from './contabilidad.schema.js'

export const ESTADOS_CARTERA = ['en_cartera', 'endosado', 'depositado', 'rechazado', 'recuperado'] as const

export interface TotalesCartera {
  /** Por estado: cantidad e importe. `vencidos` = en cartera con la fecha de cobro pasada. */
  [estado: string]: { cantidad: number; importe: number }
}

export const chequesRecibidosService = {
  async listar(q: ChequesRecibidosQuery, db: SupabaseClient = supabase) {
    if (q.desde && q.hasta && q.desde > q.hasta) throw new ContabilidadHttpError(400, 'RANGO_INVALIDO', { campo: 'desde' })
    let s = db.from('v_cheques_recibidos').select('*', { count: 'exact' })
    if (q.estado === 'vencidos') s = s.eq('estado', 'en_cartera').eq('vencido', true)
    else if (q.estado === 'por_vencer') s = s.eq('estado', 'en_cartera').eq('vencido', false)
    else if (q.estado && q.estado !== 'todos') s = s.eq('estado', q.estado)
    if (q.origen) s = s.eq('origen', q.origen)
    if (q.desde) s = s.gte('fecha_cobro', q.desde)
    if (q.hasta) s = s.lte('fecha_cobro', q.hasta)
    if (q.q?.trim()) s = s.ilike('busq', `%${normTxt(q.q.trim())}%`)
    const { data, error, count } = await s
      .order('fecha_cobro', { ascending: true, nullsFirst: false }).order('id')
      .range(q.offset, q.offset + q.limit - 1)
    if (error) throw mapRpcError(error as PgError)
    return { ...pagina(data ?? [], count ?? 0, q.limit, q.offset), totales: await this.totales(db) }
  },

  /** Totales de TODA la cartera (no del filtro): lo que muestran las tarjetas de arriba. */
  async totales(db: SupabaseClient = supabase): Promise<TotalesCartera> {
    const filas = await todasLasFilas<{ estado: string; vencido: boolean; importe: number }>((d, h) =>
      db.from('v_cheques_recibidos').select('estado, vencido, importe').order('id').range(d, h))
    const t: TotalesCartera = {}
    const sumar = (k: string, imp: number) => {
      t[k] ??= { cantidad: 0, importe: 0 }
      t[k].cantidad += 1
      t[k].importe = Math.round((t[k].importe + imp) * 100) / 100
    }
    for (const f of filas) {
      sumar(f.estado, Number(f.importe))
      if (f.estado === 'en_cartera') sumar(f.vencido ? 'vencidos' : 'por_vencer', Number(f.importe))
    }
    return t
  },

  /**
   * Depositar / rechazar / recuperar / volver a cartera (20260930o). La RPC
   * valida la transición de cada cheque; todavía sin asiento (fase 4b).
   */
  async cambiarEstado(dto: ChequesCambiarEstadoDto, userId: string, db: SupabaseClient = supabase) {
    const { data, error } = await db.rpc('cheques_recibidos_cambiar_estado', {
      p_ids: dto.ids, p_accion: dto.accion, p_fecha: dto.fecha ?? null,
      p_tesoreria_id: dto.tesoreria_id ?? null, p_motivo: dto.motivo ?? null, p_user_id: userId,
    })
    if (error) throw mapRpcError(error as PgError)
    return data as { accion: string; cheques: number }
  },

  /** Alta a mano desde Tesorería: cheques que no pasaron por un cobro. */
  async altaManual(cheques: ChequeRecibidoAManoDto[], userId: string, db: SupabaseClient = supabase) {
    const { data, error } = await db.rpc('cheques_recibidos_registrar', {
      p_cobro_id: null, p_adjunto_id: null, p_user_id: userId, p_obs: 'Cargado a mano en Tesorería',
      p_cheques: cheques.map((c) => ({ ...c, numero: c.numero.replace(/\D/g, '') })),
    })
    if (error) throw mapRpcError(error as PgError)
    return data as { nuevos: number; ya_estaban: number; endosados: number; ya_estaban_numeros: string[] }
  },
}
