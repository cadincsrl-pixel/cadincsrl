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
 * Nota de crédito (20260925a–d, decisión del dueño del 24/09): es un
 * COMPROBANTE de `pagos_facturas` con `clase = 'nota_credito'`, su desglose,
 * su reparto por obra (Σ = total − percepciones) y a qué facturas acredita
 * (`pagos_nc_aplicaciones`, única puerta `_pagos_guardar_aplicaciones`).
 *   - Baja la deuda cuando se APRUEBA (misma doble firma que una factura).
 *     Mientras está pendiente/observada, lo que declara aplicar queda
 *     RESERVADO: el tope de una OP es `saldo_pagable` (= saldo − nc_pendiente).
 *   - Lo que sobra queda como crédito a favor (`nc_disponible`) y se aplica a
 *     mano con POST /facturas/:id/aplicar-nc (`pagos_aplicar_nc`, solo agrega).
 *   - Una NC nunca se paga (NC_NO_SE_PAGA) ni es línea de una OP
 *     (NC_ES_COMPROBANTE). El circuito de «devolución del proveedor» se borró.
 *   - Quien suma importes de `v_pagos_facturas` pone el signo por `clase`
 *     (la NC resta); `saldo` ya es 0 en la NC.
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
  FORMAS_CON_COMPROBANTE_OBLIGATORIO, FORMAS_CON_FECHA_COBRO,
  type CreateFacturaDto, type UpdateFacturaDto, type ListFacturasQuery, type FacturasResumenQuery,
  type CreateOrdenDto, type UpdateOrdenDto, type ListOrdenesQuery, type OrdenesResumenQuery, type ChequeDto,
  type ImputacionDto, type RegistrarFinnegansDto, type AplicarNcDto, sumaAplicaA,
} from './pagos.schema.js'
import {
  pagosAdjuntosService, procesarPendientes, borrarDelBucket, moverPendientesAOrden, ordenesConHash, hashDelBucket, BUCKET,
  type AdjuntoProcesado,
} from './adjuntos.service.js'
import { ultimoControl, recompararControl, controlDesdeLectura, controlarFactura } from './control.service.js'
import { lecturaService, camposEditados, type LecturaGuardada } from './lectura.service.js'
import { esPercepcion } from './lectura/arca.js'
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

/** La OP que ya tiene ese número de Finnegans (misma normalización que el índice único). */
async function ordenConNumeroFinnegans(numero: string): Promise<{ orden_id: number; numero: number } | null> {
  // Se guarda recortado, así que alcanza con ilike (mayúsculas) sin comodines.
  const literal = numero.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const { data } = await supabase.from('pagos_ordenes')
    .select('id, numero').ilike('numero_finnegans', literal).limit(1).maybeSingle()
  const o = data as { id: number; numero: number } | null
  return o ? { orden_id: o.id, numero: o.numero } : null
}

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
export function enmascararRespuesta<T extends Record<string, unknown>>(res: T, verPii: boolean): T {
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
  no_gravado?: number | null
  exento?: number | null
  total: number
  iva_detalle?: { alicuota_id: number; base_imp: number; importe: number }[] | null
  tributos?: { tipo: string; importe: number }[] | null
}

/**
 * Las columnas agregadas tal como las va a dejar la base (20260924u): con
 * detalle, `_pagos_guardar_desglose` deriva neto e IVA de las alícuotas y
 * percepciones/otros de los tributos. Se calcula igual acá para validar el
 * cierre y el reparto ANTES de la RPC, con el error en el campo correcto.
 */
export function importesEfectivos(f: ImportesFactura): ImportesFactura {
  const out: ImportesFactura = { ...f }
  if (f.iva_detalle) {
    out.iva = sumaCentavos(f.iva_detalle.map((x) => x.importe))
    if (f.iva_detalle.length) out.neto = sumaCentavos(f.iva_detalle.map((x) => x.base_imp))
  }
  if (f.tributos) {
    const perc = sumaCentavos(f.tributos.filter((t) => esPercepcion(t.tipo)).map((t) => t.importe))
    const otros = sumaCentavos(f.tributos.filter((t) => !esPercepcion(t.tipo)).map((t) => t.importe))
    out.percepciones = perc === 0 && f.percepciones == null ? null : perc
    out.otros = otros === 0 && f.otros == null ? null : otros
  }
  return out
}

/** '1000.00' (numeric de la base) y 1000 (JSON) son lo mismo; null es null. */
export function valorComparable(v: unknown): string {
  if (v == null || v === '') return 'null'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return String(Number(v))
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

export function imputableDe(f: { total: number; percepciones?: number | null }): number {
  return aCentavos(Number(f.total) - Number(f.percepciones ?? 0))
}

/**
 * Validaciones de importes y fechas de una factura (400 `{ error, campo }`).
 *   - fecha ≤ hoy AR; vence_el ≥ fecha.
 *   - desglose cuadra SOLO si vienen neto e iva los dos (decisión §11.35):
 *     neto + iva + percepciones + otros + no gravado + exento = total (±0,01).
 *     Con detalle (iva_detalle / tributos) se valida sobre lo derivado.
 *   - imputaciones: sin obra repetida y Σ = imputable = total − percepciones (±0,01).
 */
export function validarImportes(fIn: ImportesFactura, imputaciones: ImputacionDto[] | null, opts: { validarFecha: boolean }): void {
  const f = importesEfectivos(fIn)
  if (opts.validarFecha && f.fecha > hoyAR()) throw errorDeCampo('FECHA_FUTURA', 'fecha', { hoy: hoyAR() })
  if (f.vence_el && f.vence_el < f.fecha) throw errorDeCampo('VENCIMIENTO_INVALIDO', 'vence_el')
  if (f.neto != null && f.iva != null) {
    const suma = sumaCentavos([Number(f.neto), Number(f.iva), Number(f.percepciones ?? 0), Number(f.otros ?? 0),
      Number(f.no_gravado ?? 0), Number(f.exento ?? 0)])
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
  if (esBoolQ(f.sin_desglose)) q = q.or('neto.is.null,iva.is.null,desglose_a_revisar.eq.true')
  if (f.paga_cliente !== undefined) q = q.eq('paga_cliente', esBoolQ(f.paga_cliente))
  if (f.pagada_al_cargar !== undefined) q = q.eq('pagada_al_cargar', esBoolQ(f.pagada_al_cargar))
  if (esBoolQ(f.cuenta_cambiada)) q = q.eq('cuenta_cambio_tras_aprobar', true)
  if (f.es_interna !== undefined) q = q.eq('es_interna', esBoolQ(f.es_interna))
  if (f.clase) q = q.eq('clase', f.clase)
  if (esBoolQ(f.con_credito)) q = q.gt('nc_disponible', 0)
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

/**
 * La factura se creó desde una lectura: el archivo pasa de
 * `facturas/lecturas/` a `facturas/<id>/`, se registra como adjunto
 * `factura`, la lectura queda marcada como usada y se guarda el control del
 * papel sin volver a llamar al modelo. Si la lectura no leyó nada (ni QR ni
 * IA), el control corre como siempre. Nunca lanza: devuelve false si el
 * adjunto no quedó, para avisar que hay que subirlo desde la ficha.
 */
async function adjuntarLectura(facturaId: number, l: LecturaGuardada, userId: string): Promise<boolean> {
  try {
    const nombre = l.storage_path.slice(l.storage_path.lastIndexOf('/') + 1)
    const destino = `facturas/${facturaId}/${nombre}`
    const mv = await supabase.storage.from(BUCKET).move(l.storage_path, destino)
    const path = mv.error ? l.storage_path : destino
    const { size } = await hashDelBucket(path)
    const { data: adj, error } = await supabase.from('pagos_facturas_adjuntos').insert({
      factura_id: facturaId, tipo: 'factura', storage_path: path, nombre_archivo: l.nombre_archivo,
      hash_sha256: l.hash_sha256, mime_type: l.mime_type, size_bytes: size, obs: '',
      created_by: userId, updated_by: userId,
    }).select('id').single()
    await supabase.from('pagos_facturas_lecturas').update({ factura_id: facturaId, storage_path: path }).eq('id', l.id)
    if (error || !adj) {
      console.error(`[pagos] factura ${facturaId}: la lectura ${l.id} no quedó como adjunto: ${error?.message}`)
      return false
    }
    const adjId = (adj as { id: number }).id
    const p = l.propuesta
    const leido = {
      numero: p.numero_comprobante ? `${p.punto_venta ?? ''}-${p.numero_comprobante}` : null,
      total: p.total,
      fecha: p.fecha,
    }
    if (leido.numero || leido.total != null || leido.fecha) {
      await controlDesdeLectura(facturaId, adjId, leido, l.modelo ?? 'qr')
    } else {
      await controlarFactura(facturaId, adjId, path, l.mime_type)
    }
    return true
  } catch (e) {
    console.error(`[pagos] factura ${facturaId}: no se pudo adjuntar la lectura: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

// ── Aplicaciones de notas de crédito (20260925a) ────────────────────────────

/** Un lado de la aplicación, con lo que hace falta para mostrarlo (de `v_pagos_facturas`). */
export interface ComprobanteAplicado {
  id: number
  clase: string
  tipo_comprobante: string
  cbte_tipo_arca: number | null
  numero: string | null
  fecha: string
  total: number
  estado: string
  aprobada_at: string | null
  saldo: number
  saldo_pagable: number | null
  nc_disponible: number | null
}

/**
 * Una fila de `pagos_nc_aplicaciones` con los dos comprobantes. `vigente`: la
 * NC no está anulada. `aprobada`: la NC está aprobada, o sea que esta
 * aplicación YA bajó la deuda; vigente sin aprobar = reservado.
 */
export interface AplicacionNc {
  id: number
  nc_id: number
  factura_id: number
  monto: number
  created_at: string
  vigente: boolean
  aprobada: boolean
  nc: ComprobanteAplicado | null
  factura: ComprobanteAplicado | null
}

const COLS_COMPROBANTE_APLICADO =
  'id, clase, tipo_comprobante, cbte_tipo_arca, numero, fecha, total, estado, aprobada_at, saldo, saldo_pagable, nc_disponible'

/**
 * Aplicaciones de NC agrupadas por `lado`: `'factura'` → por factura (qué NC
 * la acreditan); `'nc'` → por NC (a qué facturas acredita). Dos queries
 * planas en vez de un embed: la tabla tiene dos FK a `pagos_facturas`.
 */
export async function aplicacionesDe(lado: 'factura' | 'nc', ids: number[], token: string): Promise<Map<number, AplicacionNc[]>> {
  const out = new Map<number, AplicacionNc[]>()
  if (ids.length === 0) return out
  const sb = createSupabaseClient(token)
  const col = lado === 'nc' ? 'nc_id' : 'factura_id'
  const { data, error } = await sb.from('pagos_nc_aplicaciones')
    .select('id, nc_id, factura_id, monto, created_at').in(col, ids).order('id')
  if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
  const filas = (data ?? []) as { id: number; nc_id: number; factura_id: number; monto: number | string; created_at: string }[]
  if (filas.length === 0) return out
  const todos = [...new Set(filas.flatMap((a) => [Number(a.nc_id), Number(a.factura_id)]))]
  const { data: comps, error: e2 } = await sb.from('v_pagos_facturas').select(COLS_COMPROBANTE_APLICADO).in('id', todos)
  if (e2) throw new PagosHttpError(500, 'DB_ERROR', e2.message)
  const porId = new Map(((comps ?? []) as unknown as ComprobanteAplicado[]).map((c) => [Number(c.id), c]))
  for (const a of filas) {
    const nc = porId.get(Number(a.nc_id)) ?? null
    const fila: AplicacionNc = {
      id: Number(a.id), nc_id: Number(a.nc_id), factura_id: Number(a.factura_id), monto: Number(a.monto),
      created_at: a.created_at,
      vigente: !!nc && nc.estado !== 'anulada',
      aprobada: !!nc && nc.estado !== 'anulada' && nc.aprobada_at != null,
      nc, factura: porId.get(Number(a.factura_id)) ?? null,
    }
    const k = lado === 'nc' ? fila.nc_id : fila.factura_id
    out.set(k, [...(out.get(k) ?? []), fila])
  }
  return out
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
      p_clase:        f.clase ?? null,
    })
    // Cada grupo trae `facturas` (solo facturas), `notas_credito` y `total` /
    // `imputable` con signo (la NC resta).
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

    const [imp, adjuntos, lineas, control, ivaDet, tribDet, aplicaciones] = await Promise.all([
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
      // El desglose como lo pide ARCA (20260924u).
      sb.from('pagos_factura_iva').select('alicuota_id, base_imp, importe').eq('factura_id', id).order('alicuota_id'),
      sb.from('pagos_factura_tributos').select('id, tipo, jurisdiccion, descripcion, alicuota, base_imp, importe').eq('factura_id', id).order('id'),
      aplicacionesDe((f as { clase?: string }).clase === 'nota_credito' ? 'nc' : 'factura', [id], token),
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
      iva_detalle: ivaDet.data ?? [],
      tributos: tribDet.data ?? [],
      adjuntos,
      pagos,
      // En la NC: a qué facturas acredita. En la factura: qué NC la acreditan
      // (vigentes y anuladas; `vigente`/`aprobada` dicen cuáles bajan la deuda).
      aplicaciones: aplicaciones.get(id) ?? [],
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
   * POST /facturas. Valida, y si viene `orden` («Ya está pagada»), exige
   * `registrar_pagos` (o admin) y hashea el comprobante ANTES de la RPC.
   *
   * Hasta el 2026-09-23 Compras podía marcarla con tarjeta o efectivo
   * (decisión 3). El dueño lo cerró: «que Nicolás lo pueda cargar no me
   * parece, porque no está autorizada». Marcar «ya está pagada» es registrar
   * un pago, y registrar pagos es de quien tiene el flag, igual que emitir
   * una OP. Con el flag, cualquier forma.
   * `pagos_crear_factura` inserta factura + imputaciones (+ OP de una línea
   * `factura` por el total, que deja la factura `pagada` sin revisar).
   */
  async crearFactura(dto: CreateFacturaDto, userId: string, perfil: Perfil | null) {
    const esNc = dto.clase === 'nota_credito'
    // El schema ya lo frena; se repite porque es plata: una NC no se paga.
    if (esNc && dto.orden) throw new PagosHttpError(409, 'NC_NO_SE_PAGA', { campo: 'orden' })
    validarImportes(dto, dto.imputaciones, { validarFecha: true })
    const ef = importesEfectivos(dto)

    // «Archivo primero» (20260924u): la lectura se toma de la base, nunca del
    // cliente. Si el mismo archivo ya respalda otra factura, se frena ANTES
    // de crear nada (el índice de adjuntos lo rebotaría después).
    let lectura: LecturaGuardada | null = null
    if (dto.lectura_id) {
      lectura = await lecturaService.tomar(dto.lectura_id)
      const { data: dup } = await supabase.from('pagos_facturas_adjuntos').select('id, factura_id')
        .eq('hash_sha256', lectura.hash_sha256).eq('tipo', 'factura').is('deleted_at', null).limit(1).maybeSingle()
      if (dup) throw new PagosHttpError(409, 'ADJ_DUPLICADO', { entidad: 'factura', factura_id: (dup as { factura_id: number }).factura_id })
    }

    let adjuntosOrden: AdjuntoProcesado[] = []
    let pOrden: Record<string, unknown> | null = null
    if (dto.orden) {
      const o = dto.orden
      if (!esAdmin(perfil) && !flagPagos(perfil, 'registrar_pagos')) {
        throw new PagosHttpError(403, 'PAGADA_AL_CARGAR_SIN_PERMISO', { flag: 'registrar_pagos' })
      }
      if (dto.paga_cliente) throw new PagosHttpError(409, 'FACTURA_PAGA_CLIENTE', { campo: 'orden' })
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
      neto: ef.neto ?? null, iva: ef.iva ?? null, percepciones: ef.percepciones ?? null, otros: ef.otros ?? null,
      no_gravado: dto.no_gravado ?? null, exento: dto.exento ?? null,
      cae: dto.cae ?? null, cae_vto: dto.cae_vto ?? null, cbte_tipo_arca: dto.cbte_tipo_arca ?? null,
      iva_detalle: dto.iva_detalle ?? null, tributos: dto.tributos ?? null,
      total: aCentavos(dto.total), forma_pago_prevista: dto.forma_pago_prevista,
      descripcion: dto.descripcion, obs: dto.obs ?? '', paga_cliente: dto.paga_cliente,
      plan_cheques: dto.plan_cheques ?? null,
      clase: dto.clase,
      aplica_a: esNc ? (dto.aplica_a ?? []).map((a) => ({ factura_id: a.factura_id, monto: aCentavos(a.monto) })) : null,
      lectura_estado: lectura?.estado ?? 'manual',
      lectura_json: lectura ? {
        lectura_id: lectura.id, modelo: lectura.modelo, archivo: lectura.nombre_archivo,
        qr: lectura.qr, ia: lectura.ia, propuesta: lectura.propuesta,
        fuente_por_campo: lectura.fuente_por_campo, avisos: lectura.avisos,
        editados: camposEditados(lectura.propuesta, {
          numero: dto.numero, fecha: dto.fecha, total: dto.total, tipo_comprobante: dto.tipo_comprobante,
          vence_el: dto.vence_el ?? null, neto: ef.neto ?? null, no_gravado: dto.no_gravado ?? null,
          exento: dto.exento ?? null, cae: dto.cae ?? null, iva: dto.iva_detalle ?? [], tributos: dto.tributos ?? [],
        }),
      } : null,
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

    // El archivo leído pasa a ser el adjunto de la factura, y el control del
    // papel sale de la lectura. Best-effort: la factura ya está guardada.
    if (lectura) {
      const adj = await adjuntarLectura(facturaId, lectura, userId)
      if (!adj) avisos.push({ code: 'ADJUNTO_NO_GUARDADO' })
    }

    // Auto-aprobación (20260921f): quien tiene `aprobar_facturas` + `aprobar_propias`
    // no espera a nadie — su factura nace aprobada y con su firma. Es lo que
    // pidió el dueño para Diego, único aprobador del sistema: sin esto cada
    // factura que cargaba él quedaba trabada.
    //
    // Es BEST-EFFORT a propósito: la factura ya está creada y es válida. Si no
    // se puede aprobar (la paga el cliente, el proveedor quedó inactivo, o
    // nació 'pagada' con su orden), queda como nació y alguien la aprueba
    // después. Un error acá NO puede tirar abajo una carga que ya se guardó.
    //
    // Vale igual para una NOTA DE CRÉDITO (decisión del dueño, 24/09): nace
    // aprobada y baja la deuda en el acto. Las firmas que controlan la plata
    // (no pagar lo propio ni lo aprobado) no ceden.
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
      .eq('proveedor_id', dto.proveedor_id).eq('clase', dto.clase).eq('total', aCentavos(dto.total)).eq('fecha', dto.fecha)
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
      .select('id, estado, clase, proveedor_id, fecha, vence_el, neto, iva, percepciones, otros, no_gravado, exento, total, aprobada_at')
      .eq('id', id).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')
    const a = actual as Record<string, any>
    if (a.estado === 'anulada') throw new PagosHttpError(409, 'FACTURA_CERRADA')

    const esNc = a.clase === 'nota_credito'
    // En una NC «pagada»/«pagada_parcial» quiere decir aplicada: también
    // congela lo que mueve plata (la RPC lo repite).
    const conPagos = a.estado === 'pagada' || a.estado === 'pagada_parcial'
    const { imputaciones, motivo, ...campos } = dto
    if (campos.aplica_a !== undefined) {
      // Las reglas de la RPC adelantadas al campo (misma respuesta).
      if (!esNc) throw errorDeCampo('CAMPO_NO_EDITABLE', 'aplica_a')
      if (a.aprobada_at != null || !['pendiente', 'observada'].includes(a.estado)) {
        throw new PagosHttpError(409, 'NC_APLICACION_CONGELADA', { nc_id: id, estado: a.estado })
      }
      const totalNuevo = Number(campos.total ?? a.total)
      if (aCentavos(sumaAplicaA(campos.aplica_a)) > aCentavos(totalNuevo)) {
        throw errorDeCampo('NC_SUPERA_TOTAL', 'aplica_a', { nc_id: id, total: aCentavos(totalNuevo), aplicado: sumaAplicaA(campos.aplica_a) })
      }
      campos.aplica_a = campos.aplica_a.map((x) => ({ factura_id: x.factura_id, monto: aCentavos(x.monto) }))
    }
    if (esNc) {
      for (const k of ['vence_el', 'plan_cheques'] as const) {
        if (campos[k]) throw errorDeCampo('NC_TIPO_INVALIDO', k)
      }
      if (campos.paga_cliente) throw errorDeCampo('NC_TIPO_INVALIDO', 'paga_cliente')
    }
    // Con detalle, las columnas agregadas se mandan YA derivadas (las mismas
    // que va a dejar `_pagos_guardar_desglose`): así lo que se compara contra
    // lo congelado y lo que valida el cierre es lo que va a quedar guardado.
    if (campos.iva_detalle || campos.tributos) {
      const ef = importesEfectivos({ ...(a as ImportesFactura), ...(campos as Partial<ImportesFactura>) } as ImportesFactura)
      const c = campos as Record<string, unknown>
      if (campos.iva_detalle) { c.iva = ef.iva; if (campos.iva_detalle.length) c.neto = ef.neto }
      if (campos.tributos) { c.percepciones = ef.percepciones; c.otros = ef.otros }
    }
    const tocados = (Object.keys(campos) as (keyof typeof campos)[]).filter((k) => campos[k] !== undefined)

    if (conPagos) {
      const congelados = tocados.filter((k) =>
        (CAMPOS_CONGELADOS as readonly string[]).includes(k) && valorComparable(campos[k]) !== valorComparable(a[k]))
      if (congelados.length > 0) throw new PagosHttpError(409, 'FACTURA_CON_PAGOS', { campos: congelados })
      if (imputaciones && !motivo) throw errorDeCampo('MOTIVO_REQUERIDO', 'motivo')
    }

    const merged = { ...a, ...Object.fromEntries(tocados.map((k) => [k, campos[k]])) } as ImportesFactura
    const cambiaImputable = tocados.includes('total') || tocados.includes('percepciones') || tocados.includes('tributos')
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
      .from('pagos_facturas').select('id, estado, clase, created_by, created_at, pagada_al_cargar, aprobada_at').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')
    const f = data as { estado: string; clase: string; created_by: string | null; created_at: string; pagada_al_cargar: boolean; aprobada_at: string | null }
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
    // Una NC aplicada («pagada»/«pagada_parcial») SÍ se anula: la deuda vuelve
    // a las facturas que acreditaba (lo hace la RPC). Una factura con NC
    // vigentes aplicadas rebota en la RPC con FACTURA_CON_NC { nc_ids }.
    if (f.clase !== 'nota_credito' && (f.estado === 'pagada' || f.estado === 'pagada_parcial')) {
      throw new PagosHttpError(409, 'FACTURA_CON_PAGOS')
    }
    if (!(admin || permisoPagos(perfil, 'eliminacion') || (propia && permisoPagos(perfil, 'actualizacion')))) {
      throw new PagosHttpError(403, 'SIN_PERMISO', { flag: 'eliminacion', motivo: 'una factura ajena la anula quien tiene eliminación' })
    }
    return enmascararRespuesta(
      rpcOk<Record<string, unknown>>(await supabase.rpc('pagos_anular_factura', { p_factura_id: id, p_motivo: motivo, p_user_id: userId })), verPiiDe(perfil))
  },

  /**
   * POST /facturas/:id/aplicar-nc: aplica crédito sobrante de una NC aprobada
   * a facturas del mismo proveedor. Solo agrega (si ya había aplicación a esa
   * factura, suma). La ruta ya chequeó `aprobar_facturas` O `registrar_pagos`;
   * la RPC valida el resto con locks (NC_NO_APROBADA, NC_SIN_CREDITO,
   * NC_SUPERA_TOTAL, NC_SUPERA_SALDO, NC_OTRO_PROVEEDOR).
   * Devuelve `{ nc, facturas }` (filas de v_pagos_facturas).
   */
  async aplicarNc(id: number, dto: AplicarNcDto, userId: string, verPii: boolean) {
    const res = rpcOk<{ nc: Record<string, unknown>; facturas: Record<string, unknown>[] }>(
      await supabase.rpc('pagos_aplicar_nc', {
        p_nc_id:    id,
        p_aplica_a: dto.aplica_a.map((a) => ({ factura_id: a.factura_id, monto: aCentavos(a.monto) })),
        p_user_id:  userId,
      }))
    console.info(`[pagos] NC ${id}: aplicado ${sumaAplicaA(dto.aplica_a)} a facturas ${dto.aplica_a.map((a) => a.factura_id).join(',')} (user ${userId})`)
    return {
      nc: res.nc ? enmascararFila(res.nc, verPii) : res.nc,
      facturas: (res.facturas ?? []).map((f) => enmascararFila(f, verPii)),
    }
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
    // NC vigentes aplicadas a esas facturas (20260925a): van con su PDF
    // dentro de la carpeta de la OP, al lado de la factura que acreditan.
    const ncPorFactura = await aplicacionesDe('factura', facturaIds, token)
    const ncIds = [...new Set([...ncPorFactura.values()].flat().filter((a) => a.vigente).map((a) => a.nc_id))]
    const conPapeles = [...new Set([...facturaIds, ...ncIds])]
    const [facturas, adjF] = await Promise.all([
      facturaIds.length === 0 ? Promise.resolve({ data: [], error: null }) : sb
        .from('v_pagos_facturas')
        .select('id, tipo_comprobante, numero, fecha, vence_el, total, estado, descripcion, proveedor_nom')
        .in('id', facturaIds),
      conPapeles.length === 0 ? Promise.resolve({ data: [], error: null }) : sb
        .from('pagos_facturas_adjuntos')
        .select('id, factura_id, tipo, storage_path, nombre_archivo, mime_type, size_bytes')
        .in('factura_id', conPapeles).is('deleted_at', null),
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

    const archivo = (a: any, origen: 'factura' | 'pago' | 'nota_credito') => ({
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
              notas_credito: (ncPorFactura.get(fid) ?? []).filter((a) => a.vigente).map((a) => ({
                nc_id: a.nc_id,
                tipo_comprobante: a.nc?.tipo_comprobante ?? null, numero: a.nc?.numero ?? null,
                fecha: a.nc?.fecha ?? null, total: a.nc?.total ?? null, estado: a.nc?.estado ?? null,
                aprobada: a.aprobada,
                monto_aplicado: a.monto,
                archivos: (adjDeFactura.get(a.nc_id) ?? []).map((x) => archivo(x, 'nota_credito')),
              })),
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
    // Las NC aplicadas a cada factura (20260925a), solo las vigentes: la OP
    // no las suma (son crédito, no plata), pero el contador tiene que ver que
    // la factura no se pagó entera porque hubo una NC, con el PDF de la NC.
    const ncPorFactura = await aplicacionesDe('factura', facturaIds, token)
    const ncIds = [...new Set([...ncPorFactura.values()].flat().filter((a) => a.vigente).map((a) => a.nc_id))]
    const conPapeles = [...new Set([...facturaIds, ...ncIds])]
    let adjPorFactura = new Map<number, unknown[]>()
    if (conPapeles.length > 0) {
      const { data: adjF, error: adjErr } = await sb
        .from('pagos_facturas_adjuntos')
        .select('id, factura_id, tipo, nombre_archivo, mime_type, size_bytes, created_at')
        .in('factura_id', conPapeles).is('deleted_at', null)
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
      factura: l.factura ? {
        ...l.factura,
        adjuntos: adjPorFactura.get(l.factura_id) ?? [],
        notas_credito: (ncPorFactura.get(l.factura_id) ?? []).filter((a) => a.vigente)
          .map((a) => ({ ...a, adjuntos: adjPorFactura.get(a.nc_id) ?? [] })),
      } : l.factura,
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

    // Desde el 2026-09-25 la nota de crédito no es una línea de la OP (es un
    // comprobante aplicado a la factura): toda OP mueve plata.
    const montoPagado = sumaCentavos(dto.lineas.map((l) => l.monto))
    const formaPago: string = dto.forma_pago ?? ''
    if (!formaPago) throw errorDeCampo('FORMA_PAGO_REQUERIDA', 'forma_pago')
    validarCheques(formaPago, dto.cheques, dto.fecha, montoPagado)
    const tipos = new Set(dto.adjuntos.map((a) => a.tipo))
    if ((FORMAS_CON_COMPROBANTE_OBLIGATORIO as readonly string[]).includes(formaPago) && !tipos.has('comprobante_pago')) {
      throw errorDeCampo('COMPROBANTE_REQUERIDO', 'adjuntos', { forma_pago: formaPago, tipo: 'comprobante_pago' })
    }

    // Separación de funciones, por factura, antes de la RPC (admin exento).
    const facturaIds = [...new Set(dto.lineas.map((l) => l.factura_id).filter((x): x is number => x != null))]
    if (facturaIds.length > 0) {
      const { data: facts, error } = await supabase
        .from('pagos_facturas').select('id, clase, created_by, aprobada_por, proveedor_id').in('id', facturaIds)
      if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
      const porId = new Map(((facts ?? []) as { id: number; clase: string; created_by: string | null; aprobada_por: string | null; proveedor_id: number }[]).map((f) => [f.id, f]))
      for (const fid of facturaIds.sort((a, b) => a - b)) {
        const f = porId.get(fid)
        if (!f) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: fid })
        if (f.clase === 'nota_credito') throw new PagosHttpError(409, 'NC_NO_SE_PAGA', { factura_id: fid })
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
          monto_pagado: montoPagado, monto_nc: 0,
          cheques: dto.cheques ?? [],
        },
        p_lineas: dto.lineas.map((l) => ({
          tipo: l.tipo, factura_id: l.factura_id ?? null, monto: aCentavos(l.monto),
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

  /**
   * El contador marca la OP como registrada en Finnegans (20260923c). Sólo
   * emitidas; un número de Finnegans, una OP. El `is(null)` del update hace
   * que dos clics simultáneos no se pisen: el segundo ve ORDEN_YA_REGISTRADA.
   */
  async registrarFinnegans(id: number, dto: RegistrarFinnegansDto, userId: string) {
    const numero = dto.numero_finnegans.trim()
    if (!numero) throw errorDeCampo('NUMERO_FINNEGANS_REQUERIDO', 'numero_finnegans')

    const { data, error } = await supabase.from('pagos_ordenes')
      .select('id, estado, numero_finnegans').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'ORDEN_NO_EXISTE')
    const o = data as { estado: string; numero_finnegans: string | null }
    if (o.estado !== 'emitida') throw new PagosHttpError(409, 'ORDEN_ANULADA')
    if (o.numero_finnegans) throw new PagosHttpError(409, 'ORDEN_YA_REGISTRADA', { numero_finnegans: o.numero_finnegans })

    const otra = await ordenConNumeroFinnegans(numero)
    if (otra) throw new PagosHttpError(409, 'FINNEGANS_DUPLICADO', { campo: 'numero_finnegans', ...otra })

    const { data: upd, error: e2 } = await supabase.from('pagos_ordenes')
      .update({ numero_finnegans: numero, registrada_at: new Date().toISOString(), registrada_por: userId, updated_by: userId })
      .eq('id', id).is('numero_finnegans', null)
      .select('id, numero, numero_finnegans, registrada_at').maybeSingle()
    if (e2) {
      if (e2.code === '23505') {
        throw new PagosHttpError(409, 'FINNEGANS_DUPLICADO', { campo: 'numero_finnegans', ...(await ordenConNumeroFinnegans(numero)) })
      }
      throw mapRpcError(e2)
    }
    if (!upd) throw new PagosHttpError(409, 'ORDEN_YA_REGISTRADA')
    return upd
  },

  /** Deshacer el registro (número mal tipeado). No toca plata. */
  async deshacerRegistroFinnegans(id: number, userId: string) {
    const { data, error } = await supabase.from('pagos_ordenes')
      .update({ numero_finnegans: null, registrada_at: null, registrada_por: null, updated_by: userId })
      .eq('id', id).not('numero_finnegans', 'is', null)
      .select('id, numero').maybeSingle()
    if (error) throw mapRpcError(error)
    if (!data) {
      const { data: existe } = await supabase.from('pagos_ordenes').select('id').eq('id', id).maybeSingle()
      throw existe ? new PagosHttpError(409, 'ORDEN_NO_REGISTRADA') : new PagosHttpError(404, 'ORDEN_NO_EXISTE')
    }
    return data
  },

  // ═══════════════════════════════════ Catálogos ══════════════════════════════

  /** Obras activas y archivadas como centros de costo. El módulo no depende de GET /api/obras. */
  async catalogoObras() {
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) =>
      supabase.from('obras').select('cod, nom, cc, es_interna, es_deposito, archivada').order('archivada').order('nom').order('cod').range(d, h))
    return filas
  },
}
