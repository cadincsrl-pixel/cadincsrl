/**
 * Movimientos de fondos sin factura (tanda 5, 20260928l/m): comisiones
 * bancarias, impuesto al cheque, VEP, sueldos, retiros y aportes de socios,
 * transferencias entre cuentas propias… Tab `tesoreria`, flag
 * `movimientos_fondos` (default false).
 *
 * Todo lo que escribe pasa por RPC (`tesoreria_guardar_movimiento`,
 * `tesoreria_anular_movimiento`, `tesoreria_guardar_concepto`), que vuelven a
 * chequear el flag y validan monedas, cotización, cuentas activas, concepto
 * compatible con el tipo y período abierto; el trigger
 * `fn_tesoreria_mov_consistente` pisa `importe_ars`. El asiento NO se crea
 * acá: el movimiento es un circuito más del motor (`tesoreria_movimientos`,
 * circuito «fondos») y se contabiliza desde Automáticos.
 *
 * No hay DELETE: se anula. Anular un movimiento de un mes cerrado está
 * permitido; el motor genera el contraasiento en el primer día abierto.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { rpc, pagina, aCentavos } from './comun.js'
import { fondosAdjuntosService, type TesAdjunto } from './fondos-adjuntos.service.js'
import type {
  TesConceptoDto, TesMovimientoDto, TesMovimientosQuery, UpdateTesConceptoDto,
} from './contabilidad.schema.js'

export type TesMovimiento = Record<string, unknown> & { id: number; numero: number; estado: 'vigente' | 'anulado' }
export interface TesMovimientosRes {
  items: TesMovimiento[]; total: number; limit: number; offset: number; hasMore: boolean
  totales: { ingresos: number; egresos: number; transferencias: number }
}
export interface TesConcepto {
  id: number; nombre: string; sentido: 'ingreso' | 'egreso' | 'ambos'; orden: number; activo: boolean; obs: string
  en_uso: number; cuenta_id: number | null; cuenta_codigo: string | null; cuenta_nombre: string | null
}

/** «MF-000123»: como se muestra el número de un movimiento. */
export const numeroMovimiento = (n: number) => `MF-${String(n).padStart(6, '0')}`

/**
 * El jsonb que recibe `tesoreria_guardar_movimiento`. Normaliza vacíos a null
 * e importes a centavos; no decide nada de monedas (eso es de la base).
 */
export function movimientoParaRpc(dto: TesMovimientoDto, id?: number): Record<string, unknown> {
  const transferencia = dto.tipo === 'transferencia'
  const obra = dto.obra_cod?.trim() || null
  return {
    ...(id != null ? { id } : {}),
    fecha: dto.fecha,
    tipo: dto.tipo,
    tesoreria_id: dto.tesoreria_id,
    tesoreria_destino_id: transferencia ? (dto.tesoreria_destino_id ?? null) : null,
    concepto_id: transferencia ? null : (dto.concepto_id ?? null),
    importe: aCentavos(dto.importe),
    importe_destino: dto.importe_destino != null ? aCentavos(dto.importe_destino) : null,
    cotizacion: dto.cotizacion ?? null,
    obra_cod: transferencia ? null : obra,
    referencia: (dto.referencia ?? '').trim(),
    obs: (dto.obs ?? '').trim(),
  }
}

/** Totales en ARS que devuelve la RPC, con ceros si falta alguno. */
export function totalesDe(t: unknown): TesMovimientosRes['totales'] {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
  return { ingresos: Number(o.ingresos ?? 0), egresos: Number(o.egresos ?? 0), transferencias: Number(o.transferencias ?? 0) }
}

export const fondosService = {
  async listar(q: TesMovimientosQuery, db: SupabaseClient = supabase): Promise<TesMovimientosRes> {
    if (q.desde && q.hasta && q.desde > q.hasta) throw new ContabilidadHttpError(400, 'RANGO_INVALIDO', { campo: 'desde', desde: q.desde, hasta: q.hasta })
    const r = await rpc<{ total?: number; totales?: unknown; items?: TesMovimiento[] } | null>(db, 'tesoreria_movimientos_listar', {
      p_desde: q.desde ?? null, p_hasta: q.hasta ?? null, p_tipo: q.tipo ?? null,
      p_tesoreria_id: q.tesoreria_id ?? null, p_concepto_id: q.concepto_id ?? null, p_obra_cod: q.obra_cod ?? null,
      p_estado: !q.estado || q.estado === 'todos' ? null : q.estado,
      p_origen: q.origen ?? null, p_q: q.q || null, p_limit: q.limit, p_offset: q.offset,
    })
    const items = r?.items ?? []
    return { ...pagina(items, Number(r?.total ?? items.length), q.limit, q.offset), totales: totalesDe(r?.totales) }
  },

  async fila(id: number, db: SupabaseClient): Promise<TesMovimiento> {
    const { data, error } = await db.from('v_tesoreria_movimientos').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new ContabilidadHttpError(404, 'MOVIMIENTO_NO_EXISTE', { movimiento_id: id })
    return data as TesMovimiento
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<TesMovimiento & { adjuntos: TesAdjunto[] }> {
    const [mov, adjuntos] = await Promise.all([this.fila(id, db), fondosAdjuntosService.listar(id, db)])
    return { ...mov, adjuntos }
  },

  async crear(dto: TesMovimientoDto, userId: string, db: SupabaseClient = supabase): Promise<TesMovimiento> {
    const r = await rpc<TesMovimiento>(db, 'tesoreria_guardar_movimiento', { p_mov: movimientoParaRpc(dto), p_user_id: userId })
    console.info(`[contabilidad] movimiento de fondos ${r?.numero != null ? numeroMovimiento(r.numero) : '?'} (${dto.tipo}, $${dto.importe}) creado por ${userId}`)
    return r
  },

  async editar(id: number, dto: TesMovimientoDto, userId: string, db: SupabaseClient = supabase): Promise<TesMovimiento> {
    const r = await rpc<TesMovimiento>(db, 'tesoreria_guardar_movimiento', { p_mov: movimientoParaRpc(dto, id), p_user_id: userId })
    console.info(`[contabilidad] movimiento de fondos #${id} editado por ${userId}`)
    return r
  },

  async anular(id: number, motivo: string, userId: string, db: SupabaseClient = supabase): Promise<TesMovimiento> {
    const r = await rpc<TesMovimiento>(db, 'tesoreria_anular_movimiento', { p_id: id, p_motivo: motivo.trim(), p_user_id: userId })
    console.info(`[contabilidad] movimiento de fondos #${id} anulado por ${userId}: ${motivo.trim()}`)
    return r
  },

  // ── Conceptos ────────────────────────────────────────────────────────────

  /**
   * Conceptos con cuántos movimientos vigentes los usan y la cuenta del mapeo
   * `fondos.concepto` (subclave = id del concepto): `tesoreria_conceptos_listar`.
   */
  async conceptos(incluirInactivos: boolean, db: SupabaseClient = supabase): Promise<TesConcepto[]> {
    const r = await rpc<TesConcepto[] | null>(db, 'tesoreria_conceptos_listar', { p_incluir_inactivos: incluirInactivos })
    return r ?? []
  },

  async crearConcepto(dto: TesConceptoDto, userId: string, db: SupabaseClient = supabase): Promise<TesConcepto> {
    const r = await rpc<TesConcepto>(db, 'tesoreria_guardar_concepto', {
      p_concepto: { nombre: dto.nombre.trim(), sentido: dto.sentido, orden: dto.orden ?? 0, activo: dto.activo ?? true, obs: (dto.obs ?? '').trim() },
      p_user_id: userId,
    }, { unicoComo: 'CONCEPTO_DUPLICADO' })
    console.info(`[contabilidad] concepto de fondos «${dto.nombre.trim()}» creado por ${userId}`)
    return r
  },

  /** Edición parcial: se completa con lo guardado y va el concepto entero (la RPC lo devuelve con uso y cuenta). */
  async editarConcepto(id: number, dto: UpdateTesConceptoDto, userId: string, db: SupabaseClient = supabase): Promise<TesConcepto> {
    const { data, error } = await db.from('tesoreria_conceptos').select('id, nombre, sentido, orden, activo, obs').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new ContabilidadHttpError(404, 'CONCEPTO_NO_EXISTE', { concepto_id: id })
    const a = data as { nombre: string; sentido: string; orden: number; activo: boolean; obs: string }
    return rpc<TesConcepto>(db, 'tesoreria_guardar_concepto', {
      p_concepto: {
        id, nombre: (dto.nombre ?? a.nombre).trim(), sentido: dto.sentido ?? a.sentido, orden: dto.orden ?? a.orden,
        activo: dto.activo ?? a.activo, obs: (dto.obs ?? a.obs ?? '').trim(),
      },
      p_user_id: userId,
    }, { unicoComo: 'CONCEPTO_DUPLICADO' })
  },
}
