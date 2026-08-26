// =====================================================================
// Herramientas del Asistente IA — TODAS de solo lectura.
//
// REGLA DE ORO: el asistente NUNCA es un bypass de permisos. Cada
// herramienta valida los permisos del usuario que pregunta (lectura del
// módulo + flags extra como ver_costos / ver_pii) y scopea por sus obras
// permitidas. Si no tiene permiso devuelve { error: 'SIN_PERMISO', ... }
// como RESULTADO de la herramienta (nunca una excepción que corte el
// chat) — el modelo le explica al usuario que no tiene acceso.
//
// Los datos se leen con el cliente admin `supabase` (service role): los
// permisos ya se validaron en (a), igual que hace el resto del backend
// tras pasar requirePermiso. Excepción: los reportes de gastos reusan
// gastosService, que pide el token del usuario (RLS permisiva, da igual).
//
// Respuestas COMPACTAS y agregadas (totales, top-N) — eficiencia de
// tokens, nunca dumps de cientos de filas.
// =====================================================================
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { supabase } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import { calcularCostoObra, viernesISO } from '../horas/costo-obra.js'
import { gastosService } from '../logistica/gastos/gastos.service.js'

// ── Perfil + permisos del usuario que pregunta ────────────────────────

export type Perfil = {
  nombre: string | null
  rol: string | null
  permisos: Record<string, Record<string, unknown>> | null
}

export async function fetchPerfil(userId: string): Promise<Perfil | null> {
  const { data } = await supabase
    .from('profiles')
    .select('nombre, rol, permisos')
    .eq('id', userId)
    .maybeSingle()
  if (!data) return null
  return {
    nombre:   (data.nombre as string | null) ?? null,
    rol:      (data.rol as string | null) ?? null,
    permisos: (data.permisos as Perfil['permisos']) ?? null,
  }
}

const esAdmin = (p: Perfil) => p.rol === 'admin'

/** permisos.<modulo>.lectura === true (admin bypass). */
function tieneLectura(p: Perfil, modulo: string): boolean {
  if (esAdmin(p)) return true
  return p.permisos?.[modulo]?.lectura === true
}

/** Flag booleano extra (mismo criterio que tieneFlag del middleware). */
function tieneFlagPerfil(p: Perfil, modulo: string, flag: string, defaultActual: boolean): boolean {
  if (esAdmin(p)) return true
  const v = p.permisos?.[modulo]?.[flag]
  return v === undefined ? defaultActual : Boolean(v)
}

const sinPermiso = (detalle: string) => ({ error: 'SIN_PERMISO' as const, detalle })

// ── Contexto que reciben todas las herramientas ───────────────────────

export type ToolCtx = {
  userId: string
  token: string
  perfil: Perfil
}

export interface AsistenteTool {
  name: string
  description: string
  input_schema: Anthropic.Tool.InputSchema
  run: (input: unknown, ctx: ToolCtx) => Promise<unknown>
}

// zod v4 → JSON Schema para input_schema de la API.
function jsonSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js['$schema']
  return js as Anthropic.Tool.InputSchema
}

const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD')

/** Hoy en hora argentina (UTC-3 fijo, sin DST). */
function hoyAR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
}

function haceDias(dias: number): string {
  return new Date(Date.now() - 3 * 3600 * 1000 - dias * 86_400_000).toISOString().slice(0, 10)
}

const num = (v: unknown) => Number(v ?? 0)
const round2 = (n: number) => Math.round(n * 100) / 100

/** Paginación sobre el hard cap de 1000 rows de PostgREST. */
async function paginar<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
  }
  return all
}

// ── 1. obras_activas ──────────────────────────────────────────────────

const ObrasActivasInput = z.object({})

async function obrasActivas(_input: unknown, ctx: ToolCtx) {
  if (!tieneLectura(ctx.perfil, 'tarja')) return sinPermiso('lectura del módulo tarja')

  const allowed = await getObrasDelUsuarioCached(ctx.userId, 'tarja')
  if (allowed != null && allowed.length === 0) return { total: 0, obras: [] }

  let q = supabase.from('obras').select('cod, nom').eq('archivada', false).order('cod')
  if (allowed != null) q = q.in('cod', allowed)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const obras = (data ?? []) as { cod: string; nom: string }[]
  return { total: obras.length, obras }
}

// ── 2. costo_obra ─────────────────────────────────────────────────────
// Mismo cálculo canónico que GET /api/horas/costo-obra (nació para el bot
// de WhatsApp — precedente exacto de una herramienta de asistente).

const CostoObraInput = z.object({
  obra_cod: z.string().min(1).describe('Código de la obra (ver obras_activas)'),
  desde:    FechaISO.optional().describe('Fecha inicial YYYY-MM-DD (opcional)'),
  hasta:    FechaISO.optional().describe('Fecha final YYYY-MM-DD (opcional)'),
})

async function costoObra(input: z.infer<typeof CostoObraInput>, ctx: ToolCtx) {
  if (!tieneLectura(ctx.perfil, 'tarja')) return sinPermiso('lectura del módulo tarja')
  // Mismo gate que el endpoint: requireFlag('tarja','ver_costos',true,true).
  if (!tieneFlagPerfil(ctx.perfil, 'tarja', 'ver_costos', true)) {
    return sinPermiso('flag ver_costos del módulo tarja')
  }

  const { obra_cod: obraCod, desde, hasta } = input
  const allowed = await getObrasDelUsuarioCached(ctx.userId, 'tarja')
  if (allowed != null && !allowed.includes(obraCod)) {
    return sinPermiso(`acceso a la obra ${obraCod}`)
  }

  const horasObra = await paginar<{ leg: string; fecha: string; horas: number }>((from, to) => {
    let q = supabase.from('horas')
      .select('leg, fecha, horas')
      .eq('obra_cod', obraCod)
      .gt('horas', 0)
      .order('fecha')
      .range(from, to)
    if (desde) q = q.gte('fecha', desde)
    if (hasta) q = q.lte('fecha', hasta)
    return q
  })

  const [extras, personal, categorias, tarifas, catObra] = await Promise.all([
    supabase.from('tarja_hs_extras').select('leg, sem_key, hs').eq('obra_cod', obraCod),
    supabase.from('personal').select('leg, cat_id, personal_cat_historial(cat_id, desde)'),
    supabase.from('categorias').select('id, vh, categoria_tarifas(vh, desde)'),
    supabase.from('tarifas').select('cat_id, vh, desde').eq('obra_cod', obraCod),
    supabase.from('cat_obra').select('leg, cat_id, desde').eq('obra_cod', obraCod),
  ])
  for (const r of [extras, personal, categorias, tarifas, catObra]) {
    if (r.error) throw new Error(r.error.message)
  }

  let extrasRows = (extras.data ?? []) as { leg: string; sem_key: string; hs: number }[]
  if (desde) extrasRows = extrasRows.filter(e => e.sem_key.slice(0, 10) >= viernesISO(desde))
  if (hasta) extrasRows = extrasRows.filter(e => e.sem_key.slice(0, 10) <= hasta)

  const resultado = calcularCostoObra({
    horas: horasObra,
    hsExtras: extrasRows,
    personal: (personal.data ?? []) as any,
    categorias: (categorias.data ?? []) as any,
    tarifas: (tarifas.data ?? []) as any,
    catObra: (catObra.data ?? []) as any,
    hoyISO: hoyAR(),
  })

  // Compacto: totales + últimas 8 semanas (el detalle completo puede ser
  // años de historia — no lo dumpeamos).
  return {
    obra_cod: obraCod,
    desde: desde ?? null,
    hasta: hasta ?? null,
    costo_total: resultado.total,
    horas_totales: resultado.horas,
    cantidad_semanas: resultado.semanas.length,
    ultimas_semanas: resultado.semanas.slice(-8),
  }
}

// ── 3. gastos_flota ───────────────────────────────────────────────────
// Reusa los reportes agregados de gastos.service (excluyen fleteros).

const GastosFlotaInput = z.object({
  desde:       FechaISO.describe('Fecha inicial YYYY-MM-DD'),
  hasta:       FechaISO.describe('Fecha final YYYY-MM-DD'),
  agrupar_por: z.enum(['resumen', 'chofer', 'camion', 'categoria']),
})

async function gastosFlota(input: z.infer<typeof GastosFlotaInput>, ctx: ToolCtx) {
  if (!tieneLectura(ctx.perfil, 'logistica')) return sinPermiso('lectura del módulo logistica')

  const { desde, hasta, agrupar_por } = input
  switch (agrupar_por) {
    case 'resumen':
      return await gastosService.reporteResumen(desde, hasta, ctx.token)
    case 'chofer': {
      const rows = await gastosService.reportePorChofer(desde, hasta, ctx.token)
      return { total_choferes: rows.length, top: rows.slice(0, 15) }
    }
    case 'camion': {
      const rows = await gastosService.reportePorCamion(desde, hasta, ctx.token)
      return { total_camiones: rows.length, top: rows.slice(0, 15) }
    }
    case 'categoria':
      return await gastosService.reportePorCategoria(desde, hasta, ctx.token)
  }
}

// ── 4. viajes ─────────────────────────────────────────────────────────

const ViajesInput = z.object({
  desde:         FechaISO.optional().describe('Fecha inicial YYYY-MM-DD (default: últimos 30 días)'),
  hasta:         FechaISO.optional().describe('Fecha final YYYY-MM-DD'),
  chofer_nombre: z.string().min(2).optional().describe('Filtrar por nombre (o parte) del chofer'),
})

type TramoRow = {
  fecha_operacion: string | null
  tipo: string | null
  estado: string | null
  toneladas_carga: number | null
  toneladas_descarga: number | null
  chofer: { nombre: string } | null
  cantera: { nombre: string } | null
  deposito: { nombre: string } | null
}

async function viajes(input: z.infer<typeof ViajesInput>, ctx: ToolCtx) {
  if (!tieneLectura(ctx.perfil, 'logistica')) return sinPermiso('lectura del módulo logistica')

  const desde = input.desde ?? haceDias(30)
  const hasta = input.hasta

  let choferIds: number[] | null = null
  if (input.chofer_nombre) {
    const safe = input.chofer_nombre.replace(/[\\%_,]/g, ' ')
    const { data: chs, error } = await supabase
      .from('choferes')
      .select('id, nombre')
      .ilike('nombre', `%${safe}%`)
    if (error) throw new Error(error.message)
    if (!chs || chs.length === 0) {
      return { error: 'CHOFER_NO_ENCONTRADO', detalle: `Ningún chofer matchea "${input.chofer_nombre}"` }
    }
    choferIds = chs.map(c => c.id as number)
  }

  const rows = await paginar<TramoRow>((from, to) => {
    let q = supabase.from('tramos')
      .select('fecha_operacion, tipo, estado, toneladas_carga, toneladas_descarga, chofer:choferes(nombre), cantera:canteras(nombre), deposito:depositos(nombre)')
      .gte('fecha_operacion', desde)
      .order('fecha_operacion', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (hasta) q = q.lte('fecha_operacion', hasta)
    if (choferIds) q = q.in('chofer_id', choferIds)
    return q as any
  })

  const cargados = rows.filter(t => t.tipo === 'cargado')
  const toneladas = cargados.reduce(
    (s, t) => s + num(t.toneladas_descarga ?? t.toneladas_carga), 0)

  return {
    desde,
    hasta: hasta ?? null,
    chofer_filtro: input.chofer_nombre ?? null,
    total_tramos: rows.length,
    cargados: cargados.length,
    vacios: rows.filter(t => t.tipo === 'vacio').length,
    completados: rows.filter(t => t.estado === 'completado').length,
    en_curso: rows.filter(t => t.estado === 'en_curso').length,
    toneladas_total: round2(toneladas),
    ultimos: rows.slice(0, 15).map(t => ({
      fecha: t.fecha_operacion,
      chofer: t.chofer?.nombre ?? null,
      tipo: t.tipo,
      estado: t.estado,
      ruta: `${t.cantera?.nombre ?? '?'} → ${t.deposito?.nombre ?? '?'}`,
      ton: num(t.toneladas_descarga ?? t.toneladas_carga) || null,
    })),
  }
}

// ── 5. saldos_choferes ────────────────────────────────────────────────

const SaldosChoferesInput = z.object({})

async function saldosChoferes(_input: unknown, ctx: ToolCtx) {
  if (!tieneLectura(ctx.perfil, 'logistica')) return sinPermiso('lectura del módulo logistica')

  const [choferesRes, adelantosRes, liqsRes] = await Promise.all([
    supabase.from('choferes').select('id, nombre'),
    // liquidacion_id null = adelanto todavía no descontado en una liquidación.
    supabase.from('adelantos').select('chofer_id, monto').is('liquidacion_id', null),
    supabase.from('liquidaciones')
      .select('chofer_id, fecha_hasta, total_neto, estado')
      .order('fecha_hasta', { ascending: false }),
  ])
  for (const r of [choferesRes, adelantosRes, liqsRes]) {
    if (r.error) throw new Error(r.error.message)
  }

  const nombrePorId = new Map<number, string>(
    ((choferesRes.data ?? []) as { id: number; nombre: string }[]).map(c => [c.id, c.nombre]))

  const pendientes = new Map<number, { total: number; count: number }>()
  for (const a of (adelantosRes.data ?? []) as { chofer_id: number | null; monto: number }[]) {
    if (a.chofer_id == null) continue
    const e = pendientes.get(a.chofer_id) ?? { total: 0, count: 0 }
    e.total += num(a.monto)
    e.count += 1
    pendientes.set(a.chofer_id, e)
  }

  const ultimaLiq = new Map<number, { fecha_hasta: string; total_neto: number; estado: string }>()
  for (const l of (liqsRes.data ?? []) as { chofer_id: number; fecha_hasta: string; total_neto: number; estado: string }[]) {
    if (!ultimaLiq.has(l.chofer_id)) {
      ultimaLiq.set(l.chofer_id, { fecha_hasta: l.fecha_hasta, total_neto: num(l.total_neto), estado: l.estado })
    }
  }

  const ids = new Set<number>([...pendientes.keys(), ...ultimaLiq.keys()])
  const choferes = [...ids].map(id => ({
    chofer: nombrePorId.get(id) ?? `#${id}`,
    adelantos_pendientes: pendientes.get(id)?.total ?? 0,
    adelantos_pendientes_count: pendientes.get(id)?.count ?? 0,
    ultima_liquidacion: ultimaLiq.get(id) ?? null,
  })).sort((a, b) => b.adelantos_pendientes - a.adelantos_pendientes)

  return { choferes }
}

// ── 6. prestamos_operarios ────────────────────────────────────────────
// Préstamos es un tab de tarja (permisos vía tarja.*) pero también existe
// el módulo prestamos asignable → alcanza con lectura de cualquiera.
// Nombres de operarios SOLO con flag tarja.ver_pii (default false); si no,
// se devuelven solo legajos.

const PrestamosOperariosInput = z.object({
  leg: z.string().min(1).optional().describe('Legajo de un operario puntual (opcional)'),
})

async function prestamosOperarios(input: z.infer<typeof PrestamosOperariosInput>, ctx: ToolCtx) {
  const puede = tieneLectura(ctx.perfil, 'prestamos') || tieneLectura(ctx.perfil, 'tarja')
  if (!puede) return sinPermiso('lectura del módulo prestamos (o tarja)')

  const rows = await paginar<{ leg: string; tipo: string; monto: number }>((from, to) => {
    let q = supabase.from('prestamos').select('leg, tipo, monto').order('id').range(from, to)
    if (input.leg) q = q.eq('leg', input.leg)
    return q
  })

  type Acum = { otorgado: number; descontado: number; incobrable: number }
  const porLeg = new Map<string, Acum>()
  for (const r of rows) {
    const e = porLeg.get(r.leg) ?? { otorgado: 0, descontado: 0, incobrable: 0 }
    if (r.tipo === 'otorgado') e.otorgado += num(r.monto)
    else if (r.tipo === 'descontado') e.descontado += num(r.monto)
    else if (r.tipo === 'incobrable') e.incobrable += num(r.monto)
    porLeg.set(r.leg, e)
  }

  // saldo = otorgado − descontado − incobrable (los incobrables saldan la
  // deuda pero se reportan aparte como pérdida).
  let operarios = [...porLeg.entries()].map(([leg, a]) => ({
    leg,
    otorgado: a.otorgado,
    descontado: a.descontado,
    incobrable: a.incobrable,
    saldo: a.otorgado - a.descontado - a.incobrable,
  }))
  // Sin leg puntual: solo los que tienen saldo distinto de 0, top 30.
  if (!input.leg) {
    operarios = operarios.filter(o => o.saldo !== 0)
  }
  operarios.sort((a, b) => b.saldo - a.saldo)
  const top = operarios.slice(0, 30)

  // PII: nombres solo con tarja.ver_pii.
  const verPii = tieneFlagPerfil(ctx.perfil, 'tarja', 'ver_pii', false)
  let conNombre: Array<Record<string, unknown>> = top
  if (verPii && top.length > 0) {
    const { data: pers, error } = await supabase
      .from('personal')
      .select('leg, nom')
      .in('leg', top.map(o => o.leg))
    if (error) throw new Error(error.message)
    const nomPorLeg = new Map(((pers ?? []) as { leg: string; nom: string }[]).map(p => [p.leg, p.nom]))
    conNombre = top.map(o => ({ ...o, nombre: nomPorLeg.get(o.leg) ?? null }))
  }

  const totales = operarios.reduce(
    (t, o) => ({
      otorgado: t.otorgado + o.otorgado,
      descontado: t.descontado + o.descontado,
      incobrable: t.incobrable + o.incobrable,
      saldo: t.saldo + o.saldo,
    }),
    { otorgado: 0, descontado: 0, incobrable: 0, saldo: 0 },
  )

  return {
    leg_filtro: input.leg ?? null,
    nombres_incluidos: verPii,
    totales,
    operarios_con_saldo: operarios.length,
    operarios: conNombre,
  }
}

// ── 7. stock_deposito ─────────────────────────────────────────────────

const StockDepositoInput = z.object({
  buscar: z.string().min(2).optional().describe('Texto para filtrar materiales por nombre (opcional)'),
})

async function stockDeposito(input: z.infer<typeof StockDepositoInput>, ctx: ToolCtx) {
  if (!tieneLectura(ctx.perfil, 'certificaciones')) {
    return sinPermiso('lectura del módulo certificaciones')
  }

  let qMat = supabase
    .from('stock_materiales')
    .select('id, nombre, unidad, stock_rubros(nombre)')
    .eq('activo', true)
  if (input.buscar) {
    const safe = input.buscar.replace(/[\\%_,]/g, ' ')
    qMat = qMat.ilike('nombre', `%${safe}%`)
  }
  const { data: mats, error: eMat } = await qMat
  if (eMat) throw new Error(eMat.message)
  const materiales = (mats ?? []) as unknown as Array<{
    id: number; nombre: string; unidad: string | null; stock_rubros: { nombre: string } | null
  }>
  if (materiales.length === 0) {
    return { buscar: input.buscar ?? null, total: 0, materiales: [] }
  }

  const matIds = materiales.map(m => m.id)
  const movs = await paginar<{ material_id: number; tipo: string; cantidad: number }>((from, to) => {
    let q = supabase.from('stock_movimientos')
      .select('material_id, tipo, cantidad')
      .order('id')
      .range(from, to)
    // Con filtro de texto acotamos los movimientos a esos materiales.
    if (input.buscar) q = q.in('material_id', matIds)
    return q
  })

  // saldo = entradas − salidas (± ajustes, cuya cantidad es delta firmado).
  const saldoPorMat = new Map<number, number>()
  for (const m of movs) {
    const delta =
      m.tipo === 'entrada' ? num(m.cantidad) :
      m.tipo === 'salida'  ? -num(m.cantidad) :
      num(m.cantidad) // ajuste: delta firmado
    saldoPorMat.set(m.material_id, (saldoPorMat.get(m.material_id) ?? 0) + delta)
  }

  const conSaldo = materiales
    .map(m => ({
      material: m.nombre,
      rubro: m.stock_rubros?.nombre ?? null,
      unidad: m.unidad ?? 'unid',
      saldo: round2(saldoPorMat.get(m.id) ?? 0),
    }))
    .filter(m => m.saldo !== 0)
    .sort((a, b) => b.saldo - a.saldo)

  return {
    buscar: input.buscar ?? null,
    total_con_saldo: conSaldo.length,
    materiales: conSaldo.slice(0, 30),
  }
}

// ── Registro de herramientas ──────────────────────────────────────────
// PROHIBIDO acá: herramientas sobre sueldos de oficina (oficina_*) y
// cualquier escritura. No agregar "de yapa".

function conValidacion<S extends z.ZodType>(
  schema: S,
  fn: (input: z.infer<S>, ctx: ToolCtx) => Promise<unknown>,
): AsistenteTool['run'] {
  return async (input, ctx) => {
    const parsed = schema.safeParse(input ?? {})
    if (!parsed.success) {
      return { error: 'INPUT_INVALIDO', detalle: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
    }
    return fn(parsed.data, ctx)
  }
}

export const ASISTENTE_TOOLS: AsistenteTool[] = [
  {
    name: 'obras_activas',
    description:
      'Lista las obras activas (código y nombre) visibles para el usuario que pregunta. Usar para resolver el código de una obra antes de consultar costos.',
    input_schema: jsonSchema(ObrasActivasInput),
    run: conValidacion(ObrasActivasInput, obrasActivas),
  },
  {
    name: 'costo_obra',
    description:
      'Costo de MANO DE OBRA de una obra (cálculo canónico de tarja, semana viernes→jueves), con total, horas y últimas semanas. Rango de fechas opcional.',
    input_schema: jsonSchema(CostoObraInput),
    run: conValidacion(CostoObraInput, costoObra),
  },
  {
    name: 'gastos_flota',
    description:
      'Gastos de la flota propia de logística (combustible, peajes, viáticos, etc.) en un rango de fechas, agregados como resumen general o por chofer, camión o categoría. Excluye fleteros.',
    input_schema: jsonSchema(GastosFlotaInput),
    run: conValidacion(GastosFlotaInput, gastosFlota),
  },
  {
    name: 'viajes',
    description:
      'Tramos/viajes de logística (cargados y vacíos) con chofer, ruta cantera→depósito y toneladas: totales agregados + últimos 15. Sin rango, usa los últimos 30 días. Filtro opcional por nombre de chofer (matcheo parcial).',
    input_schema: jsonSchema(ViajesInput),
    run: conValidacion(ViajesInput, viajes),
  },
  {
    name: 'saldos_choferes',
    description:
      'Por chofer: suma de adelantos pendientes de liquidar y datos de su última liquidación (fecha, neto, estado).',
    input_schema: jsonSchema(SaldosChoferesInput),
    run: conValidacion(SaldosChoferesInput, saldosChoferes),
  },
  {
    name: 'prestamos_operarios',
    description:
      'Saldo de préstamos de operarios: otorgado − descontado − incobrable, totales y top por saldo. Filtro opcional por legajo. Los nombres solo aparecen si el usuario puede ver PII.',
    input_schema: jsonSchema(PrestamosOperariosInput),
    run: conValidacion(PrestamosOperariosInput, prestamosOperarios),
  },
  {
    name: 'stock_deposito',
    description:
      'Stock del depósito central: materiales con su saldo actual (entradas − salidas), top 30, con filtro de texto opcional por nombre de material.',
    input_schema: jsonSchema(StockDepositoInput),
    run: conValidacion(StockDepositoInput, stockDeposito),
  },
]
