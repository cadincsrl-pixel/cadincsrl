/**
 * Reglas puras de Facturación (fase 1, 2026-09-24). Sin base ni red: las
 * prueba vitest y el build las corre.
 *
 * Espejos: el cálculo de totales es el mismo que hace `ventas_guardar_borrador`
 * en la base (20260924c) y el que muestra el formulario del frontend. La base
 * es la que manda (recalcula siempre); esto sirve para armar el pedido a ARCA
 * desde lo que la base guardó y para los tests.
 *
 *   importe_neto del renglón = round(round(cantidad, 4) × round(precio, 3), 2)
 *   IVA por alícuota        = round(Σ bases del grupo × tasa, 2)   ← NO renglón por renglón
 *   total                   = neto + IVA
 */
import type { ComprobanteSolicitud, ComprobanteConsultado, ResultadoCAE, ErrArca } from '../../lib/arca/index.js'

// ── Catálogos fijos ─────────────────────────────────────────────────────────

/** Tipos habilitados en la fase 1: Factura A y Nota de Crédito A. */
export const TIPOS_HABILITADOS = [1, 3] as const
export const TIPOS_NC = new Set([3, 8, 203])

/** Tasa por Id de alícuota de ARCA (FEParamGetTiposIva). Espejo de `ventas_tasa_iva`. */
export const TASA_IVA: Readonly<Record<number, number>> = {
  3: 0, 4: 0.105, 5: 0.21, 6: 0.27, 8: 0.05, 9: 0.025,
}

/** Condición frente al IVA del receptor (FEParamGetCondicionIvaReceptor). */
export const CONDICIONES_IVA: ReadonlyArray<{ id: number; descripcion: string; admite_a: boolean }> = [
  { id: 1, descripcion: 'IVA Responsable Inscripto', admite_a: true },
  { id: 4, descripcion: 'IVA Sujeto Exento', admite_a: false },
  { id: 5, descripcion: 'Consumidor Final', admite_a: false },
  { id: 6, descripcion: 'Responsable Monotributo', admite_a: true },
  { id: 7, descripcion: 'Sujeto No Categorizado', admite_a: false },
  { id: 8, descripcion: 'Proveedor del Exterior', admite_a: false },
  { id: 9, descripcion: 'Cliente del Exterior', admite_a: false },
  { id: 10, descripcion: 'IVA Liberado – Ley N° 19.640', admite_a: false },
  { id: 13, descripcion: 'Monotributista Social', admite_a: true },
  { id: 15, descripcion: 'IVA No Alcanzado', admite_a: false },
  { id: 16, descripcion: 'Monotributo Trabajador Independiente Promovido', admite_a: true },
]
export const CONDICIONES_IVA_IDS = new Set(CONDICIONES_IVA.map((c) => c.id))
const CONDICIONES_A = new Set(CONDICIONES_IVA.filter((c) => c.admite_a).map((c) => c.id))

/** CUIT de CADINC: el emisor. Va en el Auth de WSFE y en cada CbteAsoc. */
export const CUIT_EMISOR = '33717191949'

export type Producto = 'AVANCE DE OBRA' | 'TRANSPORTE'

// ── Redondeos y totales ─────────────────────────────────────────────────────

/**
 * Redondeo half-up a n decimales, como `round(numeric, n)` de Postgres. Pasa
 * por notación exponencial para no arrastrar el error binario (1.005 → 1.01).
 */
export function redondear(n: number, dec: number): number {
  const abs = Math.abs(n)
  let v = Number(`${Math.round(Number(`${abs}e${dec}`))}e-${dec}`)
  if (!Number.isFinite(v)) v = Math.round(abs * 10 ** dec) / 10 ** dec
  return n < 0 ? -v : v
}
export const r2 = (n: number) => redondear(n, 2)

/** Tasa en milésimos (0,105 → 105) para calcular IVA en enteros. */
const TASA_MIL: Readonly<Record<number, bigint>> = { 3: 0n, 4: 105n, 5: 210n, 6: 270n, 8: 50n, 9: 25n }

export interface RenglonCalculo {
  cantidad?: number | null
  precio_unit: number
  alicuota_id?: number | null
}

export interface Totales {
  neto: number
  iva: number
  total: number
  alicuotas: Array<{ alicuota_id: number; tasa: number; base_imp: number; importe: number }>
}

/** Entero escalado: 12.3456 con 4 decimales → 123456n (redondeado half-up). */
function escalado(n: number, dec: number): bigint {
  return BigInt(Math.round(Number(`${redondear(n, dec)}e${dec}`)))
}
/** a / b redondeado half-up, para a ≥ 0 y b > 0. */
function divRedondeo(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (b * 2n)
}
const deCentavos = (c: bigint) => Number(c) / 100

/** Centavos del neto del renglón: round(round(cant,4) × round(precio,3), 2). Exacto. */
function netoRenglonCentavos(r: RenglonCalculo): bigint {
  const cant = escalado(r.cantidad ?? 1, 4)      // × 1e4
  const precio = escalado(r.precio_unit, 3)      // × 1e3
  const prod = cant * precio                     // × 1e7
  return prod >= 0n ? divRedondeo(prod, 100_000n) : -divRedondeo(-prod, 100_000n)
}

export function importeNetoRenglon(r: RenglonCalculo): number {
  return deCentavos(netoRenglonCentavos(r))
}

/** Totales de un comprobante: neto por renglón, IVA sobre la base agrupada por alícuota. */
export function calcularTotales(renglones: RenglonCalculo[]): Totales {
  const bases = new Map<number, bigint>()
  for (const r of renglones) {
    const id = r.alicuota_id ?? 5
    if (TASA_MIL[id] === undefined) throw new Error(`alícuota ${id} desconocida`)
    bases.set(id, (bases.get(id) ?? 0n) + netoRenglonCentavos(r))
  }
  let neto = 0n
  let iva = 0n
  const alicuotas = [...bases.entries()]
    .sort(([a], [b]) => a - b)
    .map(([alicuota_id, base]) => {
      const importe = divRedondeo(base * (TASA_MIL[alicuota_id] ?? 0n), 1000n)
      neto += base
      iva += importe
      return { alicuota_id, tasa: TASA_IVA[alicuota_id] ?? 0, base_imp: deCentavos(base), importe: deCentavos(importe) }
    })
  return { neto: deCentavos(neto), iva: deCentavos(iva), total: deCentavos(neto + iva), alicuotas }
}

// ── Fechas ──────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' (o timestamp ISO) → 'yyyymmdd'. */
export function aYyyymmdd(iso: string): string {
  const d = iso.slice(0, 10).replace(/-/g, '')
  if (!/^\d{8}$/.test(d)) throw new Error(`fecha inválida: ${iso}`)
  return d
}

/** 'yyyymmdd' → 'YYYY-MM-DD'. null si no tiene esa forma. */
export function deYyyymmdd(s: string | null | undefined): string | null {
  if (!s || !/^\d{8}$/.test(s)) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

// ── Concepto y letra ────────────────────────────────────────────────────────

/** AVANCE DE OBRA → 3 (productos y servicios); TRANSPORTE → 2 (servicios). */
export function conceptoDe(producto: Producto | string): 2 | 3 {
  return producto === 'TRANSPORTE' ? 2 : 3
}

export function esNC(cbteTipo: number): boolean {
  return TIPOS_NC.has(cbteTipo)
}

/** Factura A: receptor con CUIT (80) y condición 1, 6, 13 o 16. Espejo de `_ventas_validar_receptor`. */
export function admiteLetraA(docTipo: number, condicionIvaId: number): boolean {
  return docTipo === 80 && CONDICIONES_A.has(condicionIvaId)
}

// ── Del FJ de la base al pedido a ARCA ──────────────────────────────────────

/** Lo que devuelven las RPC `ventas_*` (forma FJ). Solo los campos que se usan acá. */
export interface FJ {
  factura: FacturaVista
  renglones: Array<{ id: number; orden: number; descripcion: string; cantidad: number; unidad: string; precio_unit: number; alicuota_id: number; tasa: number; importe_neto: number }>
  alicuotas: Array<{ alicuota_id: number; tasa: number; base_imp: number; importe: number }>
  asociados: Array<{ asociada_id: number; cbte_tipo: number; pto_vta: number; numero: number; cuit: string; fecha_cbte: string }>
}

export interface FacturaVista {
  id: number
  ambiente: 'homo' | 'prod'
  pto_vta: number
  cbte_tipo: number
  numero: number | null
  numero_intentado: number | null
  estado: 'borrador' | 'emitiendo' | 'autorizada' | 'rechazada' | 'error_reconciliar' | 'descartada'
  concepto: number
  fecha_cbte: string
  fch_vto_pago: string | null
  cliente_id: number
  rec_doc_tipo: number
  rec_doc_nro: string
  rec_condicion_iva_id: number
  producto: string
  centro_costo: string | null
  moneda: string
  cotizacion: number
  imp_neto: number
  imp_iva: number
  imp_trib: number
  imp_op_ex: number
  imp_tot_conc: number
  imp_total: number
  intento_at: string | null
  updated_at: string
  emitida_por: string | null
  created_by: string | null
  [k: string]: unknown
}

/**
 * El FECAESolicitar de UN comprobante, desde lo que la base guardó. Con
 * concepto 2/3: FchServDesde = FchServHasta = FchVtoPago = CbteFch (el dueño
 * nunca usa período). NC: CbtesAsoc con el CUIT de CADINC y la fecha de la
 * factura. CondicionIVAReceptorId va siempre.
 */
export function armarComprobante(fj: FJ, numero: number): ComprobanteSolicitud {
  const f = fj.factura
  const concepto = Number(f.concepto) as 1 | 2 | 3
  const cbteFch = aYyyymmdd(f.fecha_cbte)
  const c: ComprobanteSolicitud = {
    ptoVta: Number(f.pto_vta),
    cbteTipo: Number(f.cbte_tipo),
    numero,
    concepto,
    docTipo: Number(f.rec_doc_tipo),
    docNro: String(f.rec_doc_nro),
    cbteFch,
    impTotal: Number(f.imp_total),
    impTotConc: Number(f.imp_tot_conc ?? 0),
    impNeto: Number(f.imp_neto),
    impOpEx: Number(f.imp_op_ex ?? 0),
    impTrib: Number(f.imp_trib ?? 0),
    impIva: Number(f.imp_iva),
    monId: f.moneda || 'PES',
    monCotiz: Number(f.cotizacion ?? 1),
    condicionIvaReceptorId: Number(f.rec_condicion_iva_id),
    iva: fj.alicuotas.map((a) => ({ id: Number(a.alicuota_id), baseImp: Number(a.base_imp), importe: Number(a.importe) })),
  }
  if (concepto !== 1) {
    c.fchServDesde = cbteFch
    c.fchServHasta = cbteFch
    c.fchVtoPago = cbteFch
  }
  if (esNC(c.cbteTipo)) {
    c.cbtesAsoc = fj.asociados.map((a) => ({
      tipo: Number(a.cbte_tipo),
      ptoVta: Number(a.pto_vta),
      nro: Number(a.numero),
      cuit: a.cuit || CUIT_EMISOR,
      cbteFch: aYyyymmdd(a.fecha_cbte),
    }))
  }
  return c
}

// ── De la respuesta de ARCA al p_res de `ventas_confirmar_emision` ──────────

export interface PRes {
  resultado: 'A' | 'R' | 'incierto'
  numero?: number
  cae?: string | null
  cae_vto?: string | null
  fecha_cbte?: string | null
  observaciones?: ErrArca[]
  errores?: ErrArca[]
  error?: string
}

export function pResDeCAE(r: ResultadoCAE): PRes {
  if (r.resultado === 'A') {
    return {
      resultado: 'A', numero: r.numero, cae: r.cae, cae_vto: deYyyymmdd(r.caeVto),
      observaciones: r.observaciones, errores: r.errores,
    }
  }
  return { resultado: 'R', numero: r.numero, observaciones: r.observaciones, errores: r.errores }
}

/** Resultado A reconstruido desde FECompConsultar (reconciliación). */
export function pResDeConsultado(c: ComprobanteConsultado): PRes {
  return {
    resultado: 'A',
    numero: c.numero,
    cae: c.codAutorizacion,
    cae_vto: deYyyymmdd(c.fchVto),
    fecha_cbte: deYyyymmdd(c.cbteFch),
    observaciones: c.observaciones,
    errores: [],
  }
}

/**
 * ¿El comprobante que ARCA tiene con ese número es ESTE? Mismo documento del
 * receptor y mismo total (al centavo), mismo tipo y PV, y aprobado con CAE.
 */
export function coincideConsultado(f: Pick<FacturaVista, 'rec_doc_nro' | 'imp_total' | 'cbte_tipo' | 'pto_vta'>, c: ComprobanteConsultado): boolean {
  const doc = (s: string | number) => String(s).replace(/\D/g, '').replace(/^0+/, '')
  return c.resultado === 'A'
    && /^\d{14}$/.test(c.codAutorizacion)
    && Number(c.cbteTipo) === Number(f.cbte_tipo)
    && Number(c.ptoVta) === Number(f.pto_vta)
    && doc(c.docNro) === doc(f.rec_doc_nro)
    && Math.round(Number(c.impTotal) * 100) === Math.round(Number(f.imp_total) * 100)
}

// ── Resumen ─────────────────────────────────────────────────────────────────

export interface FilaResumen {
  mes: string
  centro_costo: string | null
  producto: string
  letra: string
  cantidad: number
  neto: number
  iva: number
  total: number
}

/**
 * Autorizadas agrupadas por mes, centro de costo, producto y letra. Las NC
 * restan (neto, IVA y total negativos) y cuentan en `cantidad`.
 */
export function resumir(filas: Array<{ mes: string; centro_costo: string | null; producto: string; letra: string; es_nc: boolean; imp_neto: number; imp_iva: number; imp_total: number }>): FilaResumen[] {
  const grupos = new Map<string, FilaResumen>()
  for (const f of filas) {
    const clave = [f.mes, f.centro_costo ?? '', f.producto, f.letra].join('\u0000')
    const g = grupos.get(clave) ?? { mes: f.mes, centro_costo: f.centro_costo ?? null, producto: f.producto, letra: f.letra, cantidad: 0, neto: 0, iva: 0, total: 0 }
    const s = f.es_nc ? -1 : 1
    g.cantidad += 1
    g.neto = r2(g.neto + s * Number(f.imp_neto))
    g.iva = r2(g.iva + s * Number(f.imp_iva))
    g.total = r2(g.total + s * Number(f.imp_total))
    grupos.set(clave, g)
  }
  return [...grupos.values()].sort((a, b) =>
    b.mes.localeCompare(a.mes)
    || (a.centro_costo ?? '').localeCompare(b.centro_costo ?? '')
    || a.producto.localeCompare(b.producto)
    || a.letra.localeCompare(b.letra))
}

// ── Clientes ────────────────────────────────────────────────────────────────

/**
 * Documento normalizado: solo dígitos. Consumidor final sin identificar (99)
 * va siempre con '0'. null si queda vacío.
 */
export function normDoc(docTipo: number, docNro: string | number | null | undefined): string | null {
  if (docTipo === 99) return '0'
  const d = String(docNro ?? '').replace(/\D+/g, '')
  return d ? d : null
}
