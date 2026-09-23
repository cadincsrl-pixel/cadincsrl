/**
 * Módulo Pagos — facturas de proveedor, aprobación, órdenes de pago (diseño v3
 * §3/§5 + las 12 decisiones del dueño del 18/09).
 *
 * Regla dura: módulo independiente. Nada de acá lee ni escribe
 * `facturas_compra`, `proveedores` (el padrón de Compras), solicitudes, MCC ni
 * caja. La única tabla compartida es `obras` (centro de costo).
 *
 * Lo que escribe plata va por RPC transaccional (SECURITY DEFINER, EXECUTE solo
 * para service_role, `p_user_id` explícito). El backend valida ANTES de la RPC
 * lo que depende del usuario (permisos, separación de funciones, "hoy" en
 * Argentina) y la RPC valida lo que depende del estado (aprobada, saldo,
 * duplicados) con `FOR UPDATE`.
 *
 * Tres separaciones de funciones, chequeadas acá (admin exento — decisión 2):
 *   - no aprobás lo que cargaste       → 403 NO_PUEDE_APROBAR_PROPIA
 *   - no pagás lo que cargaste         → 403 NO_PUEDE_PAGAR_PROPIA { factura_id }
 *   - no pagás lo que aprobaste        → 403 NO_PUEDE_PAGAR_LO_QUE_APROBO { factura_id }
 *
 * Nota de crédito (decisión 7): es una LÍNEA de la OP (`tipo = 'nota_credito'`)
 * sobre una factura aprobada, con `nc_numero`/`nc_fecha` y su PDF como adjunto
 * `nota_credito`. No suma plata: `monto_pagado = Σ factura + Σ a_cuenta`;
 * `saldo = total − Σ factura − Σ nota_credito`. Una OP de solo NC lleva
 * `forma_pago = 'nota_credito'` y `monto_pagado = 0` (CHECK `pagos_ordenes_nc_chk`).
 */
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { PagosHttpError, errorDeCampo, mapRpcError } from './pagos.errors.js'
import {
  hoyAR, fechaARDe, normNumeroFactura, enmascarar, sumaCentavos, aCentavos, cuadra,
} from './pagos.util.js'
import {
  esBoolQ, ESTADOS_FACTURA, CAMPOS_CONGELADOS, CAMPOS_QUE_DESAPRUEBAN,
  FORMAS_PAGADA_AL_CARGAR_COMPRAS, FORMAS_CON_COMPROBANTE_OBLIGATORIO, FORMAS_CON_FECHA_COBRO,
  type CreateFacturaDto, type UpdateFacturaDto, type ListFacturasQuery, type FacturasResumenQuery,
  type CreateOrdenDto, type UpdateOrdenDto, type ListOrdenesQuery, type OrdenesResumenQuery, type ChequeDto,
  type ImputacionDto,
} from './pagos.schema.js'
import {
  pagosAdjuntosService, procesarPendientes, borrarDelBucket, moverPendientesAOrden, ordenesConHash, BUCKET,
  type AdjuntoProcesado,
} from './adjuntos.service.js'
import { ultimoControl, recompararControl } from './control.service.js'
import type { Aviso } from './proveedores.service.js'

// ── Perfil del usuario (rol + permisos) ─────────────────────────────────────
// Se lee una vez por request en el handler y se pasa al service: las reglas
// "propia", "del día", "admin" dependen de quién es, no solo de qué flag tiene.

export interface Perfil {
  rol: string | null
  permisos: Record<string, Record<string, unknown>> | null
  activo: boolean | null
}

export async function perfilDe(userId: string): Promise<Perfil | null> {
  const { data } = await supabase.from('profiles').select('rol, permisos, activo').eq('id', userId).maybeSingle()
  return (data as Perfil | null) ?? null
}

export function esAdmin(p: Perfil | null): boolean {
  return !!p && p.activo !== false && p.rol === 'admin'
}

/** `permisos.pagos.<flag>` con default; admin siempre true. */
export function flagPagos(p: Perfil | null, flag: string, def = false): boolean {
  if (!p || p.activo === false) return false
  if (p.rol === 'admin') return true
  const v = p.permisos?.pagos?.[flag]
  return v === undefined ? def : Boolean(v)
}

/** `permisos.pagos.<accion>` (lectura/creacion/actualizacion/eliminacion); admin siempre true. */
export function permisoPagos(p: Perfil | null, accion: 'lectura' | 'creacion' | 'actualizacion' | 'eliminacion'): boolean {
  if (!p || p.activo === false) return false
  if (p.rol === 'admin') return true
  return p.permisos?.pagos?.[accion] === true
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function palabras(q?: string): string[] {
  return normTxt(q ?? '').split(' ').filter(Boolean).slice(0, 6)
}

function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Estados con saldo exigible: los que cuentan para «vencida» / «vence en N días» (espejo de pagos_resumen). */
export const ESTADOS_ABIERTOS = ['pendiente', 'observada', 'aprobada', 'pagada_parcial'] as const

function estadosDe(csv?: string): string[] {
  return (csv ?? '').split(',').map((s) => s.trim()).filter((s) => (ESTADOS_FACTURA as readonly string[]).includes(s))
}

/** Enmascara las columnas de cuenta que traen las vistas de facturas y órdenes. */
function enmascararFila<T extends Record<string, unknown>>(row: T, verPii: boolean): T {
  const out: Record<string, unknown> = { ...row }
  for (const k of ['proveedor_cbu', 'proveedor_alias', 'cbu_destino', 'alias_destino', 'cbu', 'alias_cbu']) {
    if (k in out) out[k] = enmascarar(out[k] as string | null, verPii)
  }
  return out as T
}

/**
 * Las RPC mutativas devuelven filas de v_pagos_facturas / v_pagos_ordenes con
 * CBU y alias completos; sin `ver_pii` se enmascaran igual que en los GET, sea
 * que la fila venga suelta (aprobar/observar/corregida/anular factura) o
 * adentro de `factura`, `orden` o `facturas[]` (crear, editar, OP).
 */
function enmascararRespuesta<T extends Record<string, unknown>>(res: T, verPii: boolean): T {
  if (verPii || !res || typeof res !== 'object') return res
  const out: Record<string, unknown> = enmascararFila(res, verPii)
  for (const k of ['factura', 'orden']) {
    const v = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = enmascararFila(v as Record<string, unknown>, verPii)
  }
  if (Array.isArray(out.facturas)) {
    out.facturas = (out.facturas as unknown[]).map((f) =>
      f && typeof f === 'object' ? enmascararFila(f as Record<string, unknown>, verPii) : f)
  }
  return out as T
}

/** `permisos.pagos.ver_pii` (default false; admin true): CBU/alias completos. */
export function verPiiDe(p: Perfil | null): boolean {
  return flagPagos(p, 'ver_pii', false)
}

function rpcOk<T>(r: { data: unknown; error: { message?: string; details?: string | null; code?: string } | null }): T {
  if (r.error) throw mapRpcError(r.error)
  return r.data as T
}

interface ImportesFactura {
  fecha: string
  vence_el?: string | null
  neto?: number | null
  iva?: number | null
  percepciones?: number | null
  otros?: number | null
  total: number
}

export function imputableDe(f: { total: number; percepciones?: number | null }): number {
  return aCentavos(Number(f.total) - Number(f.percepciones ?? 0))
}

/**
 * Validaciones de importes y fechas de una factura (400 `{ error, campo }`).
 *   - fecha ≤ hoy AR; vence_el ≥ fecha.
 *   - desglose cuadra SOLO si vienen neto e iva los dos (decisión §11.35):
 *     neto + iva + percepciones + otros = total (±0,01).
 *   - imputaciones: sin obra repetida y Σ = imputable = total − percepciones (±0,01).
 */
export function validarImportes(f: ImportesFactura, imputaciones: ImputacionDto[] | null, opts: { validarFecha: boolean }): void {
  if (opts.validarFecha && f.fecha > hoyAR()) throw errorDeCampo('FECHA_FUTURA', 'fecha', { hoy: hoyAR() })
  if (f.vence_el && f.vence_el < f.fecha) throw errorDeCampo('VENCIMIENTO_INVALIDO', 'vence_el')
  if (f.neto != null && f.iva != null) {
    const suma = sumaCentavos([Number(f.neto), Number(f.iva), Number(f.percepciones ?? 0), Number(f.otros ?? 0)])
    if (!cuadra(suma, Number(f.total))) throw errorDeCampo('DESGLOSE_NO_CUADRA', 'total', { suma, total: aCentavos(Number(f.total)) })
  }
  if (imputaciones) {
    const obras = new Set<string>()
    for (const i of imputaciones) {
      if (obras.has(i.obra_cod)) throw errorDeCampo('IMPUTACION_OBRA_REPETIDA', 'imputaciones', { obra_cod: i.obra_cod })
      obras.add(i.obra_cod)
    }
    const suma = sumaCentavos(imputaciones.map((i) => i.monto))
    const imputable = imputableDe(f)
    if (!cuadra(suma, imputable)) throw errorDeCampo('IMPUTACION_NO_CUADRA', 'imputaciones', { suma, imputable })
  }
}

/**
 * Cheques de una OP (400 `{ error, campo }`). Las mismas reglas están en
 * `_pagos_emitir_orden`: esto adelanta el error al campo del formulario, la
 * RPC es la que manda.
 *   - cheque/echeq exige al menos uno; cualquier otra forma, ninguno.
 *   - Σ cheques = lo que sale de plata (±0,01). Si no cierra, falta o sobra uno.
 *   - ninguno se cobra antes de la fecha del pago.
 *   - endosado de un tercero sin librador no se puede reclamar a nadie.
 */
export function validarCheques(forma: string, cheques: ChequeDto[] | undefined, fecha: string, montoPagado: number, prefijo = ''): void {
  const lista = cheques ?? []
  const campo = `${prefijo}cheques`
  if (!(FORMAS_CON_FECHA_COBRO as readonly string[]).includes(forma)) {
    if (lista.length > 0) throw errorDeCampo('CHEQUES_INESPERADOS', campo, { forma_pago: forma })
    return
  }
  if (lista.length === 0) throw errorDeCampo('CHEQUES_REQUERIDOS', campo, { forma_pago: forma })
  lista.forEach((c, i) => {
    if (c.fecha_cobro < fecha) {
      throw errorDeCampo('FECHA_COBRO_INVALIDA', `${campo}.${i}.fecha_cobro`, { numero: c.numero, fecha })
    }
    if (!c.es_propio && !c.librador.trim()) {
      throw errorDeCampo('CHEQUE_SIN_LIBRADOR', `${campo}.${i}.librador`, { numero: c.numero })
    }
  })
  const suma = sumaCentavos(lista.map((c) => c.monto))
  if (!cuadra(suma, montoPagado)) {
    throw errorDeCampo('SUMA_CHEQUES_DISTINTA', campo, { suma, monto_pagado: aCentavos(montoPagado) })
  }
}

// ── Listado de facturas ─────────────────────────────────────────────────────

/**
 * Los filtros de la bandeja de órdenes, en un solo lugar: los usan la lista
 * paginada, el export a Excel y el paquete para el contador. Si se separan,
 * exportar deja de exportar lo que la pantalla está mostrando.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarFiltrosOrdenes(q: any, f: Omit<ListOrdenesQuery, 'limit' | 'offset'>) {
  if (f.proveedor_id) q = q.eq('proveedor_id', f.proveedor_id)
  if (f.forma_pago) q = q.eq('forma_pago', f.forma_pago)
  if (f.estado) q = q.eq('estado', f.estado)
  if (f.desde) q = q.gte('fecha', f.desde)
  if (f.hasta) q = q.lte('fecha', f.hasta)
  if (esBoolQ(f.sin_comprobante)) q = q.eq('tiene_comprobante', false)
  if (esBoolQ(f.en_cartera)) q = q.eq('en_cartera', true)
  if (esBoolQ(f.con_nota_credito)) q = q.gt('monto_nc', 0)
  for (const w of palabras(f.q)) q = q.ilike('busq', `%${w}%`)
  return q
}

function aplicarFiltrosFacturas(q: any, f: Omit<ListFacturasQuery, 'orden' | 'limit' | 'offset'>) {
  const estados = estadosDe(f.estado)
  if (estados.length > 0) q = q.in('estado', estados)
  else if (!esBoolQ(f.anuladas)) q = q.neq('estado', 'anulada')
  if (f.proveedor_id) q = q.eq('proveedor_id', f.proveedor_id)
  if (f.obra_cod) q = q.contains('obras_cod', [f.obra_cod])
  if (f.centro_costo) q = q.contains('centros_cc', [f.centro_costo])
  if (f.tipo) q = q.eq('tipo_comprobante', f.tipo)
  if (f.forma_pago) q = q.eq('forma_pago_prevista', f.forma_pago)
  if (f.desde) q = q.gte('fecha', f.desde)
  if (f.hasta) q = q.lte('fecha', f.hasta)
  if (f.vencimiento === 'vencidas') q = q.eq('vencida', true)
  else if (f.vencimiento === '7' || f.vencimiento === '30') {
    // Misma condición que `pagos_resumen` (bucket vence_7/vence_30): con saldo
    // y abierta. Sin esto «vence en 7 días» listaba facturas ya pagadas.
    q = q.not('vence_el', 'is', null).lte('vence_el', sumarDias(hoyAR(), Number(f.vencimiento)))
      .eq('paga_cliente', false).gt('saldo', 0).in('estado', ESTADOS_ABIERTOS)
  }
  if (esBoolQ(f.sin_adjunto)) q = q.or('tiene_factura_adj.is.null,tiene_factura_adj.eq.false')
  if (esBoolQ(f.sin_numero)) q = q.eq('sin_numero', true)
  if (esBoolQ(f.sin_revisar)) q = q.eq('sin_revisar', true)
  if (f.paga_cliente !== undefined) q = q.eq('paga_cliente', esBoolQ(f.paga_cliente))
  if (f.pagada_al_cargar !== undefined) q = q.eq('pagada_al_cargar', esBoolQ(f.pagada_al_cargar))
  if (esBoolQ(f.cuenta_cambiada)) q = q.eq('cuenta_cambio_tras_aprobar', true)
  if (f.es_interna !== undefined) q = q.eq('es_interna', esBoolQ(f.es_interna))
  // Facturas cuyas obras están TODAS archivadas: solo con el tilde.
  if (!esBoolQ(f.archivadas)) q = q.or('todas_archivadas.is.null,todas_archivadas.eq.false')
  for (const w of palabras(f.q)) q = q.ilike('busq', `%${w}%`)
  return q
}

function ordenarFacturas(q: any, orden: ListFacturasQuery['orden']) {
  if (orden === 'fecha') return q.order('fecha', { ascending: false }).order('id', { ascending: false })
  if (orden === 'saldo') return q.order('saldo', { ascending: false }).order('id', { ascending: false })
  // Default explícito: vence_el asc NULLS LAST, fecha asc, id asc.
  return q.order('vence_el', { ascending: true, nullsFirst: false }).order('fecha', { ascending: true }).order('id', { ascending: true })
}

export const pagosService = {

  // ═══════════════════════════════════ Facturas ═══════════════════════════════

  async listarFacturas(f: ListFacturasQuery, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_pagos_facturas').select('*', { count: 'exact' })
    q = aplicarFiltrosFacturas(q, f)
    q = ordenarFacturas(q, f.orden)
    const { data, error, count } = await q.range(f.offset, f.offset + f.limit - 1)
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    const items = ((data ?? []) as Record<string, unknown>[]).map((r) => enmascararFila(r, verPii))
    const total = count ?? items.length
    return { items, total, limit: f.limit, offset: f.offset, hasMore: f.offset + items.length < total }
  },

  /** Agregados por grupo (eje EMISIÓN), calculados en la base: cap 1000 de PostgREST. */
  async resumenFacturas(f: FacturasResumenQuery) {
    // Mismo default que la bandeja (aplicarFiltrosFacturas): sin `estado` ni
    // `anuladas=1`, las anuladas quedan afuera; si no, una anulada suma como
    // deuda en los KPIs y no cuadra con la lista.
    let estados = estadosDe(f.estado)
    if (estados.length === 0 && !esBoolQ(f.anuladas)) estados = ESTADOS_FACTURA.filter((e) => e !== 'anulada')
    const pal = palabras(f.q)
    const r = await supabase.rpc('pagos_resumen', {
      p_grupo:        f.grupo,
      p_proveedor_id: f.proveedor_id ?? null,
      p_obra_cod:     f.obra_cod ?? null,
      p_centro_costo: f.centro_costo ?? null,
      p_estados:      estados.length ? estados : null,
      p_tipo:         f.tipo ?? null,
      p_forma_pago:   f.forma_pago ?? null,
      p_vencimiento:  f.vencimiento ?? null,
      p_desde:        f.desde ?? null,
      p_hasta:        f.hasta ?? null,
      p_palabras:     pal.length ? pal : null,
      p_archivadas:   esBoolQ(f.archivadas),
      p_paga_cliente: f.paga_cliente === undefined ? null : esBoolQ(f.paga_cliente),
    })
    return { grupos: rpcOk<unknown[]>(r) ?? [] }
  },

  /** Filas planas para el Excel: todas, de a 1000, con orden estable. */
  async exportarFacturas(f: Omit<ListFacturasQuery, 'orden' | 'limit' | 'offset'>, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) => {
      let q = sb.from('v_pagos_facturas').select('*')
      q = aplicarFiltrosFacturas(q, f)
      return q.order('fecha', { ascending: false }).order('id', { ascending: false }).range(d, h)
    })
    return filas.map((r) => enmascararFila(r, verPii))
  },

  async detalleFactura(id: number, verPii: boolean, incluirBorrados: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const { data: f, error } = await sb.from('v_pagos_facturas').select('*').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!f) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')

    const [imp, adjuntos, lineas, control] = await Promise.all([
      sb.from('pagos_imputaciones')
        .select('id, obra_cod, monto, obs, created_at, updated_at, obra:obras(cod, nom, cc, es_interna, es_deposito, archivada)')
        .eq('factura_id', id).order('monto', { ascending: false }).order('id'),
      pagosAdjuntosService.listar('facturas', id, incluirBorrados, token),
      sb.from('pagos_orden_lineas')
        .select('id, orden_id, tipo, monto, nc_numero, nc_fecha, created_at, orden:pagos_ordenes(id, numero, fecha, fecha_cobro, forma_pago, referencia, estado, motivo_anulacion, anulado_at, cbu_destino, alias_destino, monto_pagado)')
        .eq('factura_id', id).order('id'),
      // El último control automático del comprobante (20260921j). Va en la
      // ficha porque es donde se mira la factura antes de aprobarla.
      ultimoControl(id),
    ])
    if (imp.error) throw new PagosHttpError(500, 'DB_ERROR', imp.error.message)
    if (lineas.error) throw new PagosHttpError(500, 'DB_ERROR', lineas.error.message)

    const fila = f as Record<string, unknown>
    const pagos = ((lineas.data ?? []) as any[]).map((l) => {
      const o = (l.orden ?? {}) as Record<string, unknown>
      return {
        ...l,
        orden: {
          ...enmascararFila(o, verPii),
          numero_fmt: o.numero != null ? `OP-${String(o.numero).padStart(4, '0')}` : null,
          cbu_destino_ultimos4: o.cbu_destino ? String(o.cbu_destino).slice(-4) : null,
          anulada: o.estado === 'anulada',
        },
      }
    })
    return {
      ...enmascararFila(fila, verPii),
      imputaciones: imp.data ?? [],
      adjuntos,
      pagos,
      control,
      aprobacion: {
        aprobada_por: fila.aprobada_por ?? null,
        aprobada_por_nombre: fila.aprobada_por_nombre ?? null,
        aprobada_at: fila.aprobada_at ?? null,
        cuenta_cambio_tras_aprobar: fila.cuenta_cambio_tras_aprobar ?? false,
        datos_pago_actualizados_at: fila.datos_pago_actualizados_at ?? null,
      },
    }
  },

  /**
   * POST /facturas. Valida, y si viene `orden` («Ya está pagada»), valida la
   * forma según quién carga (decisión 3: compras solo tarjeta/efectivo, admin
   * cualquiera; SIN tope de monto) y hashea el comprobante ANTES de la RPC.
   * `pagos_crear_factura` inserta factura + imputaciones (+ OP de una línea
   * `factura` por el total, que deja la factura `pagada` sin revisar).
   */
  async crearFactura(dto: CreateFacturaDto, userId: string, perfil: Perfil | null) {
    validarImportes(dto, dto.imputaciones, { validarFecha: true })

    let adjuntosOrden: AdjuntoProcesado[] = []
    let pOrden: Record<string, unknown> | null = null
    if (dto.orden) {
      const o = dto.orden
      if (dto.paga_cliente) throw new PagosHttpError(409, 'FACTURA_PAGA_CLIENTE', { campo: 'orden' })
      if (!esAdmin(perfil) && !(FORMAS_PAGADA_AL_CARGAR_COMPRAS as readonly string[]).includes(o.forma_pago)) {
        throw new PagosHttpError(403, 'PAGADA_AL_CARGAR_FORMA', { forma_pago: o.forma_pago, permitidas: FORMAS_PAGADA_AL_CARGAR_COMPRAS })
      }
      if (o.fecha > hoyAR()) throw errorDeCampo('FECHA_FUTURA', 'orden.fecha', { hoy: hoyAR() })
      validarCheques(o.forma_pago, o.cheques, o.fecha, dto.total, 'orden.')
      if (o.fecha_cobro && o.fecha_cobro < o.fecha) throw errorDeCampo('FECHA_COBRO_INVALIDA', 'orden.fecha_cobro')
      if ((FORMAS_CON_COMPROBANTE_OBLIGATORIO as readonly string[]).includes(o.forma_pago) && !o.comprobante) {
        throw errorDeCampo('COMPROBANTE_REQUERIDO', 'orden.comprobante', { forma_pago: o.forma_pago })
      }
      if (o.comprobante) adjuntosOrden = await procesarPendientes([{ ...o.comprobante, tipo: 'comprobante_pago' }])
      pOrden = {
        fecha: o.fecha, forma_pago: o.forma_pago, fecha_cobro: o.fecha_cobro ?? null,
        referencia: o.referencia ?? '', obs: o.obs ?? '',
        monto_pagado: aCentavos(dto.total), monto_nc: 0,
        cheques: o.cheques ?? [],
        adjuntos: adjuntosOrden,
      }
    }

    const pFactura = {
      proveedor_id: dto.proveedor_id, tipo_comprobante: dto.tipo_comprobante,
      numero: dto.numero ?? null, numero_norm: normNumeroFactura(dto.numero),
      fecha: dto.fecha,
      // «Ya está pagada» nace sin vencimiento (decisión 5: vencimiento opcional).
      vence_el: dto.orden ? null : (dto.vence_el ?? null),
      neto: dto.neto ?? null, iva: dto.iva ?? null, percepciones: dto.percepciones ?? null, otros: dto.otros ?? null,
      total: aCentavos(dto.total), forma_pago_prevista: dto.forma_pago_prevista,
      descripcion: dto.descripcion, obs: dto.obs ?? '', paga_cliente: dto.paga_cliente,
    }

    let res: { factura: Record<string, unknown>; orden?: Record<string, unknown> | null }
    try {
      res = rpcOk(await supabase.rpc('pagos_crear_factura', {
        p_factura:      pFactura,
        p_imputaciones: dto.imputaciones,
        p_orden:        pOrden,
        p_user_id:      userId,
      }))
    } catch (err) {
      await borrarDelBucket(adjuntosOrden.map((a) => a.storage_path))
      throw err
    }
    const ordenId = res.orden ? Number((res.orden as { id?: number }).id) : null
    if (ordenId && adjuntosOrden.length) await moverPendientesAOrden(ordenId, adjuntosOrden)

    const avisos: Aviso[] = []
    const facturaId = Number((res.factura as { id?: number }).id)

    // Auto-aprobación (20260921f): quien tiene `aprobar_facturas` + `aprobar_propias`
    // no espera a nadie — su factura nace aprobada y con su firma. Es lo que
    // pidió el dueño para Diego, único aprobador del sistema: sin esto cada
    // factura que cargaba él quedaba trabada.
    //
    // Es BEST-EFFORT a propósito: la factura ya está creada y es válida. Si no
    // se puede aprobar (la paga el cliente, el proveedor quedó inactivo, o
    // nació 'pagada' con su orden), queda como nació y alguien la aprueba
    // después. Un error acá NO puede tirar abajo una carga que ya se guardó.
    if (flagPagos(perfil, 'aprobar_facturas') && flagPagos(perfil, 'aprobar_propias')) {
      try {
        const aprobada = rpcOk<Record<string, unknown>>(
          await supabase.rpc('pagos_aprobar_factura', { p_factura_id: facturaId, p_user_id: userId }))
        if (aprobada) res.factura = aprobada
      } catch {
        // Silencio deliberado: ver el comentario de arriba.
      }
    }
    const { data: parecidas } = await supabase
      .from('pagos_facturas').select('id, tipo_comprobante, numero')
      .eq('proveedor_id', dto.proveedor_id).eq('total', aCentavos(dto.total)).eq('fecha', dto.fecha)
      .neq('estado', 'anulada').neq('id', facturaId).limit(5)
    if (parecidas && parecidas.length > 0) avisos.push({ code: 'FACTURA_POSIBLE_DUPLICADA', facturas: parecidas })

    return { ...enmascararRespuesta(res, verPiiDe(perfil)), avisos }
  },

  /**
   * PATCH /facturas/:id. La RPC solo pone en el SET lo que viene, así el
   * trigger de desaprobación ve solo lo que realmente cambió. Con líneas
   * vigentes, `CAMPOS_CONGELADOS` rebota 409; reimputar una pagada exige motivo.
   */
  async editarFactura(id: number, dto: UpdateFacturaDto, userId: string, verPii: boolean) {
    const { data: actual, error: e0 } = await supabase
      .from('pagos_facturas')
      .select('id, estado, proveedor_id, fecha, vence_el, neto, iva, percepciones, otros, total, aprobada_at')
      .eq('id', id).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')
    const a = actual as Record<string, any>
    if (a.estado === 'anulada') throw new PagosHttpError(409, 'FACTURA_CERRADA')

    const conPagos = a.estado === 'pagada' || a.estado === 'pagada_parcial'
    const { imputaciones, motivo, ...campos } = dto
    const tocados = (Object.keys(campos) as (keyof typeof campos)[]).filter((k) => campos[k] !== undefined)

    if (conPagos) {
      const congelados = tocados.filter((k) =>
        (CAMPOS_CONGELADOS as readonly string[]).includes(k) && String(campos[k] ?? null) !== String(a[k] ?? null))
      if (congelados.length > 0) throw new PagosHttpError(409, 'FACTURA_CON_PAGOS', { campos: congelados })
      if (imputaciones && !motivo) throw errorDeCampo('MOTIVO_REQUERIDO', 'motivo')
    }

    const merged = { ...a, ...Object.fromEntries(tocados.map((k) => [k, campos[k]])) } as ImportesFactura
    const cambiaImputable = tocados.includes('total') || tocados.includes('percepciones')
    let imputacionesAValidar: ImputacionDto[] | null = imputaciones ?? null
    if (!imputacionesAValidar && cambiaImputable) {
      // Cambió lo imputable y no vino reparto: con UNA sola obra la RPC ajusta
      // el monto sola; con varias hay que mandar el reparto nuevo.
      const { data: imps } = await supabase.from('pagos_imputaciones').select('obra_cod, monto').eq('factura_id', id)
      const actuales = ((imps ?? []) as { obra_cod: string; monto: number }[]).map((i) => ({ obra_cod: i.obra_cod, monto: Number(i.monto), obs: '' }))
      if (actuales.length > 1) imputacionesAValidar = actuales
    }
    validarImportes(merged, imputacionesAValidar, { validarFecha: tocados.includes('fecha') })

    const cambios: Record<string, unknown> = {}
    for (const k of tocados) cambios[k] = campos[k]
    if ('numero' in cambios) cambios.numero_norm = normNumeroFactura(cambios.numero as string | null)
    if ('total' in cambios) cambios.total = aCentavos(Number(cambios.total))

    const res = rpcOk<{ factura: Record<string, unknown>; aprobacion_retirada?: boolean }>(
      await supabase.rpc('pagos_editar_factura', {
        p_factura_id:   id,
        p_cambios:      cambios,
        p_imputaciones: imputaciones ?? null,
        p_motivo:       motivo ?? null,
        p_user_id:      userId,
      }))
    // Si se corrigió algo de lo que controla el comprobante, el chip tiene que
    // decir cómo quedó ahora, no cómo estaba cuando se subió el papel.
    if (tocados.some((k) => k === 'numero' || k === 'total' || k === 'fecha')) {
      await recompararControl(id)
    }

    const avisos: Aviso[] = []
    const desaprueba = tocados.some((k) => (CAMPOS_QUE_DESAPRUEBAN as readonly string[]).includes(k)) || !!imputaciones
    if (res.aprobacion_retirada || (a.estado === 'aprobada' && desaprueba && res.factura?.estado === 'pendiente')) {
      avisos.push({ code: 'APROBACION_RETIRADA', factura_ids: [id] })
    }
    return { ...enmascararRespuesta(res, verPii), avisos }
  },

  /** «No aprobás lo que cargaste» (admin exento). La RPC decide aprobar vs sellar una pagada al cargar. */
  async aprobarFactura(id: number, userId: string, perfil: Perfil | null) {
    const { data: f, error } = await supabase.from('pagos_facturas').select('id, created_by, estado').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!f) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')
    // La doble firma cede ante `aprobar_propias` (20260921f). Acá se adelanta
    // el error al formulario; la RPC repite la regla y es la que manda.
    if ((f as { created_by: string | null }).created_by === userId
        && !esAdmin(perfil) && !flagPagos(perfil, 'aprobar_propias')) {
      throw new PagosHttpError(403, 'NO_PUEDE_APROBAR_PROPIA', { factura_id: id })
    }
    return enmascararRespuesta(
      rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_aprobar_factura', { p_factura_id: id, p_user_id: userId })), verPiiDe(perfil))
  },

  /**
   * «Aprobar N»: la RPC aplica las que puede y devuelve `omitidas` con su
   * código (NO_PUEDE_APROBAR_PROPIA, FACTURA_NO_APROBABLE, FACTURA_PAGA_CLIENTE,
   * PROVEEDOR_INACTIVO). No es transaccional a propósito: una propia en el lote
   * no frena a las demás.
   */
  async aprobarLote(ids: number[], userId: string) {
    return rpcOk<{ aprobadas: number[]; omitidas: { id: number; code: string; detail?: unknown }[] }>(
      await supabase.rpc('pagos_aprobar_facturas', { p_ids: [...new Set(ids)].sort((a, b) => a - b), p_user_id: userId }))
  },

  async observarFactura(id: number, motivo: string, userId: string, verPii: boolean) {
    return enmascararRespuesta(
      rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_observar_factura', { p_factura_id: id, p_motivo: motivo, p_user_id: userId })), verPii)
  },

  async marcarCorregida(id: number, comentario: string, userId: string, verPii: boolean) {
    return enmascararRespuesta(
      rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_marcar_corregida', { p_factura_id: id, p_comentario: comentario, p_user_id: userId })), verPii)
  },

  /**
   * Anular. Quién puede depende del estado:
   *   - pagada al cargar sin sello: admin, `aprobar_facturas` («Rechazar» al
   *     revisar) o quien la cargó (`creacion`) el MISMO día AR → anula factura
   *     y su OP (`pagos_anular_pagada_al_cargar`).
   *   - pendiente/observada/aprobada: `eliminacion`, o `actualizacion` si es
   *     propia → `pagos_anular_factura`.
   *   - con pagos: 409 FACTURA_CON_PAGOS (anular la OP primero).
   */
  async anularFactura(id: number, motivo: string, userId: string, perfil: Perfil | null) {
    const { data, error } = await supabase
      .from('pagos_facturas').select('id, estado, created_by, created_at, pagada_al_cargar, aprobada_at').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')
    const f = data as { estado: string; created_by: string | null; created_at: string; pagada_al_cargar: boolean; aprobada_at: string | null }
    if (f.estado === 'anulada') throw new PagosHttpError(409, 'FACTURA_CERRADA')
    const propia = f.created_by === userId
    const admin = esAdmin(perfil)

    const sinRevisar = f.pagada_al_cargar && f.aprobada_at == null && f.estado === 'pagada'
    if (sinRevisar) {
      const delDia = propia && permisoPagos(perfil, 'creacion') && fechaARDe(f.created_at) === hoyAR()
      if (!(admin || flagPagos(perfil, 'aprobar_facturas') || delDia)) {
        throw new PagosHttpError(403, 'SIN_PERMISO', { flag: 'aprobar_facturas', motivo: 'pagada al cargar: solo el aprobador, o quien la cargó el mismo día' })
      }
      return enmascararRespuesta(
        rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_anular_pagada_al_cargar', { p_factura_id: id, p_motivo: motivo, p_user_id: userId })), verPiiDe(perfil))
    }
    if (f.estado === 'pagada' || f.estado === 'pagada_parcial') throw new PagosHttpError(409, 'FACTURA_CON_PAGOS')
    if (!(admin || permisoPagos(perfil, 'eliminacion') || (propia && permisoPagos(perfil, 'actualizacion')))) {
      throw new PagosHttpError(403, 'SIN_PERMISO', { flag: 'eliminacion', motivo: 'una factura ajena la anula quien tiene eliminación' })
    }
    return enmascararRespuesta(
      rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_anular_factura', { p_factura_id: id, p_motivo: motivo, p_user_id: userId })), verPiiDe(perfil))
  },

  // ═══════════════════════════════════ Órdenes ════════════════════════════════

  // ── Órdenes de pago ──────────────────────────────────────────────────

  async listarOrdenes(f: ListOrdenesQuery, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const q = aplicarFiltrosOrdenes(sb.from('v_pagos_ordenes').select('*', { count: 'exact' }), f)
    const [lista, tot] = await Promise.all([
      q.order('fecha', { ascending: false }).order('numero', { ascending: false }).range(f.offset, f.offset + f.limit - 1),
      supabase.rpc('pagos_ordenes_resumen', {
        p_grupo: 'forma_pago', p_eje: 'op',
        p_desde: f.desde ?? null, p_hasta: f.hasta ?? null,
        p_proveedor_id: f.proveedor_id ?? null, p_forma_pago: f.forma_pago ?? null,
      }),
    ])
    if (lista.error) throw new PagosHttpError(500, 'DB_ERROR', lista.error.message)
    const items = ((lista.data ?? []) as Record<string, unknown>[]).map((r) => enmascararFila(r, verPii))
    const total = lista.count ?? items.length
    const grupos = (tot.error ? [] : (tot.data ?? [])) as { ordenes?: number; monto_pagado?: number; monto_nc?: number }[]
    const totales = {
      ordenes: grupos.reduce((s, g) => s + Number(g.ordenes ?? 0), 0),
      monto_pagado: sumaCentavos(grupos.map((g) => Number(g.monto_pagado ?? 0))),
      monto_nc: sumaCentavos(grupos.map((g) => Number(g.monto_nc ?? 0))),
    }
    return { items, total, limit: f.limit, offset: f.offset, hasMore: f.offset + items.length < total, totales }
  },

  /** Todas las órdenes que matchean el filtro, para el Excel. Pagina en el server. */
  async exportarOrdenes(f: Omit<ListOrdenesQuery, 'limit' | 'offset'>, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) =>
      aplicarFiltrosOrdenes(sb.from('v_pagos_ordenes').select('*'), f)
        .order('fecha', { ascending: false }).order('id', { ascending: false }).range(d, h))

    // Los cheques de todas las órdenes de una, no una query por orden: sin
    // esto el Excel no puede decir qué cheque cae cuándo, que es la mitad de
    // para qué se exporta.
    const ids = filas.map((r) => Number(r.id))
    const cheques = ids.length === 0 ? [] : await todasLasFilas<Record<string, unknown>>((d, h) =>
      sb.from('pagos_cheques')
        .select('orden_id, numero, banco, fecha_cobro, monto, es_propio, librador')
        .in('orden_id', ids).order('orden_id').order('fecha_cobro').range(d, h))
    const porOrden = new Map<number, Record<string, unknown>[]>()
    for (const c of cheques) {
      const k = Number(c.orden_id)
      porOrden.set(k, [...(porOrden.get(k) ?? []), c])
    }
    return filas.map((r) => ({ ...enmascararFila(r, verPii), cheques: porOrden.get(Number(r.id)) ?? [] }))
  },

  /**
   * El paquete para el contador (2026-09-21).
   *
   * Pedido del dueño: «exportar paquete de facturas y comprobantes para que el
   * contador pueda cargar en el otro sistema contable», y después la
   * corrección que cambia todo: **«que sea sobre lo PAGADO»**.
   *
   * Por eso el eje es la ORDEN DE PAGO y no la factura. El contador no trabaja
   * por mes de emisión: trabaja por lo que salió del banco en el período, que
   * es lo que tiene que conciliar. Una factura de agosto pagada en septiembre
   * entra en septiembre, y filtrando por emisión no aparecía.
   *
   * El ZIP se arma UNA CARPETA POR OP porque así es como se carga a mano: cada
   * OP es un movimiento del banco, y adentro está el comprobante con el que
   * salió y las facturas que cubrió. Abrir la carpeta es tener el asiento
   * entero.
   *
   * Devuelve el MANIFIESTO con URLs firmadas a 15 minutos, no el ZIP: lo arma
   * el navegador y el server no se come un período entero de PDFs en memoria.
   */
  async paqueteContador(f: Omit<ListOrdenesQuery, 'limit' | 'offset'>, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const ordenes = await todasLasFilas<Record<string, unknown>>((d, h) =>
      aplicarFiltrosOrdenes(sb.from('v_pagos_ordenes').select('*'), f)
        .order('fecha', { ascending: true }).order('numero', { ascending: true }).range(d, h))
    const vacio = { generado_en: new Date().toISOString(), ordenes: [] }
    if (ordenes.length === 0) return vacio

    const ordenIds = ordenes.map((o) => Number(o.id))
    const [lineas, adjO] = await Promise.all([
      sb.from('pagos_orden_lineas')
        .select('orden_id, factura_id, tipo, monto, nc_numero')
        .in('orden_id', ordenIds).order('id'),
      sb.from('pagos_ordenes_adjuntos')
        .select('id, orden_id, tipo, storage_path, nombre_archivo, mime_type, size_bytes')
        .in('orden_id', ordenIds).is('deleted_at', null),
    ])
    if (lineas.error) throw new PagosHttpError(500, 'DB_ERROR', lineas.error.message)
    if (adjO.error)   throw new PagosHttpError(500, 'DB_ERROR', adjO.error.message)

    const facturaIds = [...new Set(((lineas.data ?? []) as any[])
      .map((l) => l.factura_id).filter((x): x is number => typeof x === 'number'))]
    const [facturas, adjF] = await Promise.all([
      facturaIds.length === 0 ? Promise.resolve({ data: [], error: null }) : sb
        .from('v_pagos_facturas')
        .select('id, tipo_comprobante, numero, fecha, vence_el, total, estado, descripcion, proveedor_nom')
        .in('id', facturaIds),
      facturaIds.length === 0 ? Promise.resolve({ data: [], error: null }) : sb
        .from('pagos_facturas_adjuntos')
        .select('id, factura_id, tipo, storage_path, nombre_archivo, mime_type, size_bytes')
        .in('factura_id', facturaIds).is('deleted_at', null),
    ])
    if (facturas.error) throw new PagosHttpError(500, 'DB_ERROR', facturas.error.message)
    if (adjF.error)     throw new PagosHttpError(500, 'DB_ERROR', adjF.error.message)

    // Una sola llamada a storage para TODAS las rutas: firmar de a una son
    // cientos de round-trips para un período cualquiera.
    const todos = [...((adjO.data ?? []) as any[]), ...((adjF.data ?? []) as any[])]
    const firmadas = new Map<string, string>()
    if (todos.length > 0) {
      const { data: urls, error: sErr } = await supabase.storage
        .from(BUCKET).createSignedUrls(todos.map((a) => a.storage_path), 900)
      if (sErr) throw new PagosHttpError(500, 'SIGNED_URL_ERROR', sErr.message)
      for (const u of urls ?? []) if (u.signedUrl && !u.error) firmadas.set(u.path ?? '', u.signedUrl)
    }

    const archivo = (a: any, origen: 'factura' | 'pago') => ({
      adjunto_id: a.id, tipo: a.tipo, origen,
      nombre_archivo: a.nombre_archivo, mime_type: a.mime_type, size_bytes: a.size_bytes,
      url: firmadas.get(a.storage_path) ?? null,
    })

    const adjDeOrden = new Map<number, any[]>()
    for (const a of (adjO.data ?? []) as any[]) {
      adjDeOrden.set(Number(a.orden_id), [...(adjDeOrden.get(Number(a.orden_id)) ?? []), a])
    }
    const adjDeFactura = new Map<number, any[]>()
    for (const a of (adjF.data ?? []) as any[]) {
      adjDeFactura.set(Number(a.factura_id), [...(adjDeFactura.get(Number(a.factura_id)) ?? []), a])
    }
    const facturaPorId = new Map<number, any>(((facturas.data ?? []) as any[]).map((x) => [Number(x.id), x]))
    const lineasDeOrden = new Map<number, any[]>()
    for (const l of (lineas.data ?? []) as any[]) {
      lineasDeOrden.set(Number(l.orden_id), [...(lineasDeOrden.get(Number(l.orden_id)) ?? []), l])
    }

    return {
      generado_en: new Date().toISOString(),
      ordenes: ordenes.map((o) => {
        const id = Number(o.id)
        const fila = enmascararFila(o, verPii)
        // Una línea por factura, con lo que ESTA OP le aplicó (puede ser un
        // pago parcial: la misma factura aparece en varias OP con montos
        // distintos, y el contador necesita ver cuánto entró en cada una).
        const porFactura = new Map<number, number>()
        for (const l of lineasDeOrden.get(id) ?? []) {
          if (l.factura_id == null || l.tipo === 'nota_credito') continue
          porFactura.set(Number(l.factura_id), (porFactura.get(Number(l.factura_id)) ?? 0) + Number(l.monto))
        }
        return {
          id,
          numero: Number(o.numero),
          numero_fmt: `OP-${String(o.numero).padStart(4, '0')}`,
          fecha: fila.fecha, forma_pago: fila.forma_pago, estado: fila.estado,
          monto_pagado: fila.monto_pagado, monto_nc: fila.monto_nc,
          proveedor_nom: fila.proveedor_nom, proveedor_cuit: fila.proveedor_cuit,
          archivos: (adjDeOrden.get(id) ?? []).map((a) => archivo(a, 'pago')),
          facturas: [...porFactura.entries()].map(([fid, aplicado]) => {
            const fx = facturaPorId.get(fid) ?? {}
            return {
              id: fid,
              tipo_comprobante: fx.tipo_comprobante ?? null, numero: fx.numero ?? null,
              fecha: fx.fecha ?? null, total: fx.total ?? null, estado: fx.estado ?? null,
              descripcion: fx.descripcion ?? '',
              aplicado,
              archivos: (adjDeFactura.get(fid) ?? []).map((a) => archivo(a, 'factura')),
            }
          }),
        }
      }),
    }
  },

  /** Agregados por grupo con eje FECHA DE PAGO («Pagado este mes» no sale de facturas por emisión). */
  async resumenOrdenes(f: OrdenesResumenQuery) {
    const r = await supabase.rpc('pagos_ordenes_resumen', {
      p_grupo:        f.grupo,
      p_eje:          f.eje,
      p_desde:        f.desde ?? null,
      p_hasta:        f.hasta ?? null,
      p_proveedor_id: f.proveedor_id ?? null,
      p_forma_pago:   f.forma_pago ?? null,
    })
    return { grupos: rpcOk<unknown[]>(r) ?? [] }
  },

  async detalleOrden(id: number, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const { data: o, error } = await sb.from('v_pagos_ordenes').select('*').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!o) throw new PagosHttpError(404, 'ORDEN_NO_EXISTE')
    const [lineas, cheques, adjuntos] = await Promise.all([
      sb.from('pagos_orden_lineas')
        .select('id, tipo, factura_id, monto, nc_numero, nc_fecha, created_at, factura:pagos_facturas(id, tipo_comprobante, numero, fecha, vence_el, total, estado, descripcion)')
        .eq('orden_id', id).order('id'),
      // Por fecha de cobro: el orden en que van a caer es el orden en que se leen.
      sb.from('pagos_cheques')
        .select('id, numero, banco, fecha_cobro, monto, es_propio, librador, obs')
        .eq('orden_id', id).order('fecha_cobro').order('id'),
      pagosAdjuntosService.listar('ordenes', id, true, token),
    ])
    if (lineas.error)  throw new PagosHttpError(500, 'DB_ERROR', lineas.error.message)
    if (cheques.error) throw new PagosHttpError(500, 'DB_ERROR', cheques.error.message)

    // Los papeles de la FACTURA, colgados de cada línea (2026-09-21).
    //
    // Pedido del dueño: «cuando abro orden de pago puedo descargar comprobante
    // pero no factura». Los adjuntos de la OP (`pagos_ordenes_adjuntos`) son el
    // comprobante del pago y las notas de crédito; la factura escaneada vive en
    // `pagos_facturas_adjuntos`, colgada de la factura. Desde la OP no se veía.
    //
    // Es justo el par que hay que mirar junto —lo que se pagó y con qué se
    // pagó—, y es lo que el contador necesita de a dos.
    //
    // Una sola query para todas las líneas, no una por línea.
    const facturaIds = [...new Set(((lineas.data ?? []) as any[])
      .map((l) => l.factura_id).filter((x): x is number => typeof x === 'number'))]
    let adjPorFactura = new Map<number, unknown[]>()
    if (facturaIds.length > 0) {
      const { data: adjF, error: adjErr } = await sb
        .from('pagos_facturas_adjuntos')
        .select('id, factura_id, tipo, nombre_archivo, mime_type, size_bytes, created_at')
        .in('factura_id', facturaIds).is('deleted_at', null)
        .order('tipo').order('created_at', { ascending: false })
      if (adjErr) throw new PagosHttpError(500, 'DB_ERROR', adjErr.message)
      adjPorFactura = ((adjF ?? []) as any[]).reduce((m, a) => {
        const arr = m.get(a.factura_id) ?? []
        arr.push(a)
        m.set(a.factura_id, arr)
        return m
      }, new Map<number, unknown[]>())
    }
    const lineasConPapeles = ((lineas.data ?? []) as any[]).map((l) => ({
      ...l,
      factura: l.factura ? { ...l.factura, adjuntos: adjPorFactura.get(l.factura_id) ?? [] } : l.factura,
    }))

    return { ...enmascararFila(o as Record<string, unknown>, verPii), lineas: lineasConPapeles, cheques: cheques.data ?? [], adjuntos }
  },

  /**
   * POST /ordenes: todo o nada. Valida forma/fecha de cobro/comprobante según
   * lo que sale de plata, las tres separaciones de funciones por factura, hashea
   * los adjuntos pendientes y llama `pagos_registrar_orden` (que valida
   * "solo aprobadas" por `_pagos_validar_pagable`, saldo exacto, cuenta destino
   * del padrón y numera al final con advisory lock). En error borra huérfanos;
   * tras el commit mueve los archivos a `ordenes/<id>/`.
   */
  async registrarOrden(dto: CreateOrdenDto, userId: string, perfil: Perfil | null) {
    const hoy = hoyAR()
    if (dto.fecha > hoy) throw errorDeCampo('FECHA_FUTURA', 'fecha', { hoy })
    if (dto.fecha_cobro && dto.fecha_cobro < dto.fecha) throw errorDeCampo('FECHA_COBRO_INVALIDA', 'fecha_cobro')

    const montoPagado = sumaCentavos(dto.lineas.filter((l) => l.tipo !== 'nota_credito').map((l) => l.monto))
    const montoNc = sumaCentavos(dto.lineas.filter((l) => l.tipo === 'nota_credito').map((l) => l.monto))
    const tieneNc = dto.lineas.some((l) => l.tipo === 'nota_credito')
    for (const l of dto.lineas) {
      if (l.tipo === 'nota_credito' && (!l.nc_numero || !l.nc_fecha)) throw errorDeCampo('NC_DATOS_REQUERIDOS', 'lineas', { factura_id: l.factura_id })
      if (l.nc_fecha && l.nc_fecha > hoy) throw errorDeCampo('FECHA_FUTURA', 'lineas', { factura_id: l.factura_id, hoy })
    }

    // Con plata: la forma es obligatoria y manda comprobante / fecha de cobro.
    // Sin plata (solo NC): forma_pago = 'nota_credito', sin comprobante de pago.
    let formaPago: string = dto.forma_pago ?? ''
    const tipos = new Set(dto.adjuntos.map((a) => a.tipo))
    if (montoPagado > 0) {
      if (!formaPago) throw errorDeCampo('FORMA_PAGO_REQUERIDA', 'forma_pago')
      validarCheques(formaPago, dto.cheques, dto.fecha, montoPagado)
      if ((FORMAS_CON_COMPROBANTE_OBLIGATORIO as readonly string[]).includes(formaPago) && !tipos.has('comprobante_pago')) {
        throw errorDeCampo('COMPROBANTE_REQUERIDO', 'adjuntos', { forma_pago: formaPago, tipo: 'comprobante_pago' })
      }
    } else {
      formaPago = 'nota_credito'
    }
    if (tieneNc && !tipos.has('nota_credito')) {
      throw errorDeCampo('COMPROBANTE_REQUERIDO', 'adjuntos', { tipo: 'nota_credito' })
    }

    // Separación de funciones, por factura, antes de la RPC (admin exento).
    const facturaIds = [...new Set(dto.lineas.map((l) => l.factura_id).filter((x): x is number => x != null))]
    if (facturaIds.length > 0) {
      const { data: facts, error } = await supabase
        .from('pagos_facturas').select('id, created_by, aprobada_por, proveedor_id').in('id', facturaIds)
      if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
      const porId = new Map(((facts ?? []) as { id: number; created_by: string | null; aprobada_por: string | null; proveedor_id: number }[]).map((f) => [f.id, f]))
      for (const fid of facturaIds.sort((a, b) => a - b)) {
        const f = porId.get(fid)
        if (!f) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: fid })
        if (f.proveedor_id !== dto.proveedor_id) throw new PagosHttpError(409, 'FACTURA_OTRO_PROVEEDOR', { factura_id: fid })
        if (!esAdmin(perfil)) {
          if (f.created_by === userId) throw new PagosHttpError(403, 'NO_PUEDE_PAGAR_PROPIA', { factura_id: fid })
          if (f.aprobada_por === userId) throw new PagosHttpError(403, 'NO_PUEDE_PAGAR_LO_QUE_APROBO', { factura_id: fid })
        }
      }
    }

    const adjuntos = await procesarPendientes(dto.adjuntos)
    const avisos: Aviso[] = []
    const yaUsados = await ordenesConHash(adjuntos.filter((a) => a.tipo === 'comprobante_pago').map((a) => a.hash_sha256))
    if (yaUsados.length > 0) avisos.push({ code: 'COMPROBANTE_YA_USADO', orden_ids: yaUsados })

    let res: { orden: Record<string, unknown>; facturas: unknown[] }
    try {
      res = rpcOk(await supabase.rpc('pagos_registrar_orden', {
        p_orden: {
          proveedor_id: dto.proveedor_id, fecha: dto.fecha,
          // Con cheques la fecha de cobro de la OP la deriva la RPC (la primera
          // que cae); lo que venga acá se ignora.
          fecha_cobro: dto.fecha_cobro ?? null,
          forma_pago: formaPago, referencia: dto.referencia ?? '', obs: dto.obs ?? '',
          monto_pagado: montoPagado, monto_nc: montoNc,
          cheques: dto.cheques ?? [],
        },
        p_lineas: dto.lineas.map((l) => ({
          tipo: l.tipo, factura_id: l.factura_id ?? null, monto: aCentavos(l.monto),
          nc_numero: l.tipo === 'nota_credito' ? (l.nc_numero ?? null) : null,
          nc_fecha:  l.tipo === 'nota_credito' ? (l.nc_fecha ?? null) : null,
        })),
        p_adjuntos: adjuntos,
        p_user_id:  userId,
      }))
    } catch (err) {
      await borrarDelBucket(adjuntos.map((a) => a.storage_path))
      throw err
    }
    const ordenId = Number((res.orden as { id?: number }).id)
    if (ordenId && adjuntos.length) await moverPendientesAOrden(ordenId, adjuntos)
    return { ...enmascararRespuesta(res, verPiiDe(perfil)), avisos }
  },

  /** Solo `obs` y `referencia`: lo financiero y la cuenta destino de una OP no cambian nunca. */
  async editarOrden(id: number, dto: UpdateOrdenDto, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const cambios: Record<string, unknown> = {}
    if (dto.referencia !== undefined) cambios.referencia = dto.referencia
    if (dto.obs !== undefined) cambios.obs = dto.obs
    const { data, error } = await sb
      .from('pagos_ordenes').update({ ...cambios, updated_by: userId }).eq('id', id)
      .select('id, numero, referencia, obs, estado').maybeSingle()
    if (error) throw mapRpcError(error)
    if (!data) throw new PagosHttpError(404, 'ORDEN_NO_EXISTE')
    return data
  },

  /**
   * Anular OP: `registrar_pagos` solo la propia del mismo día AR; `anular_pagos`
   * cualquiera; admin bypass. Si no cumple: 403 ORDEN_NO_ES_TUYA_O_VIEJA. La
   * RPC recalcula cada factura (vuelve a `aprobada` si tenía sello, si no a
   * `pendiente`) y manda los adjuntos a `deleted_at`.
   */
  async anularOrden(id: number, motivo: string, userId: string, perfil: Perfil | null) {
    const { data, error } = await supabase.from('pagos_ordenes').select('id, estado, created_by, created_at').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'ORDEN_NO_EXISTE')
    const o = data as { estado: string; created_by: string | null; created_at: string }
    if (o.estado === 'anulada') throw new PagosHttpError(409, 'ORDEN_YA_ANULADA')
    const propiaDelDia = flagPagos(perfil, 'registrar_pagos') && o.created_by === userId && fechaARDe(o.created_at) === hoyAR()
    if (!(esAdmin(perfil) || flagPagos(perfil, 'anular_pagos') || propiaDelDia)) {
      throw new PagosHttpError(403, 'ORDEN_NO_ES_TUYA_O_VIEJA', { orden_id: id })
    }
    return enmascararRespuesta(
      rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_anular_orden', { p_orden_id: id, p_motivo: motivo, p_user_id: userId })), verPiiDe(perfil))
  },

  // ═══════════════════════════════════ Catálogos ══════════════════════════════

  /** Obras activas y archivadas como centros de costo. El módulo no depende de GET /api/obras. */
  async catalogoObras() {
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) =>
      supabase.from('obras').select('cod, nom, cc, es_interna, es_deposito, archivada').order('archivada').order('nom').order('cod').range(d, h))
    return filas
  },
}
