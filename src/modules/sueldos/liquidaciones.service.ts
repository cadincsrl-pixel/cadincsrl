/**
 * Liquidaciones y recibos de Sueldos.
 *
 * El CÁLCULO es TS puro (`calculo.ts`); acá se junta lo que el motor
 * necesita (liquidación, legajo, `sueldos_valores_a_fecha`) y se persiste con
 * `sueldos_guardar_recibo`, que reemplaza las líneas y vuelve a sumar.
 *
 * «Generar recibos» arma un borrador por legajo con entradas SUGERIDAS:
 *   - por hora (UOCRA): las horas de tarja del legajo en la quincena
 *     (`horas`, paginado: cap de 1000 filas de PostgREST);
 *   - mensuales: los días del período dentro de ingreso/egreso;
 *   - préstamos: el saldo pendiente del legajo en Tarja › Préstamos
 *     (otorgado − descontado − incobrable), recortado para no dejar el neto
 *     negativo;
 *   - SAC / vacaciones / final: las sugerencias de `calculo.ts`.
 * Todo es editable después en el editor del recibo.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todasLasFilas } from '../../lib/paginar.js'
import { rpc, filas, n, enmascararFila, hoyAR } from './comun.js'
import { SueldosHttpError, mapRpcError, type PgError } from './sueldos.errors.js'
import { legajosService } from './legajos.service.js'
import {
  calcularRecibo, calcularSac, calcularVacaciones, calcularFinal, entradasPorDefecto, lineasParaGuardar,
  fechaDeValores, rangoPeriodo, semestreDe, remuneracionesMensuales, CalculoError, r2,
  type EntradasRecibo, type LegajoMotor, type LiquidacionMotor, type ValoresAFecha, type ResultadoCalculo,
  type HistorialFila, type TipoLiquidacion, type UnidadBasico, type SugerenciaSac, type SugerenciaVacaciones,
  type SugerenciaFinal,
} from './calculo.js'

type Fila = Record<string, unknown>

export interface LiquidacionFila {
  id: number
  codigo: string
  convenio_id: number
  tipo: TipoLiquidacion
  periodo: string
  quincena: 1 | 2 | null
  fecha_pago: string | null
  estado: 'borrador' | 'cerrada' | 'anulada'
}

export interface FiltroLiquidaciones {
  convenio_id?: number
  estado?: string
  tipo?: string
  desde?: string
  hasta?: string
  limit: number
  offset: number
}

function liqMotor(q: LiquidacionFila): LiquidacionMotor {
  return { tipo: q.tipo, periodo: String(q.periodo).slice(0, 10), quincena: q.quincena == null ? null : (Number(q.quincena) as 1 | 2) }
}

export function legajoMotor(l: Fila): LegajoMotor {
  const t = l.titulo_nivel
  return {
    id: Number(l.id),
    categoria_id: l.categoria_id == null ? null : Number(l.categoria_id),
    zona: String(l.zona || 'A'),
    fecha_ingreso: (l.fecha_ingreso as string | null) ?? null,
    fecha_egreso: (l.fecha_egreso as string | null) ?? null,
    afiliado_sindicato: l.afiliado_sindicato === true,
    rifl: l.rifl === true,
    titulo_nivel: t === 'A' || t === 'B' || t === 'C' ? t : null,
  }
}

/** CalculoError → 400 con su código (el motor no conoce HTTP). */
function aHttp(err: unknown): never {
  if (err instanceof CalculoError) throw new SueldosHttpError(400, err.code, err.detail)
  throw err
}

/** Valores del convenio a una fecha, con caché por (convenio, fecha, zona) dentro de un pedido. */
function cacheValores(db: SupabaseClient) {
  const m = new Map<string, Promise<ValoresAFecha>>()
  return (convenioId: number, fecha: string, zona: string) => {
    const k = `${convenioId}|${fecha}|${zona}`
    let p = m.get(k)
    if (!p) {
      p = rpc<ValoresAFecha>(db, 'sueldos_valores_a_fecha', { p_convenio_id: convenioId, p_fecha: fecha, p_zona: zona || 'A' })
      m.set(k, p)
    }
    return p
  }
}

/** Unidad del básico de la categoría del legajo (hora | mes) según los valores vigentes. */
function unidadDe(v: ValoresAFecha, categoriaId: number | null): UnidadBasico {
  const c = v.categorias.find(x => Number(x.id) === Number(categoriaId))
  return (c?.unidad_basico ?? v.convenio.unidad_basico) === 'mes' ? 'mes' : 'hora'
}

function parametro(v: ValoresAFecha, ...claves: string[]): number | null {
  for (const k of claves) {
    const p = v.parametros[k]
    if (p && Number.isFinite(Number(p.valor))) return Number(p.valor)
  }
  return null
}

// ── Horas de tarja y préstamos ──────────────────────────────────────────────

export interface HorasTarja {
  desde: string
  hasta: string
  horas: number
  dias: { fecha: string; obra_cod: string; horas: number }[]
}

/** Horas de tarja por legajo en un rango (paginado: la tabla supera las 1000 filas). Sin las filas en 0 (placeholders de la grilla). */
export async function horasDeTarja(legs: string[], desde: string, hasta: string, db: SupabaseClient): Promise<Map<string, HorasTarja>> {
  const out = new Map<string, HorasTarja>()
  if (!legs.length) return out
  const rows = await todasLasFilas<Fila>((d, h) => db.from('horas').select('id, leg, fecha, obra_cod, horas')
    .in('leg', legs).gte('fecha', desde).lte('fecha', hasta).gt('horas', 0).order('id').range(d, h))
  for (const r of rows) {
    const leg = String(r.leg)
    const x = out.get(leg) ?? { desde, hasta, horas: 0, dias: [] }
    const hs = n(r.horas)
    x.horas = r2(x.horas + hs)
    x.dias.push({ fecha: String(r.fecha), obra_cod: String(r.obra_cod), horas: hs })
    out.set(leg, x)
  }
  for (const x of out.values()) x.dias.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.obra_cod.localeCompare(b.obra_cod))
  return out
}

export interface SaldoPrestamos {
  saldo: number
  otorgado: number
  descontado: number
  incobrable: number
  /** Ya cargado en recibos de otras liquidaciones en borrador. */
  en_borradores: number
  movimientos: number
}

/**
 * Saldo de préstamos por legajo (Tarja › Préstamos): otorgado − descontado − incobrable,
 * menos lo que ya está puesto en recibos de OTRAS liquidaciones en borrador (así el mismo
 * saldo no se ofrece dos veces). Lo de las liquidaciones cerradas ya figura como
 * `descontado` en Tarja: lo escribe `sueldos_cerrar_liquidacion`.
 */
export async function saldosDePrestamos(legs: string[], db: SupabaseClient, excluirLiqId?: number): Promise<Map<string, SaldoPrestamos>> {
  const out = new Map<string, SaldoPrestamos>()
  if (!legs.length) return out
  const rows = await todasLasFilas<Fila>((d, h) => db.from('prestamos').select('id, leg, tipo, monto')
    .in('leg', legs).order('id').range(d, h))
  for (const r of rows) {
    const leg = String(r.leg)
    const x = out.get(leg) ?? { saldo: 0, otorgado: 0, descontado: 0, incobrable: 0, en_borradores: 0, movimientos: 0 }
    const m = n(r.monto)
    if (r.tipo === 'otorgado') x.otorgado = r2(x.otorgado + m)
    else if (r.tipo === 'descontado') x.descontado = r2(x.descontado + m)
    else if (r.tipo === 'incobrable') x.incobrable = r2(x.incobrable + m)
    x.movimientos++
    out.set(leg, x)
  }
  for (const [leg, m] of await prestamosEnBorradores(legs, db, excluirLiqId)) {
    const x = out.get(leg)
    if (x) x.en_borradores = r2(x.en_borradores + m)
  }
  for (const x of out.values()) x.saldo = r2(Math.max(0, x.otorgado - x.descontado - x.incobrable - x.en_borradores))
  return out
}

/** Préstamo ya cargado en recibos de liquidaciones en borrador, por leg. */
async function prestamosEnBorradores(legs: string[], db: SupabaseClient, excluirLiqId?: number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let ql = db.from('sueldos_liquidaciones').select('id').eq('estado', 'borrador')
  if (excluirLiqId) ql = ql.neq('id', excluirLiqId)
  const liqs = (filas(await ql) as Fila[]).map(x => Number(x.id))
  if (!liqs.length) return out
  const legajos = filas(await db.from('sueldos_legajos').select('id, leg').in('leg', legs)) as Fila[]
  const legDe = new Map(legajos.map(x => [Number(x.id), String(x.leg)]))
  if (!legDe.size) return out
  const recibos = filas(await db.from('sueldos_recibos').select('id, legajo_id')
    .in('liquidacion_id', liqs).in('legajo_id', [...legDe.keys()]).neq('estado', 'anulado')) as Fila[]
  if (!recibos.length) return out
  const legDeRecibo = new Map(recibos.map(r => [Number(r.id), legDe.get(Number(r.legajo_id))!]))
  const lineas = filas(await db.from('sueldos_recibo_lineas').select('recibo_id, importe')
    .eq('destino', 'prestamo').in('recibo_id', [...legDeRecibo.keys()])) as Fila[]
  for (const l of lineas) {
    const leg = legDeRecibo.get(Number(l.recibo_id))
    if (leg) out.set(leg, r2((out.get(leg) ?? 0) + n(l.importe)))
  }
  return out
}

async function historial(legajoId: number, desde: string, hasta: string, db: SupabaseClient): Promise<HistorialFila[]> {
  const h = await rpc<HistorialFila[] | null>(db, 'sueldos_historial_remuneraciones', { p_legajo_id: legajoId, p_desde: desde, p_hasta: hasta })
  return (h ?? []).map(x => ({ ...x, total_remunerativo: n(x.total_remunerativo), total_no_remunerativo: n(x.total_no_remunerativo) }))
}

/** Última remuneración mensual cerrada del legajo (para el valor día de vacaciones de mensualizados). */
function ultimaRemuneracion(h: HistorialFila[]): number | null {
  const meses = remuneracionesMensuales(h.filter(x => x.tipo === 'mensual' || x.tipo === 'quincena'))
  return meses.length ? meses[meses.length - 1]!.remunerativo : null
}

// ── Service ─────────────────────────────────────────────────────────────────

export const liquidacionesService = {
  async listar(f: FiltroLiquidaciones, db: SupabaseClient) {
    let s = db.from('sueldos_liquidaciones')
      .select('*, convenio:sueldos_convenios(id, codigo, nombre, periodicidad)', { count: 'exact' })
      .order('periodo', { ascending: false }).order('id', { ascending: false })
      .range(f.offset, f.offset + f.limit - 1)
    if (f.convenio_id) s = s.eq('convenio_id', f.convenio_id)
    if (f.estado) s = s.eq('estado', f.estado)
    if (f.tipo) s = s.eq('tipo', f.tipo)
    if (f.desde) s = s.gte('periodo', f.desde)
    if (f.hasta) s = s.lte('periodo', f.hasta)
    const { data, error, count } = await s
    if (error) throw mapRpcError(error as PgError)
    const liqs = (data ?? []) as Fila[]
    const ids = liqs.map(l => Number(l.id))
    const recibos = ids.length
      ? await todasLasFilas<Fila>((d, h) => db.from('sueldos_recibos')
          .select('id, liquidacion_id, total_remunerativo, total_no_remunerativo, total_descuentos, neto, total_contribuciones, fondo_cese')
          .in('liquidacion_id', ids).order('id').range(d, h))
      : []
    const items = liqs.map(l => {
      const rs = recibos.filter(r => Number(r.liquidacion_id) === Number(l.id))
      const sum = (k: string) => r2(rs.reduce((s2, r) => s2 + n(r[k]), 0))
      return {
        ...l,
        totales: {
          recibos: rs.length, remunerativo: sum('total_remunerativo'), no_remunerativo: sum('total_no_remunerativo'),
          descuentos: sum('total_descuentos'), neto: sum('neto'), contribuciones: sum('total_contribuciones'), fondo_cese: sum('fondo_cese'),
        },
      }
    })
    const total = count ?? items.length
    return { items, total, limit: f.limit, offset: f.offset, hasMore: f.offset + items.length < total }
  },

  async obtener(id: number, conLineas: boolean, verPii: boolean, db: SupabaseClient) {
    const j = await rpc<Fila | null>(db, 'sueldos_liquidacion_json', { p_id: id, p_con_lineas: conLineas })
    if (!j) throw new SueldosHttpError(404, 'LIQUIDACION_NO_EXISTE', { id })
    const recibos = Array.isArray(j.recibos) ? (j.recibos as Fila[]).map(r => enmascararFila(r, verPii)) : []
    return { ...j, recibos }
  },

  async fila(id: number, db: SupabaseClient): Promise<LiquidacionFila> {
    const { data, error } = await db.from('sueldos_liquidaciones').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new SueldosHttpError(404, 'LIQUIDACION_NO_EXISTE', { id })
    return data as LiquidacionFila
  },

  crear(b: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_crear_liquidacion', { p_liq: b, p_user_id: uid })
  },
  editar(id: number, b: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_editar_liquidacion', { p_id: id, p_cambios: b, p_user_id: uid })
  },
  cerrar(id: number, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_cerrar_liquidacion', { p_id: id, p_user_id: uid })
  },
  contabilizar(id: number, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_contabilizar_liquidacion', { p_id: id, p_user_id: uid })
  },
  reabrir(id: number, motivo: string, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_reabrir_liquidacion', { p_id: id, p_motivo: motivo, p_user_id: uid })
  },
  anular(id: number, motivo: string, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_anular_liquidacion', { p_id: id, p_motivo: motivo, p_user_id: uid })
  },
  asiento(id: number, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_asiento_propuesta', { p_id: id })
  },

  async recibo(liqId: number, legajoId: number, verPii: boolean, db: SupabaseClient) {
    const { data, error } = await db.from('sueldos_recibos').select('id').eq('liquidacion_id', liqId).eq('legajo_id', legajoId).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new SueldosHttpError(404, 'RECIBO_NO_EXISTE', { liquidacion_id: liqId, legajo_id: legajoId })
    const j = await rpc<Fila>(db, 'sueldos_recibo_json', { p_id: Number((data as Fila).id) })
    return enmascararFila(j, verPii)
  },

  /** Cálculo sin guardar (vista previa del editor). */
  async calcular(liqId: number, legajoId: number, entradas: EntradasRecibo, db: SupabaseClient, getValores = cacheValores(db)) {
    const q = await liquidacionesService.fila(liqId, db)
    const l = await legajosService.crudo(legajoId, db)
    return calcularCon(q, l, entradas, getValores)
  },

  async guardar(liqId: number, legajoId: number, entradas: EntradasRecibo, obs: string | undefined, uid: string, verPii: boolean, db: SupabaseClient) {
    const q = await liquidacionesService.fila(liqId, db)
    if (q.estado !== 'borrador') throw new SueldosHttpError(409, 'LIQUIDACION_NO_BORRADOR', { id: q.id, estado: q.estado })
    const l = await legajosService.crudo(legajoId, db)
    const calc = await calcularCon(q, l, entradas, cacheValores(db))
    if (calc.totales.neto < 0) throw new SueldosHttpError(409, 'NETO_NEGATIVO', { neto: calc.totales.neto })
    const recibo = await persistir(q, l, entradas, obs, calc, uid, db)
    return { recibo: enmascararFila(recibo, verPii), calculo: calc }
  },

  borrar(liqId: number, legajoId: number, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_borrar_recibo', { p_liquidacion_id: liqId, p_legajo_id: legajoId, p_user_id: uid })
  },

  /** Sugerencias para el editor del recibo: entradas por defecto + el detalle de dónde salen. */
  async sugerencias(liqId: number, legajoId: number, db: SupabaseClient) {
    const q = await liquidacionesService.fila(liqId, db)
    const l = await legajosService.crudo(legajoId, db)
    return sugerir(q, l, { incluir_prestamos: true }, cacheValores(db), db)
  },

  /** Crea (o recalcula con `reemplazar`) los recibos borrador de la liquidación. */
  async generar(liqId: number, b: { legajo_ids?: number[]; reemplazar?: boolean; incluir_prestamos?: boolean }, uid: string, verPii: boolean, db: SupabaseClient) {
    const q = await liquidacionesService.fila(liqId, db)
    if (q.estado !== 'borrador') throw new SueldosHttpError(409, 'LIQUIDACION_NO_BORRADOR', { id: q.id, estado: q.estado })
    const lm = liqMotor(q)
    const { desde, hasta } = rangoPeriodo(lm)
    let legajos: Fila[]
    if (b.legajo_ids?.length) {
      legajos = await legajosService.crudos([...new Set(b.legajo_ids)], db)
    } else {
      if (!['quincena', 'mensual', 'sac'].includes(q.tipo)) throw new SueldosHttpError(400, 'LEGAJOS_REQUERIDOS', { campo: 'legajo_ids', tipo: q.tipo })
      legajos = (await legajosService.delConvenio(q.convenio_id, db)).filter(l =>
        // Inactivo pero con egreso dentro del período: se le liquidan los días trabajados.
        (l.activo === true || (!!l.fecha_egreso && String(l.fecha_egreso) >= desde))
        && (!l.fecha_ingreso || String(l.fecha_ingreso) <= hasta)
        && (!l.fecha_egreso || String(l.fecha_egreso) >= desde))
    }
    const existentes = new Set((filas(await db.from('sueldos_recibos').select('legajo_id').eq('liquidacion_id', q.id)) as Fila[]).map(r => Number(r.legajo_id)))

    const getValores = cacheValores(db)
    const legs = legajos.map(l => l.leg).filter((x): x is string => typeof x === 'string' && x !== '')
    const [horas, prestamos] = await Promise.all([
      q.tipo === 'quincena' || q.tipo === 'mensual' ? horasDeTarja(legs, desde, hasta, db) : Promise.resolve(new Map<string, HorasTarja>()),
      b.incluir_prestamos === false ? Promise.resolve(new Map<string, SaldoPrestamos>()) : saldosDePrestamos(legs, db, q.id),
    ])

    const creados: { legajo_id: number; nombre: string; neto: number; avisos: string[] }[] = []
    const omitidos: { legajo_id: number; nombre: string; motivo: 'YA_TIENE_RECIBO' | 'OTRO_CONVENIO' | 'SIN_HORAS_EN_TARJA' }[] = []
    const errores: { legajo_id: number; nombre: string; error: string; detail?: unknown }[] = []
    for (const l of legajos) {
      const id = Number(l.id)
      const nombre = String(l.nombre_mostrar ?? l.nombre ?? '')
      if (Number(l.convenio_id) !== Number(q.convenio_id)) { omitidos.push({ legajo_id: id, nombre, motivo: 'OTRO_CONVENIO' }); continue }
      if (existentes.has(id) && !b.reemplazar) { omitidos.push({ legajo_id: id, nombre, motivo: 'YA_TIENE_RECIBO' }); continue }
      try {
        const sug = await sugerir(q, l, { incluir_prestamos: b.incluir_prestamos !== false }, getValores, db, {
          horas: l.leg ? horas.get(String(l.leg)) ?? null : null,
          prestamos: l.leg ? prestamos.get(String(l.leg)) ?? null : null,
        })
        // Por hora y sin horas en la tarja del período: no se arma un recibo en cero
        // (daría neto negativo por los descuentos fijos). Si corresponde, se agrega a mano.
        if (sug.entradas.horas_normales === 0) { omitidos.push({ legajo_id: id, nombre, motivo: 'SIN_HORAS_EN_TARJA' }); continue }
        let entradas = sug.entradas
        let calc = await calcularCon(q, l, entradas, getValores)
        // El préstamo sugerido no puede dejar el neto negativo.
        if (calc.totales.neto < 0 && entradas.prestamos) {
          const resto = r2(Math.max(0, entradas.prestamos + calc.totales.neto))
          entradas = { ...entradas, prestamos: resto > 0 ? resto : null }
          calc = await calcularCon(q, l, entradas, getValores)
        }
        await persistir(q, l, entradas, undefined, calc, uid, db)
        creados.push({ legajo_id: id, nombre, neto: calc.totales.neto, avisos: calc.avisos.map(a => a.codigo) })
      } catch (err) {
        if (err instanceof SueldosHttpError) errores.push({ legajo_id: id, nombre, error: err.code, detail: err.detail })
        else if (err instanceof CalculoError) errores.push({ legajo_id: id, nombre, error: err.code, detail: err.detail })
        else throw err
      }
    }
    const liquidacion = await liquidacionesService.obtener(q.id, false, verPii, db)
    return { creados, omitidos, errores, liquidacion }
  },

  // ── SAC / vacaciones / final por legajo (fuera de una liquidación) ──

  async sacDeLegajo(legajoId: number, anio: number, semestre: 1 | 2, db: SupabaseClient): Promise<SugerenciaSac> {
    const l = await legajosService.crudo(legajoId, db)
    const h = await historial(legajoId, `${anio}-${semestre === 1 ? '01' : '07'}-01`, `${anio}-${semestre === 1 ? '06-30' : '12-31'}`, db)
    return calcularSac({ historial: h, anio, semestre, fecha_ingreso: (l.fecha_ingreso as string | null) ?? null, fecha_egreso: (l.fecha_egreso as string | null) ?? null })
  },

  async vacacionesDeLegajo(legajoId: number, anio: number, dias: number | undefined, db: SupabaseClient): Promise<SugerenciaVacaciones> {
    const l = await legajosService.crudo(legajoId, db)
    const v = await cacheValores(db)(Number(l.convenio_id), `${anio}-12-31` > hoyAR() ? hoyAR() : `${anio}-12-31`, String(l.zona || 'A'))
    return vacacionesCon(l, v, anio, dias, db)
  },

  async finalDeLegajo(legajoId: number, fechaEgreso: string | undefined, diasGozados: number | undefined, db: SupabaseClient): Promise<SugerenciaFinal> {
    const l = await legajosService.crudo(legajoId, db)
    const egreso = fechaEgreso ?? (l.fecha_egreso as string | null)
    if (!egreso) throw new SueldosHttpError(400, 'LEGAJO_SIN_FECHA_EGRESO', { campo: 'fecha_egreso' })
    const v = await cacheValores(db)(Number(l.convenio_id), egreso, String(l.zona || 'A'))
    return finalCon(l, v, egreso, diasGozados, db)
  },
}

async function calcularCon(q: LiquidacionFila, l: Fila, entradas: EntradasRecibo, getValores: ReturnType<typeof cacheValores>): Promise<ResultadoCalculo> {
  if (Number(l.convenio_id) !== Number(q.convenio_id)) {
    throw new SueldosHttpError(400, 'LEGAJO_OTRO_CONVENIO', { legajo_id: l.id, convenio_id: l.convenio_id })
  }
  const lm = liqMotor(q)
  const valores = await getValores(q.convenio_id, fechaDeValores(lm), String(l.zona || 'A'))
  try {
    return calcularRecibo({ legajo: legajoMotor(l), liquidacion: lm, valores, entradas })
  } catch (err) {
    return aHttp(err)
  }
}

async function persistir(q: LiquidacionFila, l: Fila, entradas: EntradasRecibo, obs: string | undefined, calc: ResultadoCalculo, uid: string, db: SupabaseClient) {
  const snapshotLegajo: Fila = { ...l }
  for (const k of ['created_at', 'updated_at', 'created_by', 'updated_by']) delete snapshotLegajo[k]
  return rpc<Fila>(db, 'sueldos_guardar_recibo', {
    p_liquidacion_id: q.id,
    p_legajo_id: Number(l.id),
    p_recibo: {
      snapshot: {
        legajo: snapshotLegajo,
        escala: calc.valor_escala,
        calculo: {
          fecha_valores: calc.fecha_valores, unidad_basico: calc.unidad_basico, valor_hora: calc.valor_hora,
          antiguedad_anios: calc.antiguedad_anios, avisos: calc.avisos,
        },
      },
      entradas,
      dias_trabajados: calc.dias_trabajados,
      horas_trabajadas: calc.horas_trabajadas,
      obs: obs ?? entradas.obs ?? '',
      total_remunerativo: calc.totales.remunerativo,
      total_no_remunerativo: calc.totales.no_remunerativo,
      total_descuentos: calc.totales.descuentos,
      total_contribuciones: calc.totales.contribuciones,
      fondo_cese: calc.totales.fondo_cese,
      neto: calc.totales.neto,
    },
    p_lineas: lineasParaGuardar(calc.lineas),
    p_user_id: uid,
  })
}

async function vacacionesCon(l: Fila, v: ValoresAFecha, anio: number, dias: number | undefined | null, db: SupabaseClient) {
  const unidad = unidadDe(v, l.categoria_id == null ? null : Number(l.categoria_id))
  const cat = v.categorias.find(c => Number(c.id) === Number(l.categoria_id))
  if (!cat) throw new SueldosHttpError(400, 'LEGAJO_SIN_CATEGORIA', { legajo_id: l.id, campo: 'categoria_id' })
  if (!cat.valor) throw new SueldosHttpError(400, 'SIN_ESCALA', { categoria_id: cat.id, categoria: cat.nombre, fecha: v.fecha })
  const h = unidad === 'mes' ? await historial(Number(l.id), `${anio - 1}-01-01`, `${anio}-12-31`, db) : []
  return calcularVacaciones({
    anio, fecha_ingreso: (l.fecha_ingreso as string | null) ?? null, unidad_basico: unidad, valor_escala: Number(cat.valor),
    horas_dia: parametro(v, `horas_dia_${v.convenio.codigo}`, 'horas_dia_uocra'), divisor: parametro(v, 'divisor_vacaciones'),
    remuneracion_mensual: unidad === 'mes' ? ultimaRemuneracion(h) : null, dias: dias ?? null,
  })
}

async function finalCon(l: Fila, v: ValoresAFecha, egreso: string, diasGozados: number | undefined | null, db: SupabaseClient) {
  const unidad = unidadDe(v, l.categoria_id == null ? null : Number(l.categoria_id))
  const cat = v.categorias.find(c => Number(c.id) === Number(l.categoria_id))
  if (!cat) throw new SueldosHttpError(400, 'LEGAJO_SIN_CATEGORIA', { legajo_id: l.id, campo: 'categoria_id' })
  if (!cat.valor) throw new SueldosHttpError(400, 'SIN_ESCALA', { categoria_id: cat.id, categoria: cat.nombre, fecha: v.fecha })
  const { anio } = semestreDe(egreso)
  const h = await historial(Number(l.id), `${anio - 1}-01-01`, egreso, db)
  return calcularFinal({
    fecha_egreso: egreso, fecha_ingreso: (l.fecha_ingreso as string | null) ?? null, historial: h, unidad_basico: unidad,
    valor_escala: Number(cat.valor), horas_dia: parametro(v, `horas_dia_${v.convenio.codigo}`, 'horas_dia_uocra'),
    divisor: parametro(v, 'divisor_vacaciones'), remuneracion_mensual: unidad === 'mes' ? ultimaRemuneracion(h) : null,
    dias_gozados: diasGozados ?? null,
  })
}

export interface SugerenciasRecibo {
  entradas: EntradasRecibo
  horas_tarja: HorasTarja | null
  prestamos: SaldoPrestamos | null
  sac: SugerenciaSac | null
  vacaciones: SugerenciaVacaciones | null
  final: SugerenciaFinal | null
}

async function sugerir(
  q: LiquidacionFila, l: Fila, opts: { incluir_prestamos: boolean }, getValores: ReturnType<typeof cacheValores>, db: SupabaseClient,
  pre?: { horas: HorasTarja | null; prestamos: SaldoPrestamos | null },
): Promise<SugerenciasRecibo> {
  const lm = liqMotor(q)
  const { desde, hasta } = rangoPeriodo(lm)
  const v = await getValores(q.convenio_id, fechaDeValores(lm), String(l.zona || 'A'))
  const unidad = unidadDe(v, l.categoria_id == null ? null : Number(l.categoria_id))
  const leg = typeof l.leg === 'string' && l.leg ? l.leg : null

  let horas: HorasTarja | null = pre ? pre.horas : null
  if (!pre && leg && unidad === 'hora' && (q.tipo === 'quincena' || q.tipo === 'mensual')) {
    horas = (await horasDeTarja([leg], desde, hasta, db)).get(leg) ?? null
  }
  let prestamos: SaldoPrestamos | null = pre ? pre.prestamos : null
  if (!pre && leg && opts.incluir_prestamos) prestamos = (await saldosDePrestamos([leg], db, q.id)).get(leg) ?? null

  const entradas = entradasPorDefecto({
    liquidacion: lm, unidad_basico: unidad,
    fecha_ingreso: (l.fecha_ingreso as string | null) ?? null, fecha_egreso: (l.fecha_egreso as string | null) ?? null,
    horas_tarja: unidad === 'hora' ? horas?.horas ?? 0 : null,
    saldo_prestamos: opts.incluir_prestamos ? prestamos?.saldo ?? null : null,
  })

  let sac: SugerenciaSac | null = null
  let vacaciones: SugerenciaVacaciones | null = null
  let final: SugerenciaFinal | null = null
  const conceptos = [...(entradas.conceptos ?? [])]
  if (q.tipo === 'sac') {
    const { anio, semestre } = semestreDe(lm.periodo)
    const r = rangoPeriodo(lm)
    const h = await historial(Number(l.id), `${anio}-${semestre === 1 ? '01' : '07'}-01`, r.hasta, db)
    sac = calcularSac({ historial: h, anio, semestre, fecha_ingreso: (l.fecha_ingreso as string | null) ?? null, fecha_egreso: (l.fecha_egreso as string | null) ?? null })
    if (sac.importe > 0) conceptos.push({ codigo: 'sac', importe: sac.importe })
  } else if (q.tipo === 'vacaciones') {
    vacaciones = await vacacionesCon(l, v, Number(lm.periodo.slice(0, 4)), null, db)
    if (vacaciones.importe > 0) conceptos.push({ codigo: 'vacaciones', cantidad: vacaciones.dias, importe: vacaciones.importe })
  } else if (q.tipo === 'final') {
    const egreso = (l.fecha_egreso as string | null) ?? null
    if (!egreso) throw new SueldosHttpError(400, 'LEGAJO_SIN_FECHA_EGRESO', { legajo_id: l.id, campo: 'fecha_egreso' })
    final = await finalCon(l, v, egreso, null, db)
    if (final.sac_proporcional.importe > 0) conceptos.push({ codigo: 'sac_proporcional', importe: final.sac_proporcional.importe })
    if (final.vacaciones_no_gozadas.importe > 0) {
      conceptos.push({ codigo: 'vacaciones_no_gozadas', cantidad: final.vacaciones_no_gozadas.dias, importe: final.vacaciones_no_gozadas.importe })
    }
  }
  const codigos = new Set(v.conceptos.map(c => c.codigo))
  const validos = conceptos.filter(c => codigos.has(c.codigo))
  if (validos.length) entradas.conceptos = validos
  return { entradas, horas_tarja: horas, prestamos, sac, vacaciones, final }
}
