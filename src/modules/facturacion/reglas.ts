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
import type { ComprobanteSolicitud, ComprobanteConsultado, ResultadoCAE, ErrArca, Opcional } from '../../lib/arca/index.js'

// ── Catálogos fijos ─────────────────────────────────────────────────────────

/** Tipos habilitados: Factura A/B, NC A/B (fase 5) y FCE MiPyME A + su NC (fase 6). */
export const TIPOS_HABILITADOS = [1, 3, 6, 8, 201, 203] as const
export const TIPOS_NC = new Set([3, 8, 203])
export const TIPOS_FCE = new Set([201, 203])

/**
 * Monto mínimo de la Factura de Crédito Electrónica MiPyME: $ 5.549.862.
 * Fuente: Registro de FCE MiPyMEs de ARCA, vigente desde el 14/04/2026
 * (consultado el 23/09/2026). WSFECRED (`consultarMontoObligadoRecepcion`)
 * devuelve el monto de cada receptor y es el que manda; este es el piso
 * general. Espejo de `_ventas_monto_minimo_fce()` (20260924e) y de
 * MONTO_MINIMO_FCE del frontend.
 */
export const MONTO_MINIMO_FCE = 5_549_862

/** Opción de transferencia de la FCE (opcional 27). */
export type TransmisionFce = 'SCA' | 'ADC'
export const TRANSMISIONES_FCE: ReadonlyArray<{ id: TransmisionFce; descripcion: string }> = [
  { id: 'SCA', descripcion: 'Sistema de Circulación Abierta' },
  { id: 'ADC', descripcion: 'Agente de Depósito Colectivo' },
]

/** Tasa por Id de alícuota de ARCA (FEParamGetTiposIva). Espejo de `ventas_tasa_iva`. */
export const TASA_IVA: Readonly<Record<number, number>> = {
  3: 0, 4: 0.105, 5: 0.21, 6: 0.27, 8: 0.05, 9: 0.025,
}

/** Condición frente al IVA del receptor (FEParamGetCondicionIvaReceptor). */
/**
 * Clase de cada condición según FEParamGetCondicionIvaReceptor('A' | 'B'),
 * verificado en homologación el 23/09/2026: A acepta 1, 6, 13 y 16; B acepta
 * 4, 5, 7, 8, 9, 10 y 15. Ninguna condición está en las dos.
 */
export const CONDICIONES_IVA: ReadonlyArray<{ id: number; descripcion: string; admite_a: boolean; admite_b: boolean }> = [
  { id: 1, descripcion: 'IVA Responsable Inscripto', admite_a: true, admite_b: false },
  { id: 4, descripcion: 'IVA Sujeto Exento', admite_a: false, admite_b: true },
  { id: 5, descripcion: 'Consumidor Final', admite_a: false, admite_b: true },
  { id: 6, descripcion: 'Responsable Monotributo', admite_a: true, admite_b: false },
  { id: 7, descripcion: 'Sujeto No Categorizado', admite_a: false, admite_b: true },
  { id: 8, descripcion: 'Proveedor del Exterior', admite_a: false, admite_b: true },
  { id: 9, descripcion: 'Cliente del Exterior', admite_a: false, admite_b: true },
  { id: 10, descripcion: 'IVA Liberado – Ley N° 19.640', admite_a: false, admite_b: true },
  { id: 13, descripcion: 'Monotributista Social', admite_a: true, admite_b: false },
  { id: 15, descripcion: 'IVA No Alcanzado', admite_a: false, admite_b: true },
  { id: 16, descripcion: 'Monotributo Trabajador Independiente Promovido', admite_a: true, admite_b: false },
]
export const CONDICIONES_IVA_IDS = new Set(CONDICIONES_IVA.map((c) => c.id))
const CONDICIONES_A = new Set(CONDICIONES_IVA.filter((c) => c.admite_a).map((c) => c.id))
const CONDICIONES_B = new Set(CONDICIONES_IVA.filter((c) => c.admite_b).map((c) => c.id))

/**
 * Desde este total el consumidor final se identifica (RG ARCA 5700/2025,
 * vigente desde el 29/05/2025: "igual o superior a $ 10.000.000"). Un
 * comprobante B con documento 99 y total ≥ tope → CF_REQUIERE_IDENTIFICACION.
 * Espejo de `_ventas_tope_cf()` (20260924d) y del frontend. Si ARCA lo
 * cambia, rebota con su propio error (10015/10013 según la versión del
 * manual) y hay que tocar los tres lugares.
 */
export const TOPE_CF_IDENTIFICACION = 10_000_000

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

// ── Cache de WSFECRED ────────────────────────────────────────────────────

/** Días que vale el dato de WSFECRED guardado en el cliente. */
export const DIAS_CACHE_FCE = 30

/** Hoy en Argentina (UTC−3), YYYY-MM-DD. */
export function hoyAr(ahora = Date.now()): string {
  return new Date(ahora - 3 * 3600_000).toISOString().slice(0, 10)
}

export function cacheVigente(consultadoAt: string | null | undefined, ahora = Date.now()): boolean {
  if (!consultadoAt) return false
  const t = new Date(consultadoAt).getTime()
  return Number.isFinite(t) && ahora - t < DIAS_CACHE_FCE * 86_400_000
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

export type Letra = 'A' | 'B'

/**
 * La letra la decide el cliente, no el usuario (espejo de
 * `_ventas_validar_receptor`, 20260924d):
 *   A → CUIT y condición 1, 6, 13 o 16;
 *   B → condición 4, 5, 7, 8, 9, 10 o 15, con cualquier documento;
 *   null → ninguna: un RI o monotributista SIN CUIT (ARCA no acepta esas
 *          condiciones en la B). Hay que corregir el cliente.
 */
export function letraDe(docTipo: number, condicionIvaId: number): Letra | null {
  if (admiteLetraA(docTipo, condicionIvaId)) return 'A'
  if (CONDICIONES_B.has(condicionIvaId)) return 'B'
  return null
}

/** Letra de un tipo de comprobante (null si no es A ni B). */
export function letraDeTipo(cbteTipo: number): Letra | null {
  if ([1, 3, 201, 203].includes(cbteTipo)) return 'A'
  if ([6, 8].includes(cbteTipo)) return 'B'
  return null
}

/** El tipo que corresponde: factura o NC de esa letra (con `fce`, la FCE MiPyME A: 201 / 203). */
export function tipoPara(letra: Letra, nc: boolean, fce = false): 1 | 3 | 6 | 8 | 201 | 203 {
  if (letra === 'A') return fce ? (nc ? 203 : 201) : (nc ? 3 : 1)
  return nc ? 8 : 6
}

export function esFce(cbteTipo: number): boolean {
  return TIPOS_FCE.has(cbteTipo)
}

/**
 * ¿La factura a este receptor tiene que ser FCE? Con el dato de WSFECRED
 * (obligado y monto desde). `null` = no se sabe (WSFECRED no respondió o
 * nunca se consultó): no se bloquea nada.
 *   - obligado y total ≥ max(monto del receptor, mínimo general) → FCE.
 *   - no obligado, o total < monto → Factura A común.
 */
export function correspondeFce(
  info: { obligado: boolean | null; montoDesde: number | null } | null,
  total: number,
): boolean | null {
  if (!info || info.obligado === null) return null
  if (!info.obligado) return false
  const piso = Math.max(info.montoDesde ?? MONTO_MINIMO_FCE, 0)
  return Math.round(total * 100) >= Math.round(piso * 100)
}

/** ¿Hay que identificar al receptor? Comprobante B, sin documento (99) y total ≥ tope. */
export function requiereIdentificacion(cbteTipo: number, docTipo: number, total: number): boolean {
  return letraDeTipo(cbteTipo) === 'B' && docTipo === 99 && Math.round(total * 100) >= TOPE_CF_IDENTIFICACION * 100
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
  fce_cbu?: string | null
  fce_alias?: string | null
  fce_transmision?: string | null
  fce_referencia?: string | null
  nc_anulacion?: string | null
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
  const opcionales = opcionalesFce(f)
  if (c.cbteTipo === 201) {
    // La FCE lleva SIEMPRE vencimiento de pago: el que eligió el usuario.
    c.fchVtoPago = aYyyymmdd(f.fch_vto_pago ?? f.fecha_cbte)
  } else if (c.cbteTipo === 203) {
    // NC FCE: sin vencimiento de pago (manual WSFEv1).
    delete c.fchVtoPago
  }
  if (opcionales.length) c.opcionales = opcionales
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

/**
 * Opcionales de WSFE para la FCE:
 *   201 → 2101 CBU, 2102 alias (si hay), 23 referencia comercial (si hay),
 *         27 opción de transferencia (SCA | ADC).
 *   203 → 22 «es anulación» (S | N). Sin CBU.
 */
export function opcionalesFce(f: Pick<FacturaVista, 'cbte_tipo' | 'fce_cbu' | 'fce_alias' | 'fce_transmision' | 'fce_referencia' | 'nc_anulacion'>): Opcional[] {
  const tipo = Number(f.cbte_tipo)
  if (tipo === 201) {
    const ops: Opcional[] = [{ id: '2101', valor: String(f.fce_cbu ?? '') }]
    if (f.fce_alias) ops.push({ id: '2102', valor: String(f.fce_alias) })
    if (f.fce_referencia) ops.push({ id: '23', valor: String(f.fce_referencia) })
    ops.push({ id: '27', valor: String(f.fce_transmision || 'SCA') })
    return ops
  }
  if (tipo === 203) return [{ id: '22', valor: f.nc_anulacion === 'S' ? 'S' : 'N' }]
  return []
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
  /** La obra es el centro de costo (23/09). null = sin obra (transporte). */
  obra_cod: string | null
  obra_nom: string | null
  producto: string
  letra: string
  cantidad: number
  neto: number
  iva: number
  total: number
}

export interface FilaParaResumen {
  mes: string
  obra_cod: string | null
  obra_nom: string | null
  producto: string
  letra: string
  es_nc: boolean
  imp_neto: number
  imp_iva: number
  imp_total: number
}

/**
 * Autorizadas agrupadas por mes, obra, producto y letra. Las NC restan (neto,
 * IVA y total negativos) y cuentan en `cantidad`.
 */
export function resumir(filas: FilaParaResumen[]): FilaResumen[] {
  const grupos = new Map<string, FilaResumen>()
  for (const f of filas) {
    const clave = [f.mes, f.obra_cod ?? '', f.producto, f.letra].join('\u0000')
    const g = grupos.get(clave) ?? { mes: f.mes, obra_cod: f.obra_cod ?? null, obra_nom: f.obra_nom ?? null, producto: f.producto, letra: f.letra, cantidad: 0, neto: 0, iva: 0, total: 0 }
    const s = f.es_nc ? -1 : 1
    g.cantidad += 1
    g.neto = r2(g.neto + s * Number(f.imp_neto))
    g.iva = r2(g.iva + s * Number(f.imp_iva))
    g.total = r2(g.total + s * Number(f.imp_total))
    grupos.set(clave, g)
  }
  return [...grupos.values()].sort((a, b) =>
    b.mes.localeCompare(a.mes)
    || (a.obra_cod ?? '').localeCompare(b.obra_cod ?? '')
    || a.producto.localeCompare(b.producto)
    || a.letra.localeCompare(b.letra))
}

// ── Obras ───────────────────────────────────────────────────────────────────

export interface ObraFacturable { cod: string; es_interna: boolean; es_deposito: boolean }

/**
 * Obras que no se pueden vincular a un cliente (PUT /clientes/:id/obras):
 * primero las que no existen, después el depósito y las internas (no se le
 * facturan a nadie; CC PODA había quedado en la Iglesia por el atajo de `cc`).
 * null = todas vinculables.
 */
export function obrasNoVinculables(cods: string[], encontradas: ObraFacturable[]): { code: 'OBRA_NO_EXISTE' | 'OBRA_DEPOSITO' | 'OBRA_INTERNA'; obra_cods: string[] } | null {
  const por = new Map(encontradas.map((o) => [o.cod, o]))
  const faltan = cods.filter((c) => !por.has(c))
  if (faltan.length) return { code: 'OBRA_NO_EXISTE', obra_cods: faltan }
  const deposito = cods.filter((c) => por.get(c)?.es_deposito)
  if (deposito.length) return { code: 'OBRA_DEPOSITO', obra_cods: deposito }
  const internas = cods.filter((c) => por.get(c)?.es_interna)
  if (internas.length) return { code: 'OBRA_INTERNA', obra_cods: internas }
  return null
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
