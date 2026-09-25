/**
 * Motor de asientos automáticos (fase 3, 20260927e/f). Todo el cálculo vive
 * en la base: la propuesta de cada origen (`_cont_prop_*`), el lote
 * idempotente `cont_contabilizar` y la vista de pendientes. El backend:
 *
 *   - llama `cont_contabilizar` en bucle con el cursor hasta `hay_mas=false`
 *     o 25 s, y suma los totales (el FE vuelve a llamar si quedó `hay_mas`,
 *     pasando el `cursor`);
 *   - antes de cerrar un período pregunta `cont_pendientes` del rango
 *     (`pendientesDelRango`, lo usa periodos.service).
 *
 * Sin triggers en las tablas de origen: nada se contabiliza solo. Un origen
 * sin mapeo queda pendiente con su motivo; nunca se inventa una cuenta.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { hoyAR } from '../pagos/pagos.util.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { rpc, pagina } from './comun.js'
import type { ContabilizarDto, CtbFuente, PendientesQuery } from './contabilidad.schema.js'

export interface CtbConfig {
  automaticos_desde: string
  cvlp_modo: 'neto_liquidado' | 'bruto'
  compras_fecha_contable: 'fecha' | 'mes_iva'
  paga_cliente_modo: string | null
  /** Tanda 5 (20260928n): compensar saldos a favor del mes anterior en el asiento de IVA. */
  iva_ddjj_arrastre: boolean
  /** Bienes de uso: cada cuánto se amortiza, cómo cuenta el año de alta y a qué fecha es la acumulada inicial. */
  bu_frecuencia: 'mensual' | 'anual'
  bu_criterio_alta: 'completo' | 'proporcional'
  bu_corte_inicial: string
  /** Cuenta título de los rubros de bienes de uso (20260929h). null = la base usa 1.2.2. */
  bu_titulo_rubros: CtbCuentaTitulo | null
}

export interface CtbCuentaTitulo { cuenta_id: number; codigo: string | null; nombre: string | null }

export const CONFIG_DEFAULT: CtbConfig = {
  automaticos_desde: '2026-07-01',
  cvlp_modo: 'neto_liquidado',
  compras_fecha_contable: 'mes_iva',
  paga_cliente_modo: null,
  iva_ddjj_arrastre: false,
  bu_frecuencia: 'mensual',
  bu_criterio_alta: 'proporcional',
  bu_corte_inicial: '2026-06-30',
  bu_titulo_rubros: null,
}

/** `cont_config.bu_titulo_rubros` viene como id (fila cruda) o como {cuenta_id, codigo, nombre} (cont_config_json). */
function tituloDeValor(v: unknown): CtbCuentaTitulo | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return { cuenta_id: v, codigo: null, nombre: null }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    const id = Number(o.cuenta_id)
    if (!Number.isInteger(id) || id <= 0) return null
    return {
      cuenta_id: id,
      codigo: typeof o.codigo === 'string' ? o.codigo : null,
      nombre: typeof o.nombre === 'string' ? o.nombre : null,
    }
  }
  return null
}

/** Filas de `cont_config` (clave, valor jsonb) → CtbConfig, con defaults. */
export function configDeFilas(filas: { clave: string; valor: unknown }[]): CtbConfig {
  const out: CtbConfig = { ...CONFIG_DEFAULT }
  for (const f of filas) {
    if (f.clave === 'bu_titulo_rubros') out.bu_titulo_rubros = tituloDeValor(f.valor)
    else if (f.clave in out) (out as unknown as Record<string, unknown>)[f.clave] = f.valor ?? null
  }
  return out
}

export interface ContabilizarTotales {
  procesados: number; creados: number; regenerados: number; anulados: number; revertidos: number
  sin_cambios: number; pendientes: number; desactualizados: number; errores: number
  hay_mas: boolean; cursor: unknown | null
  detalle_errores: { origen_tabla: CtbFuente; origen_id: number; codigo: string; mensaje: string }[]
}

const CONTADORES = ['procesados', 'creados', 'regenerados', 'anulados', 'revertidos', 'sin_cambios', 'pendientes', 'desactualizados', 'errores'] as const
const MAX_DETALLE_ERRORES = 50
/** Presupuesto de tiempo por request (Render corta a los 30 s). */
export const PRESUPUESTO_MS = 25_000
// 100 y no 300: cada tanda tiene que entrar holgada en los 30 s de Render
// (el presupuesto de 25 s recién se mira entre tandas).
const LIMITE_POR_LLAMADA = 100

function vacio(): ContabilizarTotales {
  return {
    procesados: 0, creados: 0, regenerados: 0, anulados: 0, revertidos: 0, sin_cambios: 0, pendientes: 0,
    desactualizados: 0, errores: 0, hay_mas: false, cursor: null, detalle_errores: [],
  }
}

/** Suma una respuesta de `cont_contabilizar` a los totales. Puro. */
export function sumarTanda(t: ContabilizarTotales, r: Partial<ContabilizarTotales> | null | undefined): ContabilizarTotales {
  const out = { ...t, detalle_errores: [...t.detalle_errores] }
  for (const k of CONTADORES) out[k] += Number(r?.[k] ?? 0)
  out.hay_mas = !!r?.hay_mas
  out.cursor = r?.cursor ?? null
  for (const e of r?.detalle_errores ?? []) {
    if (out.detalle_errores.length >= MAX_DETALLE_ERRORES) break
    out.detalle_errores.push(e)
  }
  return out
}

export const automaticosService = {
  async config(db: SupabaseClient = supabase): Promise<CtbConfig> {
    const { data, error } = await db.from('cont_config').select('clave, valor')
    if (error) throw mapRpcError(error as PgError)
    const out = configDeFilas((data ?? []) as { clave: string; valor: unknown }[])
    // La fila guarda solo el id: se completan código y nombre para la pantalla.
    const t = out.bu_titulo_rubros
    if (t && t.codigo === null) {
      const { data: cta, error: e2 } = await db.from('cont_cuentas').select('codigo, nombre').eq('id', t.cuenta_id).maybeSingle()
      if (e2) throw mapRpcError(e2 as PgError)
      if (cta) out.bu_titulo_rubros = { cuenta_id: t.cuenta_id, codigo: cta.codigo as string, nombre: cta.nombre as string }
    }
    return out
  },

  async pendientes(q: PendientesQuery, db: SupabaseClient = supabase) {
    const desde = q.desde ?? (await this.config(db)).automaticos_desde
    const hasta = q.hasta ?? hoyAR()
    if (desde > hasta) throw new ContabilidadHttpError(400, 'RANGO_INVALIDO', { campo: 'desde', desde, hasta })
    const r = await rpc<{ total?: number; resumen?: unknown; items?: unknown[] } | null>(db, 'cont_pendientes', {
      p_desde: desde, p_hasta: hasta, p_fuente: q.fuente ?? null, p_estado: q.estado ?? null,
      p_motivo: q.motivo || null, p_limit: q.limit, p_offset: q.offset,
      p_fuentes: q.fuentes ?? null,
    })
    const items = r?.items ?? []
    return {
      ...pagina(items, Number(r?.total ?? items.length), q.limit, q.offset),
      resumen: r?.resumen ?? { por_estado: {}, por_fuente: {}, por_motivo: [] },
    }
  },

  async propuesta(origenTabla: CtbFuente, origenId: number, db: SupabaseClient = supabase) {
    const r = await rpc<unknown>(db, 'cont_propuesta', { p_origen_tabla: origenTabla, p_origen_id: origenId })
    if (r == null) throw new ContabilidadHttpError(404, 'ORIGEN_NO_EXISTE', { origen_tabla: origenTabla, origen_id: origenId })
    return r
  },

  /**
   * Contabiliza hasta `hasta` en tandas de 300, con el cursor, hasta
   * terminar o agotar `presupuestoMs`. Idempotente: volver a correrlo deja
   * `sin_cambios` lo que ya estaba al día.
   */
  async contabilizar(dto: ContabilizarDto, userId: string, db: SupabaseClient = supabase, presupuestoMs = PRESUPUESTO_MS): Promise<ContabilizarTotales> {
    if (dto.hasta > hoyAR()) throw new ContabilidadHttpError(400, 'FECHA_FUTURA', { campo: 'hasta', hoy: hoyAR() })
    const inicio = Date.now()
    let t = vacio()
    let cursor: unknown = dto.cursor ?? null
    for (;;) {
      const r = await rpc<Partial<ContabilizarTotales> | null>(db, 'cont_contabilizar', {
        p_hasta: dto.hasta, p_user_id: userId, p_fuentes: dto.fuentes ?? null,
        p_revertir_cerrados: dto.revertir_cerrados ?? false, p_cursor: cursor, p_limite: LIMITE_POR_LLAMADA,
      })
      t = sumarTanda(t, r)
      // Sin avance (cursor igual) no se insiste: se devuelve y el FE decide.
      const avanzo = JSON.stringify(t.cursor) !== JSON.stringify(cursor)
      cursor = t.cursor
      if (!t.hay_mas || !avanzo || Date.now() - inicio >= presupuestoMs) break
    }
    console.info(`[contabilidad] contabilizar hasta ${dto.hasta}${dto.fuentes ? ` (${dto.fuentes.join(',')})` : ''}`
      + `${dto.revertir_cerrados ? ' con contraasientos' : ''} por ${userId}: ${t.procesados} procesados, ${t.creados} creados, `
      + `${t.regenerados} regenerados, ${t.anulados} anulados, ${t.revertidos} revertidos, ${t.pendientes} pendientes, `
      + `${t.desactualizados} desactualizados, ${t.errores} errores${t.hay_mas ? ' — quedan más' : ''}`)
    return t
  },

  /**
   * Orígenes del rango que no están al día (para frenar el cierre del
   * período). Si la función todavía no existe en la base (migración 27f sin
   * aplicar), devuelve null y el cierre sigue como antes.
   */
  async pendientesDelRango(desde: string, hasta: string, db: SupabaseClient = supabase): Promise<{ total: number; por_estado: Record<string, number> } | null> {
    const { data, error } = await db.rpc('cont_pendientes', {
      p_desde: desde, p_hasta: hasta, p_fuente: null, p_estado: null, p_motivo: null, p_limit: 1, p_offset: 0,
    })
    if (error) {
      const e = error as PgError
      if (e.code === '42883' || e.code === 'PGRST202') return null
      throw mapRpcError(e)
    }
    const r = (data ?? null) as { total?: number; resumen?: { por_estado?: Record<string, number> } } | null
    return { total: Number(r?.total ?? 0), por_estado: r?.resumen?.por_estado ?? {} }
  },
}
