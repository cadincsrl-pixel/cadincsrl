// Cuenta corriente de obras sobre `materiales_a_cuenta_cliente` (MCC): el
// listado de qué salió a cada obra y quién lo paga.
//
// `pagado_por` distingue quién le pagó al proveedor ('cadinc' adelantó, o
// 'cliente' pagó directo: rendición) y `a_cargo_de` (20260904ak) de quién es
// el gasto ('cliente' se cobra, 'cadinc' llave en mano o EPP). La vista
// v_cuenta_corriente los combina en UN estado por renglón (20260904ap).
//
// Cobros con imputación (2026-07-21): cada fila MCC puede quedar vinculada a
// UN cobro (cobro_id + monto_cobrado congelado). El registro/eliminación van
// por RPCs transaccionales (registrar_cobro_cuenta_cliente /
// eliminar_cobro_cuenta_cliente) — SECURITY DEFINER, SIEMPRE con supabaseAdmin
// (CLAUDE.md §9); el scope de obra se valida en las routes ANTES de llamarlas.

import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import type { CrearCobroDto, EditarCobroDto, EmitirCertificadoDto } from './cuenta-cliente.schema.js'
import { normTxt } from '../../lib/norm-txt.js'
import { calcularCostoObra, viernesISO } from '../horas/costo-obra.js'
import { todasLasFilas } from '../../lib/paginar.js'

const BUCKET_COBROS = 'cobros-docs'

export class CcHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'CcHttpError'
  }
}

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png')  return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

function pathForUploadCobro(contentType: string): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `cuenta-cliente/${yyyy}/${mm}/${randomUUID()}.${extFromMime(contentType)}`
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

// Pagina de a 1000 (hard cap de PostgREST que NO se bypassea con .range
// grande — CLAUDE.md §5.7). El MCC ya está en ~1000 filas totales: sin esto
// los KPIs del frontend se truncarían en silencio.
async function fetchAllMcc(buildQuery: (from: number, to: number) => any) {
  const PAGE = 1000
  const all: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return all
}

/**
 * Filtros de la cuenta corriente (20260904ap). Los mismos alimentan el listado
 * paginado (PostgREST sobre v_cuenta_corriente) y el resumen (RPC).
 */
export interface CuentaFiltro {
  obra_cod?:     string
  estados?:      string[]
  tipo?:         'material' | 'epp'
  sin_precio?:   boolean
  proveedor_id?: number
  origen?:       'proveedor' | 'deposito'
  desde?:        string
  hasta?:        string
  q?:            string
  archivadas?:   boolean
  /**
   * Recorta por destino interno de CADINC (obras.es_interna).
   *   undefined → todo, que es como se comportó siempre la cuenta corriente
   *   true      → solo el pañol y los otros centros internos
   *   false     → solo las obras de verdad
   * Lo fuerza el handler de /interno, nunca se lee del query string: si viniera
   * de afuera, esa pantalla podría pedir la deuda de un cliente con una URL
   * armada a mano, que es justo lo que el tab aparte evita.
   */
  solo_internas?: boolean
}

// Palabras del buscador normalizadas igual que `busq` en la vista (norm_txt):
// sin acentos ni signos, así "#634" busca "634" y "cañería" busca "caneria".
function palabras(q?: string): string[] {
  return normTxt(q ?? '').split(' ').filter(Boolean)
}

// ── Imputar lo pagado (2026-09-08) ────────────────────────────────────
// En una obra por administración el pago del cliente entra "a cuenta", así que
// nada se congela solo. Este bloque reparte lo pagado sobre lo facturable,
// PRIMERO LO VIEJO (regla del user), y congela lo cubierto: los materiales vía
// cobro_id (pasan a "Cobrado", precio clavado) y las semanas de jornales y
// contratistas vía cuenta_admin_imputaciones (el facturable de ese momento
// queda guardado y la cuenta lo usa en lugar del cálculo vivo).

export interface ItemImputable {
  /** 'operarios' | 'contratistas' | 'material' */
  tipo: 'operarios' | 'contratistas' | 'material'
  /** sem_key para las patas semanales, id de MCC para materiales. */
  clave: string
  fecha: string
  monto: number
}

export interface CobroCapacidad { id: number; capacidad: number }

/**
 * Reparte los ítems sobre los pagos: cronológico, ítems enteros (nunca se
 * parte uno entre dos pagos), y si uno no entra en ningún pago se saltea y se
 * sigue con el resto — igual que hace la pantalla al imputar a mano.
 */
export function asignarImputaciones(items: ItemImputable[], cobros: CobroCapacidad[]) {
  // Si la plata alcanza para TODO, el orden de prioridad deja de importar y el
  // problema es puro empaquetado: colocar cada ítem entero en algún pago.
  // Primero se intenta el empaquetado bueno (más grande primero, al hueco más
  // justo — best fit decreasing); si logra cubrir todo, listo. Solo cuando no
  // alcanza para todo entra la regla de prioridad: primero lo viejo.
  // Caso real que lo exige: Belén pagó $9.000.000 contra $8.905.208 — sobra
  // plata, pero el ítem más nuevo ($1.394.000) no entraba en ningún resto del
  // reparto cronológico y quedaba sin congelar.
  const bfd = (() => {
    const restante = new Map(cobros.map(c => [c.id, c.capacidad]))
    const asignados: (ItemImputable & { cobro_id: number })[] = []
    for (const item of [...items].sort((a, b) => b.monto - a.monto)) {
      let mejor: number | null = null
      for (const c of cobros) {
        const r = restante.get(c.id) ?? 0
        if (r >= item.monto && (mejor === null || r < (restante.get(mejor) ?? 0))) mejor = c.id
      }
      if (mejor === null) return null
      restante.set(mejor, (restante.get(mejor) ?? 0) - item.monto)
      asignados.push({ ...item, cobro_id: mejor })
    }
    return asignados
  })()
  if (bfd) return { asignados: bfd, sinCubrir: [] as ItemImputable[] }

  const orden = { operarios: 0, contratistas: 1, material: 2 } as const
  const pendientes = [...items].sort((a, b) =>
    a.fecha.localeCompare(b.fecha) || orden[a.tipo] - orden[b.tipo] || a.clave.localeCompare(b.clave))
  const restante = new Map(cobros.map(c => [c.id, c.capacidad]))
  const asignados: (ItemImputable & { cobro_id: number })[] = []
  const sinCubrir: ItemImputable[] = []
  for (const item of pendientes) {
    const cobro = cobros.find(c => (restante.get(c.id) ?? 0) >= item.monto)
    if (!cobro) { sinCubrir.push(item); continue }
    restante.set(cobro.id, (restante.get(cobro.id) ?? 0) - item.monto)
    asignados.push({ ...item, cobro_id: cobro.id })
  }

  // Segunda pasada: reubicación de un nivel. Un ítem grande y nuevo puede no
  // entrar entero en ningún resto aunque la plata total sobre (los pagos
  // quedaron fragmentados por los ítems viejos). Antes de darlo por sin
  // cubrir, se intenta mover ítems chicos de un pago con capacidad hacia otros
  // restos, para hacerle lugar al grande. Caso real: el Bercovich de Belén,
  // $1.394.000 con $1.488.791 libres repartidos en migajas.
  for (const grande of [...sinCubrir]) {
    let hecho = false
    for (const bin of cobros) {
      if (bin.capacidad < grande.monto || hecho) continue
      const enElBin = asignados.filter(a => a.cobro_id === bin.id).sort((a, b) => a.monto - b.monto)
      const movidos: typeof asignados = []
      let libre = restante.get(bin.id) ?? 0
      for (const chico of enElBin) {
        if (libre >= grande.monto) break
        const destino = cobros.find(c => c.id !== bin.id && (restante.get(c.id) ?? 0) >= chico.monto)
        if (!destino) continue
        restante.set(destino.id, (restante.get(destino.id) ?? 0) - chico.monto)
        chico.cobro_id = destino.id
        movidos.push(chico)
        libre += chico.monto
      }
      if (libre >= grande.monto) {
        restante.set(bin.id, libre - grande.monto)
        asignados.push({ ...grande, cobro_id: bin.id })
        sinCubrir.splice(sinCubrir.indexOf(grande), 1)
        hecho = true
      } else {
        // No alcanzó: deshacer los movimientos de este intento.
        for (const m of movidos) {
          restante.set(m.cobro_id, (restante.get(m.cobro_id) ?? 0) + m.monto)
          m.cobro_id = bin.id
        }
      }
    }
  }
  return { asignados, sinCubrir }
}

export const cuentaClienteService = {
  // ── Cuenta corriente (20260904ap) ────────────────────────────────────

  /**
   * Renglones de la cuenta corriente, paginados y filtrados en el server.
   * `allowed` null = alcance global (no se filtra por obra).
   */
  async getRenglones(allowed: string[] | null, f: CuentaFiltro, limit: number, offset: number, token: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase.from('v_cuenta_corriente').select('*', { count: 'exact' })
    if (allowed) q = q.in('obra_cod', allowed)
    if (f.obra_cod) q = q.eq('obra_cod', f.obra_cod)
    else if (!f.archivadas) q = q.eq('obra_archivada', false)
    if (f.estados?.length) q = q.in('estado', f.estados)
    if (f.tipo) q = q.eq('tipo', f.tipo)
    if (f.sin_precio) q = q.eq('precio_unit', 0)
    if (f.proveedor_id) q = q.eq('proveedor_id', f.proveedor_id)
    if (f.origen) q = q.eq('origen', f.origen)
    if (f.solo_internas !== undefined) q = q.eq('obra_interna', f.solo_internas)
    if (f.desde) q = q.gte('fecha_resolucion', f.desde)
    if (f.hasta) q = q.lte('fecha_resolucion', f.hasta)
    for (const w of palabras(f.q)) q = q.ilike('busq', `%${w}%`)
    const { data, error, count } = await q
      .order('fecha_resolucion', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw new Error(error.message)
    return { items: data ?? [], total: count ?? 0, limit, offset }
  },

  /**
   * Totales del conjunto filtrado por grupo (obra | mes | proveedor) × estado
   * × tipo, más Σ pagos por obra. A propósito NO filtra por estado ni tipo:
   * el frontend recorta esas dos dimensiones sobre el resultado, así los chips
   * muestran cuánto hay en cada una con los demás filtros puestos.
   */
  async getResumen(allowed: string[] | null, f: CuentaFiltro, grupo: 'obra' | 'mes' | 'proveedor', token: string) {
    const supabase = createSupabaseClient(token)
    const pal = palabras(f.q)
    const [g, p] = await Promise.all([
      supabase.rpc('cuenta_corriente_resumen', {
        p_obras:        allowed,
        p_obra_cod:     f.obra_cod ?? null,
        p_grupo:        grupo,
        p_sin_precio:   !!f.sin_precio,
        p_proveedor_id: f.proveedor_id ?? null,
        p_origen:       f.origen ?? null,
        p_desde:        f.desde ?? null,
        p_hasta:        f.hasta ?? null,
        p_palabras:     pal.length ? pal : null,
        p_archivadas:   !!f.archivadas,
        p_solo_internas: f.solo_internas ?? null,
      }),
      supabase.rpc('cuenta_corriente_pagos', { p_obras: allowed, p_obra_cod: f.obra_cod ?? null }),
    ])
    if (g.error) throw new Error(g.error.message)
    if (p.error) throw new Error(p.error.message)
    return { grupos: g.data ?? [], pagos: p.data ?? [] }
  },

  /**
   * Gasto de los centros internos (pañol, mantenimiento, herreros, logística,
   * poda) para la pestaña "Gasto interno".
   *
   * Sale del MISMO ledger que la cuenta corriente (v_cuenta_corriente), no de
   * una vista paralela sobre los pedidos: dos orígenes darían dos totales
   * distintos para la misma obra y el número dejaría de creerse.
   *
   * La excepción son las herramientas, que MCC excluye a propósito (una
   * herramienta va y vuelve, no se le factura a nadie). Vienen aparte, de la
   * RPC gasto_interno_herramientas, y el front las muestra en su propia columna
   * etiquetada como patrimonio — no sumadas al consumo del mes.
   */
  /**
   * Imputa lo pagado de una obra: reparte los pagos sobre lo facturable,
   * primero lo viejo, y congela lo cubierto. Materiales → cobro_id (estado
   * "Cobrado"); semanas de jornales/contratistas → cuenta_admin_imputaciones
   * con el facturable de este momento. Idempotente: lo ya congelado no se
   * vuelve a repartir.
   */
  async imputarPagado(obraCod: string, userId: string) {
    const { data: obra } = await supabaseAdmin
      .from('obras').select('cod, por_administracion').eq('cod', obraCod).maybeSingle()
    if (!obra) throw new CcHttpError(404, 'OBRA_INEXISTENTE')

    // Capacidad de cada pago = monto − materiales ya imputados − semanas ya congeladas.
    const [cobrosR, imputMat, imputSem] = await Promise.all([
      supabaseAdmin.from('cuenta_cliente_cobros').select('id, fecha, monto').eq('obra_cod', obraCod).order('fecha').order('id'),
      supabaseAdmin.from('materiales_a_cuenta_cliente').select('cobro_id, monto_cobrado').eq('obra_cod', obraCod).not('cobro_id', 'is', null),
      supabaseAdmin.from('cuenta_admin_imputaciones').select('sem_key, pata, cobro_id, monto').eq('obra_cod', obraCod),
    ])
    for (const r of [cobrosR, imputMat, imputSem]) if (r.error) throw new Error(r.error.message)
    const usado = new Map<number, number>()
    for (const m of imputMat.data ?? []) usado.set(m.cobro_id!, (usado.get(m.cobro_id!) ?? 0) + Number(m.monto_cobrado ?? 0))
    for (const i of imputSem.data ?? []) usado.set(i.cobro_id, (usado.get(i.cobro_id) ?? 0) + Number(i.monto))
    const cobros: CobroCapacidad[] = (cobrosR.data ?? []).map(c => ({
      id: c.id, capacidad: Number(c.monto) - (usado.get(c.id) ?? 0),
    }))

    const items: ItemImputable[] = []

    // Materiales con precio, todavía vivos.
    const { data: mats, error: eMat } = await supabaseAdmin
      .from('materiales_a_cuenta_cliente')
      .select('id, fecha_resolucion, precio_total, pagado_por')
      .eq('obra_cod', obraCod).is('cobro_id', null).gt('precio_total', 0)
    if (eMat) throw new Error(eMat.message)
    for (const m of mats ?? []) {
      // Lo que el cliente pagó directo al proveedor no es deuda: no se imputa.
      if (m.pagado_por === 'cliente') continue
      items.push({ tipo: 'material', clave: String(m.id), fecha: m.fecha_resolucion ?? '9999-12-31', monto: Number(m.precio_total) })
    }

    // Semanas de jornales y contratistas, solo en obras por administración y
    // solo las TERMINADAS: la semana en curso todavía suma horas.
    const yaCongeladas = new Set((imputSem.data ?? []).map(i => `${i.sem_key}|${i.pata}`))
    const hoyISO = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
    const viernesActual = viernesISO(hoyISO)
    if (obra.por_administracion) {
      const [horas, extras, personal, categorias, tarifas, catObra, pctsR, certsR] = await Promise.all([
        todasLasFilas<{ leg: string; fecha: string; horas: number }>((d, h) =>
          supabaseAdmin.from('horas').select('leg, fecha, horas').eq('obra_cod', obraCod).gt('horas', 0).order('fecha').order('id').range(d, h)),
        supabaseAdmin.from('tarja_hs_extras').select('leg, sem_key, hs').eq('obra_cod', obraCod),
        supabaseAdmin.from('personal').select('leg, cat_id, personal_cat_historial(cat_id, desde)'),
        supabaseAdmin.from('categorias').select('id, vh, categoria_tarifas(vh, desde)'),
        supabaseAdmin.from('tarifas').select('cat_id, vh, desde').eq('obra_cod', obraCod),
        supabaseAdmin.from('cat_obra').select('leg, cat_id, desde').eq('obra_cod', obraCod),
        supabaseAdmin.from('obras_admin_tarifas').select('desde, pct_operarios, pct_contratistas').eq('obra_cod', obraCod).order('desde'),
        supabaseAdmin.from('certificaciones').select('sem_key, monto').eq('obra_cod', obraCod),
      ])
      for (const r of [extras, personal, categorias, tarifas, catObra, pctsR, certsR]) {
        if ((r as { error: { message: string } | null }).error) throw new Error((r as { error: { message: string } }).error.message)
      }
      const pcts = pctsR.data ?? []
      const pctEn = (sem: string, pata: 'pct_operarios' | 'pct_contratistas') => {
        let vigente: number | null = null
        for (const t of pcts) if (String(t.desde) <= sem) vigente = Number(t[pata])
        return vigente ?? 0
      }

      const costo = calcularCostoObra({
        horas: horas as never, hsExtras: (extras.data ?? []) as never,
        personal: (personal.data ?? []) as never, categorias: (categorias.data ?? []) as never,
        tarifas: (tarifas.data ?? []) as never, catObra: (catObra.data ?? []) as never,
        hoyISO,
      })
      for (const sem of costo.semanas) {
        if (sem.sem_key >= viernesActual) continue
        if (sem.costo <= 0 || yaCongeladas.has(`${sem.sem_key}|operarios`)) continue
        items.push({
          tipo: 'operarios', clave: sem.sem_key, fecha: sem.sem_key,
          monto: Math.round(sem.costo * (1 + pctEn(sem.sem_key, 'pct_operarios') / 100) * 100) / 100,
        })
      }
      const certPorSem = new Map<string, number>()
      for (const c of certsR.data ?? []) {
        const k = String(c.sem_key).slice(0, 10)
        certPorSem.set(k, (certPorSem.get(k) ?? 0) + Number(c.monto ?? 0))
      }
      for (const [sem, monto] of certPorSem) {
        if (sem >= viernesActual || monto <= 0 || yaCongeladas.has(`${sem}|contratistas`)) continue
        items.push({
          tipo: 'contratistas', clave: sem, fecha: sem,
          monto: Math.round(monto * (1 + pctEn(sem, 'pct_contratistas') / 100) * 100) / 100,
        })
      }
    }

    const { asignados, sinCubrir } = asignarImputaciones(items, cobros)

    // Escribir: materiales primero (falla temprano si algo cambió), semanas después.
    for (const a of asignados) {
      if (a.tipo === 'material') {
        const { error } = await supabaseAdmin
          .from('materiales_a_cuenta_cliente')
          .update({ cobro_id: a.cobro_id, monto_cobrado: a.monto, updated_at: new Date().toISOString() })
          .eq('id', Number(a.clave)).is('cobro_id', null)
        if (error) throw new Error(error.message)
      }
    }
    const semanasNuevas = asignados
      .filter(a => a.tipo !== 'material')
      .map(a => ({
        obra_cod: obraCod, sem_key: a.clave, pata: a.tipo,
        monto: a.monto, cobro_id: a.cobro_id, created_by: userId,
      }))
    if (semanasNuevas.length) {
      const { error } = await supabaseAdmin.from('cuenta_admin_imputaciones').insert(semanasNuevas)
      if (error) throw new Error(error.message)
    }

    const suma = (xs: { monto: number }[]) => Math.round(xs.reduce((s, x) => s + x.monto, 0) * 100) / 100
    return {
      congelado: {
        operarios:    { n: asignados.filter(a => a.tipo === 'operarios').length,    monto: suma(asignados.filter(a => a.tipo === 'operarios')) },
        contratistas: { n: asignados.filter(a => a.tipo === 'contratistas').length, monto: suma(asignados.filter(a => a.tipo === 'contratistas')) },
        materiales:   { n: asignados.filter(a => a.tipo === 'material').length,     monto: suma(asignados.filter(a => a.tipo === 'material')) },
      },
      sin_cubrir: { n: sinCubrir.length, monto: suma(sinCubrir) },
    }
  },

  async getGastoInterno(allowed: string[] | null, f: CuentaFiltro, grupo: 'obra' | 'mes' | 'proveedor', token: string) {
    const interno = { ...f, solo_internas: true }
    const supabase = createSupabaseClient(token)
    const [base, herr] = await Promise.all([
      this.getResumen(allowed, interno, grupo, token),
      supabase.rpc('gasto_interno_herramientas', {
        p_obras:    allowed,
        p_obra_cod: f.obra_cod ?? null,
        p_desde:    f.desde ?? null,
        p_hasta:    f.hasta ?? null,
      }),
    ])
    if (herr.error) throw new Error(herr.error.message)
    return { ...base, herramientas: herr.data ?? [] }
  },

  /**
   * Conteo de materiales "sin precio" (precio_unit=0, a tasar) por obra, en
   * las obras dadas (null = todas, para admin). Sirve para que Alina/Nicolás
   * vean los pendientes de tasar sin recorrer obra por obra. Devuelve
   * [{ obra_cod, sin_precio }] ordenado de mayor a menor.
   */
  async pendientesDePrecio(obraCods: string[] | null, token: string) {
    const supabase = createSupabaseClient(token)
    // Vista agregada (una fila por obra) para no chocar con el cap de 1000 de
    // PostgREST si crece el backlog de ítems sin tasar (CLAUDE.md §5.7).
    // Se trae `obra_archivada` y NO se filtra: la alerta muestra las dos cosas.
    // Esconder las archivadas perdería trabajo real (hoy 148 renglones en 7
    // obras cerradas), y el chip de una archivada SÍ lleva a sus renglones,
    // porque con `obra_cod` puesto `getRenglones()` saltea el filtro. Lo que
    // faltaba era que el front pudiera distinguirlas y decirlo.
    const base = supabase.from('v_cuenta_cliente_pendientes').select('obra_cod, sin_precio, obra_archivada, obra_nom, esperando')
    const { data, error } = obraCods != null ? await base.in('obra_cod', obraCods) : await base
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<{ obra_cod: string; sin_precio: number; obra_archivada: boolean; obra_nom: string; esperando: number }>)
      // Las vivas primero: son las accionables. Dentro de cada grupo, por volumen.
      .sort((a, b) => Number(a.obra_archivada) - Number(b.obra_archivada) || b.sin_precio - a.sin_precio)
  },

  // ── Cobros (pagos del cliente a cuenta de la obra) ───────────────────

  /** Cobros de una obra, más recientes primero. */
  async getCobros(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    return fetchAllMcc((from, to) => supabase
      .from('cuenta_cliente_cobros')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to))
  },

  /** Cobros de varias obras (para los KPIs de la vista "todas mis obras").
   *  Paginado igual que el MCC: sin esto el KPI Pagado agregado se truncaría
   *  en silencio al pasar 1000 cobros. */
  async getCobrosByObras(obraCods: string[], token: string) {
    if (obraCods.length === 0) return []
    const supabase = createSupabaseClient(token)
    return fetchAllMcc((from, to) => supabase
      .from('cuenta_cliente_cobros')
      .select('*')
      .in('obra_cod', obraCods)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to))
  },

  /** obra_cod de un cobro (para validar scope en PATCH/DELETE). null si no existe. */
  async getCobroObra(id: number, token: string): Promise<string | null> {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros').select('obra_cod').eq('id', id).maybeSingle()
    if (error) throw new Error(error.message)
    return data?.obra_cod ?? null
  },

  /**
   * Registra un cobro imputando (opcionalmente) items del MCC, vía RPC
   * transaccional con advisory lock por obra. Si vino comprobante, primero
   * se descarga del bucket para calcular el sha256 (dedup); si la RPC
   * rebota, el archivo huérfano se borra del bucket.
   */
  async crearCobro(dto: CrearCobroDto, _token: string, userId: string) {
    let comprobanteUrl: string | null = null
    let comprobanteHash: string | null = null
    if (dto.comprobante_path) {
      const dl = await supabaseAdmin.storage.from(BUCKET_COBROS).download(dto.comprobante_path)
      if (dl.error || !dl.data) {
        throw new CcHttpError(400, 'COMPROBANTE_INEXISTENTE', { path: dto.comprobante_path })
      }
      comprobanteUrl = dto.comprobante_path
      comprobanteHash = await sha256OfBlob(dl.data)
    }

    const { data, error } = await supabaseAdmin.rpc('registrar_cobro_cuenta_cliente', {
      p_obra_cod:         dto.obra_cod,
      p_fecha:            dto.fecha,
      p_monto:            dto.monto,
      p_medio:            dto.medio,
      p_obs:              dto.obs ?? null,
      p_comprobante_url:  comprobanteUrl,
      p_comprobante_hash: comprobanteHash,
      p_item_ids:         dto.item_ids ?? [],
      p_user_id:          userId,
      p_certificado_id:     dto.certificado_id ?? null,
      p_monto_mano_de_obra: dto.monto_mano_de_obra ?? 0,
    })
    if (error) {
      // La RPC rechazó: el comprobante recién subido queda huérfano → limpiar.
      if (comprobanteUrl) {
        await supabaseAdmin.storage.from(BUCKET_COBROS).remove([comprobanteUrl]).catch(() => undefined)
      }
      const msg = error.message || ''
      if (msg.includes('COMPROBANTE_DUPLICADO')) throw new CcHttpError(409, 'COMPROBANTE_DUPLICADO')
      if (msg.includes('ITEM_INVALIDO'))         throw new CcHttpError(400, 'ITEM_INVALIDO')
      if (msg.includes('MONTO_INSUFICIENTE'))    throw new CcHttpError(400, 'MONTO_INSUFICIENTE')
      if (msg.includes('CERTIFICADO_NO_EXISTE'))     throw new CcHttpError(404, 'CERTIFICADO_NO_EXISTE')
      if (msg.includes('CERTIFICADO_ANULADO'))       throw new CcHttpError(409, 'CERTIFICADO_ANULADO')
      if (msg.includes('CERTIFICADO_DE_OTRA_OBRA'))  throw new CcHttpError(400, 'CERTIFICADO_DE_OTRA_OBRA')
      if (msg.includes('MANO_DE_OBRA_INVALIDA'))     throw new CcHttpError(400, 'MANO_DE_OBRA_INVALIDA')
      throw new Error(msg)
    }
    return data
  },

  // ── Certificados al cliente (20260911h/i/j) ───────────────────────────
  // El certificado es la "presentacion" de la cuenta: corte por fecha, mano de
  // obra por avance, materiales congelados al emitir. Emitir y anular van por
  // RPC SECURITY DEFINER con supabaseAdmin; el scope de obra se valida en la
  // route ANTES (CLAUDE.md §9).

  async getCertificados(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('certificados_cliente')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('numero', { ascending: false })
      .limit(500)
    if (error) throw new Error(error.message)
    return data ?? []
  },

  async getCertificadoObra(id: number): Promise<string> {
    const { data, error } = await supabaseAdmin.from('certificados_cliente').select('obra_cod').eq('id', id).maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new CcHttpError(404, 'CERTIFICADO_NO_EXISTE')
    return data.obra_cod as string
  },

  /** El certificado con sus renglones (de la vista) y los cobros imputados contra el. */
  async getCertificado(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const [{ data: cert, error: e1 }, { data: renglones, error: e2 }, { data: cobros, error: e3 }] = await Promise.all([
      supabase.from('certificados_cliente').select('*').eq('id', id).maybeSingle(),
      supabase.from('v_cuenta_corriente').select('*').eq('certificado_id', id).order('fecha_resolucion').order('id').limit(1000),
      supabase.from('cuenta_cliente_cobros').select('*').eq('certificado_id', id).order('fecha'),
    ])
    if (e1) throw new Error(e1.message)
    if (!cert) throw new CcHttpError(404, 'CERTIFICADO_NO_EXISTE')
    if (e2) throw new Error(e2.message)
    if (e3) throw new Error(e3.message)
    const cobrado = (cobros ?? []).reduce((s, c) => s + Number(c.monto ?? 0), 0)
    return { ...cert, renglones: renglones ?? [], cobros: cobros ?? [], cobrado, saldo: Number(cert.total) - cobrado }
  },

  async emitirCertificado(dto: EmitirCertificadoDto, userId: string) {
    const { data, error } = await supabaseAdmin.rpc('emitir_certificado_cliente', {
      p_obra_cod:     dto.obra_cod,
      p_fecha_corte:  dto.fecha_corte,
      p_mano_de_obra: dto.mano_de_obra ?? 0,
      p_obs:          dto.obs ?? null,
      p_user_id:      userId,
      p_item_ids:     dto.item_ids ?? null,
    })
    if (error) {
      const msg = error.message || ''
      if (msg.includes('ITEM_NO_CERTIFICABLE'))  throw new CcHttpError(400, 'ITEM_NO_CERTIFICABLE', (error as { details?: string }).details ?? null)
      if (msg.includes('SIN_RENGLONES'))         throw new CcHttpError(400, 'SIN_RENGLONES')
      if (msg.includes('OBRA_INEXISTENTE'))      throw new CcHttpError(404, 'OBRA_INEXISTENTE')
      if (msg.includes('OBRA_ES_DEPOSITO'))      throw new CcHttpError(409, 'OBRA_ES_DEPOSITO')
      if (msg.includes('OBRA_ARCHIVADA'))        throw new CcHttpError(409, 'OBRA_ARCHIVADA')
      if (msg.includes('MANO_DE_OBRA_INVALIDA')) throw new CcHttpError(400, 'MANO_DE_OBRA_INVALIDA')
      throw new Error(msg)
    }
    return data
  },

  async anularCertificado(id: number, motivo: string, userId: string) {
    const { data, error } = await supabaseAdmin.rpc('anular_certificado_cliente', {
      p_id: id, p_motivo: motivo, p_user_id: userId,
    })
    if (error) {
      const msg = error.message || ''
      if (msg.includes('CERTIFICADO_NO_EXISTE'))   throw new CcHttpError(404, 'CERTIFICADO_NO_EXISTE')
      if (msg.includes('CERTIFICADO_YA_ANULADO'))  throw new CcHttpError(409, 'CERTIFICADO_YA_ANULADO')
      if (msg.includes('CERTIFICADO_CON_COBROS'))  throw new CcHttpError(409, 'CERTIFICADO_CON_COBROS')
      if (msg.includes('MOTIVO_OBLIGATORIO'))      throw new CcHttpError(400, 'MOTIVO_OBLIGATORIO')
      throw new Error(msg)
    }
    return data
  },

  async editarCobro(id: number, dto: EditarCobroDto, token: string, userId: string) {
    // Si baja el monto, no puede quedar por debajo de lo imputado a items
    // (el snapshot monto_cobrado congelado al registrar).
    if (dto.monto !== undefined) {
      const { data: imputados, error: eImp } = await supabaseAdmin
        .from('materiales_a_cuenta_cliente')
        .select('monto_cobrado')
        .eq('cobro_id', id)
      if (eImp) throw new Error(eImp.message)
      const totalImputado = (imputados ?? []).reduce((s, m) => s + Number(m.monto_cobrado ?? 0), 0)
      if (dto.monto + 0.01 < totalImputado) {
        throw new CcHttpError(409, 'MONTO_MENOR_IMPUTADO', { monto: dto.monto, imputado: totalImputado })
      }
    }
    const supabase = createSupabaseClient(token)
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros')
      .update({ ...patch, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  /** Elimina el cobro vía RPC: desimputa los items (vuelven a adeudados) y borra. */
  async eliminarCobro(id: number, _token: string, userId: string) {
    // Path del comprobante ANTES de borrar, para limpiar el bucket después.
    const { data: cobro } = await supabaseAdmin
      .from('cuenta_cliente_cobros').select('comprobante_url').eq('id', id).maybeSingle()

    const { data, error } = await supabaseAdmin.rpc('eliminar_cobro_cuenta_cliente', {
      p_cobro_id: id,
      p_user_id:  userId,
    })
    if (error) {
      if ((error.message || '').includes('COBRO_NO_EXISTE')) throw new CcHttpError(404, 'COBRO_NO_EXISTE')
      throw new Error(error.message)
    }
    if (cobro?.comprobante_url) {
      await supabaseAdmin.storage.from(BUCKET_COBROS).remove([cobro.comprobante_url]).catch(() => undefined)
    }
    return data
  },

  // ── Comprobante (bucket privado cobros-docs, flujo signed URL 2 pasos) ──

  async firmarUploadComprobante(contentType: string) {
    const path = pathForUploadCobro(contentType)
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET_COBROS)
      .createSignedUploadUrl(path)
    if (error || !data) throw new CcHttpError(500, 'STORAGE_ERROR', error?.message)
    return { path, signedUrl: data.signedUrl, token: data.token, expiresIn: 300 }
  },

  async getComprobanteUrl(cobroId: number) {
    const { data: cobro, error } = await supabaseAdmin
      .from('cuenta_cliente_cobros').select('comprobante_url').eq('id', cobroId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!cobro?.comprobante_url) throw new CcHttpError(404, 'COMPROBANTE_NO_EXISTE')
    const { data, error: eSign } = await supabaseAdmin.storage
      .from(BUCKET_COBROS)
      .createSignedUrl(cobro.comprobante_url, 300)
    if (eSign || !data) throw new CcHttpError(500, 'STORAGE_ERROR', eSign?.message)
    return { url: data.signedUrl, expiresIn: 300 }
  },
}
