/**
 * Bienes de uso y amortizaciones (tanda 5, 20260928p/q). Tab `bienes`, flag
 * `bienes_uso` (default false).
 *
 * Todo lo que escribe pasa por RPC (`cont_guardar_bien`, `cont_baja_bien`,
 * `cont_revertir_baja_bien`, `cont_importar_bienes`, `cont_amortizar`,
 * `cont_amortizacion_anular`), que vuelven a chequear el flag. La
 * amortización la calcula la base («teórico − registrado», idempotente por
 * bien y período) y escribe un asiento `ajuste` con origen
 * `cont_amortizacion_corridas` / evento `amortizacion`: no entra al lote del
 * motor ni se edita a mano.
 *
 * Lecturas: `v_cont_bienes_uso` (cientos de filas → `todasLasFilas`) y el
 * cuadro del ejercicio (`cont_bienes_cuadro`, un jsonb).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { hoyAR } from '../pagos/pagos.util.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { rpc, aCentavos } from './comun.js'
import { periodosService, ejercicioPorDefecto } from './periodos.service.js'
import {
  armarVistaPreviaBienes, bienesDeEntrada,
  type Celda, type FilaImportRpc, type FilaVistaPrevia, type ResumenImport,
} from './bienes-import.js'
import { esBoolQ, type BienDto, type BienesQuery } from './contabilidad.schema.js'

export type CtbBienUso = Record<string, unknown> & {
  id: number; codigo: string; descripcion: string; identificador: string; fecha_baja: string | null
}

export interface CtbAmortizacionFila {
  id: number; corrida_id: number; hasta: string; meses: number; importe: number; acumulada_al_cierre: number
  corrida_estado: 'vigente' | 'anulada' | null; corrida_desde: string | null; frecuencia: 'mensual' | 'anual' | null
  asiento_id: number | null
}

export interface ImportarBienesRes {
  confirmado: boolean; resumen: ResumenImport; filas: FilaVistaPrevia[]; columnas: Record<string, string>
}

const MAX_FILAS = 2000

/** El jsonb de `cont_guardar_bien`: vacíos a null, importes a centavos. */
export function bienParaRpc(dto: BienDto, id?: number): Record<string, unknown> {
  return {
    ...(id != null ? { id } : {}),
    descripcion: dto.descripcion.trim(),
    identificador: (dto.identificador ?? '').trim(),
    cuenta_origen_id: dto.cuenta_origen_id,
    cuenta_amort_id: dto.cuenta_amort_id ?? null,
    cuenta_gasto_id: dto.cuenta_gasto_id ?? null,
    fecha_alta: dto.fecha_alta,
    valor_origen: aCentavos(dto.valor_origen),
    vida_util_anios: dto.vida_util_anios ?? null,
    valor_residual: aCentavos(dto.valor_residual ?? 0),
    amort_acum_inicial: aCentavos(dto.amort_acum_inicial ?? 0),
    criterio_alta: dto.criterio_alta ?? null,
    obra_cod: dto.obra_cod?.trim() || null,
    pagos_factura_id: dto.pagos_factura_id ?? null,
    obs: (dto.obs ?? '').trim(),
  }
}

/** Filtro de texto del inventario: código, descripción o identificador. Puro. */
export function filtrarBienes<T extends { codigo?: unknown; descripcion?: unknown; identificador?: unknown }>(filas: T[], q?: string): T[] {
  const busq = normTxt(q ?? '')
  if (!busq) return filas
  return filas.filter((b) => [b.codigo, b.descripcion, b.identificador].some((v) => normTxt(String(v ?? '')).includes(busq)))
}

type FilaAmort = Record<string, unknown> & {
  corrida?: FilaCorridaEmb | FilaCorridaEmb[] | null
}
type FilaCorridaEmb = {
  estado: string; desde: string; frecuencia: string; asiento_id: number | null
  asiento?: { numero: number | null } | { numero: number | null }[] | null
}

export const bienesService = {
  async listar(q: BienesQuery, db: SupabaseClient = supabase): Promise<CtbBienUso[]> {
    const incluirBajas = esBoolQ(q.incluir_bajas)
    const filas = await todasLasFilas<CtbBienUso>((d, h) => {
      let s = db.from('v_cont_bienes_uso').select('*')
      if (!incluirBajas) s = s.is('fecha_baja', null)
      if (q.cuenta_origen_id != null) s = s.eq('cuenta_origen_id', q.cuenta_origen_id)
      if (q.obra_cod) s = s.eq('obra_cod', q.obra_cod)
      return s.order('codigo').order('id').range(d, h)
    })
    return filtrarBienes(filas, q.q)
  },

  async fila(id: number, db: SupabaseClient): Promise<CtbBienUso> {
    const { data, error } = await db.from('v_cont_bienes_uso').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new ContabilidadHttpError(404, 'BIEN_NO_EXISTE', { bien_id: id })
    return data as CtbBienUso
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<CtbBienUso & { amortizaciones: CtbAmortizacionFila[] }> {
    const bien = await this.fila(id, db)
    const { data, error } = await db.from('cont_amortizaciones')
      .select('id, corrida_id, hasta, meses, importe, acumulada_al_cierre, corrida:cont_amortizacion_corridas(estado, desde, frecuencia, asiento_id, asiento:cont_asientos(numero))')
      .eq('bien_id', id).order('hasta').order('id')
    if (error) throw mapRpcError(error as PgError)
    const amortizaciones = ((data ?? []) as FilaAmort[]).map((f) => {
      const { corrida, ...resto } = f
      const c = Array.isArray(corrida) ? corrida[0] : corrida
      return {
        ...(resto as unknown as CtbAmortizacionFila),
        corrida_estado: (c?.estado ?? null) as CtbAmortizacionFila['corrida_estado'],
        corrida_desde: c?.desde ?? null,
        frecuencia: (c?.frecuencia ?? null) as CtbAmortizacionFila['frecuencia'],
        asiento_id: c?.asiento_id ?? null,
        asiento_numero: (Array.isArray(c?.asiento) ? c?.asiento[0] : c?.asiento)?.numero ?? null,
      }
    })
    return { ...bien, amortizaciones }
  },

  async guardar(dto: BienDto, id: number | null, userId: string, db: SupabaseClient = supabase): Promise<CtbBienUso> {
    const r = await rpc<CtbBienUso | null>(db, 'cont_guardar_bien', { p_bien: bienParaRpc(dto, id ?? undefined), p_user_id: userId })
    const bienId = Number(r?.id ?? id)
    console.info(`[contabilidad] bien de uso ${r?.codigo ?? `#${bienId}`} ${id ? 'editado' : 'creado'} por ${userId} ($${dto.valor_origen})`)
    return r && r.codigo ? r : this.fila(bienId, db)
  },

  async baja(id: number, fecha: string, motivo: string, userId: string, db: SupabaseClient = supabase): Promise<CtbBienUso> {
    await rpc(db, 'cont_baja_bien', { p_id: id, p_fecha: fecha, p_motivo: motivo.trim(), p_user_id: userId })
    console.info(`[contabilidad] bien de uso #${id} dado de baja al ${fecha} por ${userId}: ${motivo.trim()}`)
    return this.fila(id, db)
  },

  async revertirBaja(id: number, userId: string, db: SupabaseClient = supabase): Promise<CtbBienUso> {
    await rpc(db, 'cont_revertir_baja_bien', { p_id: id, p_user_id: userId })
    console.info(`[contabilidad] baja del bien de uso #${id} revertida por ${userId}`)
    return this.fila(id, db)
  },

  /**
   * Vista previa (`confirmar=false`) o importación (todo o nada). Los errores
   * de formato que se ven acá (fecha, importes, vida útil) impiden confirmar
   * igual que los de la RPC (422 IMPORTACION_CON_ERRORES).
   */
  async importar(
    entrada: { filas?: Record<string, Celda>[]; csv?: string; confirmar: boolean },
    userId: string,
    db: SupabaseClient = supabase,
  ): Promise<ImportarBienesRes> {
    const { bienes, ignoradas, columnas } = bienesDeEntrada(entrada)
    if (bienes.length === 0) throw new ContabilidadHttpError(400, 'SIN_FILAS', { campo: 'filas', ignoradas })
    if (bienes.length > MAX_FILAS) throw new ContabilidadHttpError(400, 'DEMASIADAS_FILAS', { campo: 'filas', maximo: MAX_FILAS, filas: bienes.length })
    const hayLocales = bienes.some((b) => b.errores.length > 0)
    const confirmar = entrada.confirmar && !hayLocales

    let filasRpc: FilaImportRpc[] = []
    let confirmado = false
    try {
      const r = await rpc<{ confirmado?: boolean; filas?: FilaImportRpc[] } | null>(db, 'cont_importar_bienes', {
        p_filas: bienes.map((b, i) => ({ indice: i + 1, ...b.fila })), p_user_id: userId, p_confirmar: confirmar,
      })
      filasRpc = r?.filas ?? []
      confirmado = !!r?.confirmado && confirmar
    } catch (e) {
      if (e instanceof ContabilidadHttpError && e.code === 'IMPORTACION_CON_ERRORES') {
        const d = e.detail as { filas?: FilaImportRpc[]; errores?: FilaImportRpc[] } | undefined
        const vp = armarVistaPreviaBienes(bienes, d?.filas ?? d?.errores ?? [], ignoradas)
        throw new ContabilidadHttpError(422, 'IMPORTACION_CON_ERRORES', { filas: vp.filas.filter((f) => f.estado === 'error'), resumen: vp.resumen })
      }
      throw e
    }

    const vp = armarVistaPreviaBienes(bienes, filasRpc, ignoradas)
    if (entrada.confirmar && vp.resumen.con_error > 0) {
      throw new ContabilidadHttpError(422, 'IMPORTACION_CON_ERRORES', { filas: vp.filas.filter((f) => f.estado === 'error'), resumen: vp.resumen })
    }
    if (confirmado) {
      console.info(`[contabilidad] inventario de bienes de uso importado por ${userId}: ${vp.resumen.total} bienes, VO $${vp.resumen.valor_origen}`)
    }
    return { confirmado, resumen: vp.resumen, filas: vp.filas, columnas }
  },

  async cuadro(hasta: string, db: SupabaseClient = supabase): Promise<unknown> {
    const r = await rpc<unknown>(db, 'cont_bienes_cuadro', { p_hasta: hasta })
    if (r == null) throw new ContabilidadHttpError(400, 'FECHA_SIN_PERIODO', { campo: 'hasta', hasta })
    return r
  },

  /** Corridas de amortización del ejercicio (default: el de hoy), la última primero. */
  async corridas(ejercicioId: number | undefined, db: SupabaseClient = supabase): Promise<unknown[]> {
    const ejercicios = await periodosService.ejercicios(db)
    const ej = ejercicioId != null ? ejercicios.find((e) => e.id === ejercicioId) : ejercicioPorDefecto(ejercicios, hoyAR())
    if (!ej) {
      if (ejercicioId != null) throw new ContabilidadHttpError(404, 'EJERCICIO_NO_EXISTE', { ejercicio_id: ejercicioId })
      return []
    }
    const { data, error } = await db.from('cont_amortizacion_corridas')
      .select('*, asiento:cont_asientos(numero, fecha, estado)')
      .gte('hasta', ej.desde).lte('hasta', ej.hasta)
      .order('hasta', { ascending: false }).order('id', { ascending: false })
    if (error) throw mapRpcError(error as PgError)
    type FilaCorrida = Record<string, unknown> & { id: number; hasta: string; created_by?: string | null; anulado_por?: string | null; asiento?: unknown }
    const corridas = (data ?? []) as FilaCorrida[]
    if (corridas.length === 0) return []
    const ids = corridas.map((c) => c.id)

    // Lo que la pantalla muestra además de la corrida: cuántos bienes
    // amortizó, en qué estado está su período (para no ofrecer «Anular» en un
    // mes cerrado) y quién la generó o anuló.
    const [amorts, periodos, perfiles] = await Promise.all([
      todasLasFilas<{ corrida_id: number }>((d, h) =>
        db.from('cont_amortizaciones').select('corrida_id').in('corrida_id', ids).order('id').range(d, h)),
      db.from('cont_periodos').select('desde, hasta, estado').eq('ejercicio_id', ej.id),
      (async () => {
        const uids = [...new Set(corridas.flatMap((c) => [c.created_by, c.anulado_por]).filter((x): x is string => !!x))]
        if (uids.length === 0) return new Map<string, string>()
        const { data: pf, error: ePf } = await db.from('profiles').select('id, nombre').in('id', uids)
        if (ePf) throw mapRpcError(ePf as PgError)
        return new Map(((pf ?? []) as { id: string; nombre: string | null }[]).map((x) => [x.id, x.nombre ?? '']))
      })(),
    ])
    if (periodos.error) throw mapRpcError(periodos.error as PgError)
    const bienesPorCorrida = new Map<number, number>()
    for (const a of amorts) bienesPorCorrida.set(a.corrida_id, (bienesPorCorrida.get(a.corrida_id) ?? 0) + 1)
    const pers = (periodos.data ?? []) as { desde: string; hasta: string; estado: string }[]

    return corridas.map(({ asiento, ...c }) => {
      const a = (Array.isArray(asiento) ? asiento[0] : asiento) as { numero?: number | null } | null | undefined
      const per = pers.find((p) => p.desde <= c.hasta && c.hasta <= p.hasta)
      return {
        ...c,
        asiento_numero: a?.numero ?? null,
        bienes: bienesPorCorrida.get(c.id) ?? 0,
        periodo_estado: per?.estado ?? null,
        created_by_nombre: c.created_by ? perfiles.get(c.created_by) ?? null : null,
        anulado_por_nombre: c.anulado_por ? perfiles.get(c.anulado_por) ?? null : null,
      }
    })
  },

  async amortizar(hasta: string, userId: string, db: SupabaseClient = supabase): Promise<Record<string, unknown>> {
    const r = await rpc<{ frecuencia?: string; tramos?: Array<{ accion: string }>; total?: number } | null>(db, 'cont_amortizar', { p_hasta: hasta, p_user_id: userId })
    const tramos = r?.tramos ?? []
    const porAccion = tramos.reduce<Record<string, number>>((m, t) => ({ ...m, [t.accion]: (m[t.accion] ?? 0) + 1 }), {})
    console.info(`[contabilidad] amortizar hasta ${hasta} por ${userId}: ${r?.frecuencia ?? '?'}, total $${r?.total ?? 0}, tramos ${JSON.stringify(porAccion)}`)
    return { frecuencia: r?.frecuencia ?? null, tramos, total: Number(r?.total ?? 0) }
  },

  async anularCorrida(corridaId: number, motivo: string, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const r = await rpc<unknown>(db, 'cont_amortizacion_anular', { p_corrida_id: corridaId, p_motivo: motivo.trim(), p_user_id: userId })
    console.info(`[contabilidad] corrida de amortización #${corridaId} anulada por ${userId}: ${motivo.trim()}`)
    return r ?? { ok: true, corrida_id: corridaId }
  },
}
