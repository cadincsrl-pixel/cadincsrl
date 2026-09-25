/**
 * Ejercicios y períodos contables (20260926a/e). Cerrar numera el libro
 * diario del período (correlativo por ejercicio, en orden fecha+id) y lo
 * congela; reabrir solo el ÚLTIMO cerrado, y le borra los números.
 *
 * El listado agrega por fila si se puede cerrar o reabrir y por qué no
 * (`bloqueo_*`), con las mismas reglas y el mismo orden que las RPC, para
 * que la UI deshabilite el botón con el motivo en vez de dejar que rebote.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { hoyAR } from '../pagos/pagos.util.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { rpc } from './comun.js'
import { automaticosService } from './automaticos.service.js'

export interface CtbEjercicio { id: number; nombre: string; desde: string; hasta: string; estado: 'abierto' | 'cerrado' }

export interface PeriodoFila {
  id: number; ejercicio_id: number; numero: number; estado: 'abierto' | 'cerrado'; cant_borradores: number
  [k: string]: unknown
}

export type BloqueoCerrar = 'PERIODO_YA_CERRADO' | 'PERIODO_ANTERIOR_ABIERTO' | 'HAY_BORRADORES' | 'EJERCICIO_CERRADO' | null
export type BloqueoReabrir = 'PERIODO_NO_CERRADO' | 'PERIODO_POSTERIOR_CERRADO' | 'EJERCICIO_CERRADO' | null

export type PeriodoConAcciones<T extends PeriodoFila = PeriodoFila> = T & {
  puede_cerrar: boolean; bloqueo_cerrar: BloqueoCerrar
  puede_reabrir: boolean; bloqueo_reabrir: BloqueoReabrir
}

/**
 * Qué se puede hacer con cada período de UN ejercicio. Espejo de
 * `cont_cerrar_periodo` (ya cerrado › ejercicio cerrado › anterior abierto ›
 * borradores) y `cont_reabrir_periodo` (no cerrado › ejercicio cerrado ›
 * posterior cerrado).
 */
export function accionesDePeriodos<T extends PeriodoFila>(periodos: T[], ejercicioCerrado: boolean): PeriodoConAcciones<T>[] {
  const orden = [...periodos].sort((a, b) => a.numero - b.numero)
  return orden.map((p) => {
    let bc: BloqueoCerrar = null
    if (p.estado === 'cerrado') bc = 'PERIODO_YA_CERRADO'
    else if (ejercicioCerrado) bc = 'EJERCICIO_CERRADO'
    else if (orden.some((o) => o.numero < p.numero && o.estado !== 'cerrado')) bc = 'PERIODO_ANTERIOR_ABIERTO'
    else if (Number(p.cant_borradores ?? 0) > 0) bc = 'HAY_BORRADORES'

    let br: BloqueoReabrir = null
    if (p.estado !== 'cerrado') br = 'PERIODO_NO_CERRADO'
    else if (ejercicioCerrado) br = 'EJERCICIO_CERRADO'
    else if (orden.some((o) => o.numero > p.numero && o.estado === 'cerrado')) br = 'PERIODO_POSTERIOR_CERRADO'

    return { ...p, puede_cerrar: bc === null, bloqueo_cerrar: bc, puede_reabrir: br === null, bloqueo_reabrir: br }
  })
}

/** El ejercicio que contiene `hoy`; si ninguno, el último (por `desde`). */
export function ejercicioPorDefecto(ejercicios: CtbEjercicio[], hoy: string): CtbEjercicio | null {
  const de = ejercicios.find((e) => e.desde <= hoy && hoy <= e.hasta)
  if (de) return de
  return [...ejercicios].sort((a, b) => (a.desde < b.desde ? 1 : a.desde > b.desde ? -1 : 0))[0] ?? null
}

/**
 * ¿La DDJJ de IVA del período frena el cierre (tanda 5, 20260928o)? Solo si
 * hay una generada (registro vigente) y quedó `desactualizado`: después de
 * generarla se contabilizó algo del mes. `sin_generar` no bloquea (el modal
 * de cierre lo avisa). Puro.
 */
export function ddjjBloqueaCierre(p: { estado?: unknown; registro?: unknown } | null | undefined): boolean {
  return !!p && p.registro != null && p.estado === 'desactualizado'
}

/**
 * Estado de la DDJJ para el cierre. Si la RPC todavía no existe en la base
 * (20260928o sin aplicar) devuelve null y el cierre sigue como antes.
 */
async function ivaParaCierre(periodoId: number, db: SupabaseClient): Promise<{ estado?: unknown; registro?: unknown } | null> {
  const { data, error } = await db.rpc('cont_iva_posicion', { p_periodo_id: periodoId })
  if (error) {
    const e = error as PgError
    if (e.code === '42883' || e.code === 'PGRST202') return null
    throw mapRpcError(e)
  }
  return (data ?? null) as { estado?: unknown; registro?: unknown } | null
}

export const periodosService = {
  async ejercicios(db: SupabaseClient = supabase): Promise<CtbEjercicio[]> {
    const { data, error } = await db.from('cont_ejercicios').select('id, nombre, desde, hasta, estado')
      .order('desde', { ascending: false }).order('id')
    if (error) throw mapRpcError(error as PgError)
    return (data ?? []) as CtbEjercicio[]
  },

  async listar(ejercicioId: number | undefined, db: SupabaseClient = supabase): Promise<PeriodoConAcciones[]> {
    const ejercicios = await this.ejercicios(db)
    const ej = ejercicioId != null ? ejercicios.find((e) => e.id === ejercicioId) : ejercicioPorDefecto(ejercicios, hoyAR())
    if (!ej) {
      if (ejercicioId != null) throw new ContabilidadHttpError(404, 'EJERCICIO_NO_EXISTE', { ejercicio_id: ejercicioId })
      return []
    }
    const { data, error } = await db.from('v_cont_periodos').select('*').eq('ejercicio_id', ej.id).order('numero')
    if (error) throw mapRpcError(error as PgError)
    return accionesDePeriodos((data ?? []) as PeriodoFila[], ej.estado === 'cerrado')
  },

  /** La fila del período ya con `puede_*`/`bloqueo_*` (se recalcula con todo su ejercicio). */
  async conAcciones(periodo: PeriodoFila, db: SupabaseClient): Promise<PeriodoConAcciones> {
    const lista = await this.listar(periodo.ejercicio_id, db)
    return lista.find((p) => p.id === periodo.id) ?? { ...periodo, puede_cerrar: false, bloqueo_cerrar: null, puede_reabrir: false, bloqueo_reabrir: null }
  },

  /**
   * Cerrar. Desde la fase 3, si en el rango del período hay orígenes sin
   * contabilizar, pendientes, desactualizados o a revertir, frena con 409
   * HAY_PENDIENTES_AUTOMATICOS { cantidad, por_estado } salvo `forzar`.
   * Desde la tanda 5, una DDJJ de IVA generada y desactualizada frena con 409
   * IVA_DDJJ_DESACTUALIZADA { periodo_id }, con el mismo `forzar`. Si hay
   * las dos cosas, el 409 de pendientes trae `iva_ddjj_desactualizada: true`
   * (20260929q): `forzar` cierra con las dos advertencias.
   */
  async cerrar(id: number, userId: string, db: SupabaseClient = supabase, forzar = false) {
    if (!forzar) {
      const { data: p, error } = await db.from('cont_periodos').select('id, desde, hasta').eq('id', id).maybeSingle()
      if (error) throw mapRpcError(error as PgError)
      // Sin período: que conteste la RPC (PERIODO_NO_EXISTE).
      if (p) {
        const { desde, hasta } = p as { desde: string; hasta: string }
        const hoy = hoyAR()
        const pend = desde <= hoy ? await automaticosService.pendientesDelRango(desde, hasta < hoy ? hasta : hoy, db) : null
        // Las dos advertencias se miran juntas (contador, 25/09: «se cierra con
        // advertencias»): el 409 de pendientes lleva también si el asiento de
        // IVA quedó desactualizado, así el confirm las lista a las dos y
        // «Cerrar igual» (forzar) saltea ambas de una vez.
        const ivaDesactualizada = ddjjBloqueaCierre(await ivaParaCierre(id, db))
        if (pend && pend.total > 0) {
          throw new ContabilidadHttpError(409, 'HAY_PENDIENTES_AUTOMATICOS', {
            periodo_id: id, cantidad: pend.total, por_estado: pend.por_estado, iva_ddjj_desactualizada: ivaDesactualizada,
          })
        }
        if (ivaDesactualizada) {
          throw new ContabilidadHttpError(409, 'IVA_DDJJ_DESACTUALIZADA', { periodo_id: id })
        }
      }
    }
    const r = await rpc<{ periodo: PeriodoFila; numerados: number; desde_numero: number | null; hasta_numero: number | null }>(
      db, 'cont_cerrar_periodo', { p_periodo_id: id, p_user_id: userId })
    return { ...r, periodo: await this.conAcciones(r.periodo, db) }
  },

  /**
   * Abre el ejercicio que sigue al último (julio a junio) con sus 12
   * períodos (`cont_abrir_ejercicio_siguiente`, 20260928e). 409
   * EJERCICIO_SIGUIENTE_YA_EXISTE si el último todavía no empezó.
   */
  async abrirSiguiente(userId: string, db: SupabaseClient = supabase): Promise<{ ejercicio: CtbEjercicio; periodos: number }> {
    return rpc<{ ejercicio: CtbEjercicio; periodos: number }>(db, 'cont_abrir_ejercicio_siguiente', { p_user_id: userId })
  },

  async reabrir(id: number, motivo: string, userId: string, db: SupabaseClient = supabase) {
    const r = await rpc<{ periodo: PeriodoFila; desnumerados: number }>(
      db, 'cont_reabrir_periodo', { p_periodo_id: id, p_motivo: motivo.trim(), p_user_id: userId })
    return { ...r, periodo: await this.conAcciones(r.periodo, db) }
  },
}
