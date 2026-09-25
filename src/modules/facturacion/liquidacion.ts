/**
 * Liquidación del cliente («cuenta de venta y líquido producto»): lectura del
 * texto y controles (20260930k). PURO: sin base ni red, para testear con el
 * texto real de las liquidaciones de Casilda Combustibles.
 *
 * El formato de Casilda (texto extraído del PDF en el navegador, renglón por
 * renglón; el espaciado no importa):
 *
 *   Liquidación Nro.: 3179            Fecha: 25/09/2026      C.U.I.T.: 30-71567526-5
 *   Compr. Transp.   11/09/2026 C.LIQ 0010 00000255 ...  1619133.70   ← bruto de la CVLP
 *   Compr. Cas.Comb. 11/09/2026 CTA.A 0010 00000255 ...  -122342.40   ← comisión de Casilda
 *   Subtotal: 1496791.30                                             ← = total de la CVLP en ARCA
 *   Recupero Ley 25413: -8500.00                                     ← deducción «con etiqueta»
 *   Descuentos
 *   05/09/2026 PAGO SEGUR 7 51799 PAGO SEGURO DE CARGA - 1 VIAJE -4000.00
 *   Total Liquidación: 1484291.30
 *   Detalle de Pagos
 *   CH/PROP 14575857 ICBC 01/11/2026 240000.00 - PAGO
 *
 * El PDF trae la misma liquidación dos veces («Hoja: 1» y «Hoja: 2», original
 * y copia): las hojas idénticas se leen una sola vez.
 *
 * Si el texto no cierra (no hay número, comprobantes o total), devuelve null
 * y el service sigue con la lectura por IA.
 */
import { normTxt } from '../../lib/norm-txt.js'

export interface ComprobanteLiquidado {
  pto_vta: number
  numero: number
  /** YYYY-MM-DD */
  fecha: string | null
  /** Total del comprobante del transportista (C.LIQ). */
  bruto: number
  /** Comisión de quien liquida (CTA.A), negativa. 0 si no vino. */
  comision: number
  /** bruto + comision: lo que se cancela de ese comprobante. */
  subtotal: number
}

export interface DeduccionLiquidada {
  /** Lo que dice el papel («Recupero Ley 25413», «PAGO SEGURO DE CARGA - 1 VIAJE»). */
  texto: string
  /** Código del concepto de Casilda («PAGO SEGUR», «GASTOS VAR»), si vino. */
  codigo: string | null
  /** Comprobante del descuento (CTG, recibo), si vino. */
  comprobante: string | null
  fecha: string | null
  /** Positivo. */
  importe: number
}

export interface ChequeLiquidado {
  /** CH/PROP = cheque propio de quien liquida (el librador es el cliente). */
  tipo: string
  numero: string
  banco: string
  /** YYYY-MM-DD */
  fecha_cobro: string | null
  importe: number
  propio: boolean
  /** Si la lectura lo dice (IA); si no, el service pone al cliente cuando es propio. */
  librador?: string | null
  librador_cuit?: string | null
}

export interface LiquidacionLeida {
  numero: string
  fecha: string | null
  /** CUIT de quien liquida (el cliente), 11 dígitos. */
  emisor_cuit: string | null
  emisor_nombre: string | null
  comprobantes: ComprobanteLiquidado[]
  subtotal: number | null
  deducciones: DeduccionLiquidada[]
  /** Total Liquidación / Saldo Neto. */
  neto: number | null
  cheques: ChequeLiquidado[]
  /** Renglones que parecían importar y no se entendieron. */
  avisos: string[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * «1619133.70», «-122342.40», «1.619.133,70», «$ 1,619,133.70» → número.
 * El separador decimal es el último punto o coma seguido de 1 o 2 dígitos.
 */
export function parseImporte(txt: string | null | undefined): number | null {
  if (txt == null) return null
  let s = String(txt).replace(/[$\s]/g, '')
  const neg = /^-|-$|^\(.*\)$/.test(s)
  s = s.replace(/[-()]/g, '')
  if (!/^[\d.,]+$/.test(s)) return null
  const m = s.match(/^(.*)[.,](\d{1,2})$/)
  const entero = (m ? (m[1] ?? '') : s).replace(/[.,]/g, '')
  const dec = m ? (m[2] ?? '0') : '0'
  const n = Number(`${entero || '0'}.${dec}`)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

/** 25/09/2026 → 2026-09-25 (null si no es una fecha válida). */
export function fechaIsoDe(dmy: string | null | undefined): string | null {
  const m = String(dmy ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const f = new Date(Date.UTC(y, mo - 1, d))
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== mo - 1 || f.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const IMP = String.raw`(-?[\d.,]*\d)`
const FECHA = String.raw`(\d{2}\/\d{2}\/\d{4})`
/** Etiquetas con importe que NO son deducciones. */
const ETIQUETAS_TOTALES = new Set(['subtotal', 'total descuentos', 'total liquidacion', 'saldo neto', 'total'])

/** Hojas únicas: el PDF de Casilda repite la liquidación (original y copia). */
function hojasUnicas(texto: string): string[][] {
  const lineas = texto.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const hojas: string[][] = []
  let actual: string[] = []
  for (const l of lineas) {
    if (/^Hoja:\s*\d+/i.test(l) && actual.length) {
      hojas.push(actual)
      actual = []
    }
    actual.push(l)
  }
  if (actual.length) hojas.push(actual)
  const vistas = new Set<string>()
  const out: string[][] = []
  for (const h of hojas) {
    const clave = h.filter((l) => !/^Hoja:/i.test(l)).join('\n')
    if (vistas.has(clave)) continue
    vistas.add(clave)
    out.push(h)
  }
  return out
}

/** Lee una liquidación con el formato de Casilda. null si el texto no la trae entera. */
export function parsearLiquidacionCasilda(texto: string): LiquidacionLeida | null {
  if (!texto || !/Liquidaci[oó]n\s+Nro/i.test(texto)) return null
  const hojas = hojasUnicas(texto)
  // Cada hoja con cabecera propia se lee sola: la que repite número y
  // comprobantes de una anterior es la copia (original y duplicado) y no suma.
  const leidas = hojas.map((h) => parsearLineas(h))
  if (leidas.length > 1 && leidas.every((l): l is LiquidacionLeida => l != null)) {
    const firma = (l: LiquidacionLeida) => `${l.numero}|${l.comprobantes.map((c) => `${c.pto_vta}-${c.numero}`).sort().join(',')}`
    const firmas = new Set(leidas.map(firma))
    if (firmas.size > 1) return null   // varias liquidaciones distintas en un archivo: que lea la IA
    const [original] = leidas
    return original ? { ...original, avisos: [...original.avisos, 'La copia de la liquidación (hoja 2) no es idéntica al original: se tomó la hoja 1'] } : null
  }
  if (leidas.length === 1) return leidas[0] ?? null
  // Una liquidación larga en varias hojas (sin cabecera repetida): se leen juntas.
  return parsearLineas(hojas.flat())
}

function parsearLineas(lineas: string[]): LiquidacionLeida | null {
  const todo = lineas.join('\n')

  const numero = todo.match(/Liquidaci[oó]n\s+Nro\.?\s*:?\s*(\d{1,12})/i)?.[1] ?? null
  const fecha = fechaIsoDe(todo.match(/\bFecha:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1])
  const cuitTxt = todo.match(/C\.U\.I\.T\.?\s*:\s*([\d-]{11,13})/)?.[1] ?? null
  const cuit = cuitTxt ? cuitTxt.replace(/\D/g, '') : null
  const emisor = todo.match(/Recib[ií]\s+de\s+(.+)/i)?.[1]?.trim() ?? lineas.find((l, i) => i < 4 && !/^Hoja/i.test(l)) ?? null

  const avisos: string[] = []
  const brutos = new Map<string, ComprobanteLiquidado>()
  const comisiones = new Map<string, number>()
  const deducciones: DeduccionLiquidada[] = []
  const cheques: ChequeLiquidado[] = []
  let subtotal: number | null = null
  let neto: number | null = null
  let totalLiq: number | null = null
  let seccion: 'cabecera' | 'descuentos' | 'pagos' = 'cabecera'

  const reCompr = new RegExp(String.raw`${FECHA}?\s*C\.?\s?LIQ\.?\s+(\d{1,5})\s+(\d{1,8})\b.*?\s${IMP}$`, 'i')
  const reComision = new RegExp(String.raw`CTA\.?\s?A\.?\s+(\d{1,5})\s+(\d{1,8})\b.*?\s${IMP}$`, 'i')
  const reEtiqueta = new RegExp(String.raw`^([A-Za-zÁÉÍÓÚáéíóúÑñ][^:]{1,60}?)\s*:\s*${IMP}$`)
  const reDescuento = new RegExp(String.raw`^${FECHA}\s+(.+?)\s+${IMP}$`)
  const reCheque = new RegExp(String.raw`^(CH\/[A-Z]+|E-?CHEQ\S*)\s+(?:(\d+)\s+)?(\d{4,})\s+([A-Za-z].*?)\s+${FECHA}\s+${IMP}\b`, 'i')

  for (const l of lineas) {
    if (/^Descuentos$/i.test(l)) { seccion = 'descuentos'; continue }
    if (/^Detalle de Pagos/i.test(l)) { seccion = 'pagos'; continue }
    if (/^Hoja:/i.test(l)) { seccion = 'cabecera'; continue }

    let m = l.match(reCompr)
    if (m) {
      const pto = Number(m[2]); const nro = Number(m[3]); const imp = parseImporte(m[4])
      if (imp != null) {
        const k = `${pto}-${nro}`
        const prev = brutos.get(k)
        if (prev) prev.bruto = r2(prev.bruto + imp)
        else brutos.set(k, { pto_vta: pto, numero: nro, fecha: fechaIsoDe(m[1]), bruto: imp, comision: 0, subtotal: 0 })
      }
      continue
    }
    m = l.match(reComision)
    if (m) {
      const imp = parseImporte(m[3])
      if (imp != null) {
        const k = `${Number(m[1])}-${Number(m[2])}`
        comisiones.set(k, r2((comisiones.get(k) ?? 0) + imp))
      }
      continue
    }
    if (seccion === 'pagos') {
      m = l.match(reCheque)
      if (m) {
        const imp = parseImporte(m[6])
        const tipo = (m[1] ?? '').toUpperCase()
        if (imp != null) {
          cheques.push({
            tipo, numero: m[3] ?? '', banco: (m[4] ?? '').trim(), fecha_cobro: fechaIsoDe(m[5]), importe: Math.abs(imp),
            propio: tipo === 'CH/PROP',
          })
        }
        continue
      }
      if (/-\s*PAGO\s*$/i.test(l) || /\d{2}\/\d{2}\/\d{4}\s+[\d.,]+/.test(l)) avisos.push(`Pago no reconocido: «${l}»`)
      continue
    }
    m = l.match(reEtiqueta)
    if (m) {
      const etiqueta = (m[1] ?? '').trim()
      const imp = parseImporte(m[2])
      const clave = normTxt(etiqueta)
      if (imp == null) continue
      if (clave === 'subtotal') subtotal = imp
      else if (clave === 'total liquidacion') totalLiq = imp
      else if (clave === 'saldo neto') neto = imp
      else if (!ETIQUETAS_TOTALES.has(clave) && imp < 0 && !/^total/.test(clave)) {
        deducciones.push({ texto: etiqueta, codigo: null, comprobante: null, fecha: null, importe: r2(-imp) })
      }
      continue
    }
    if (seccion === 'descuentos') {
      m = l.match(reDescuento)
      if (m) {
        const imp = parseImporte(m[3])
        if (imp == null) continue
        // «PAGO SEGUR 7 51799 PAGO SEGURO DE CARGA - 1 VIAJE»: código, unidad, comprobante, detalle.
        const medio = (m[2] ?? '').trim()
        const d = medio.match(/^(.*?)\s+(\d+)\s+(\d+)\s+(.+)$/)
        deducciones.push({
          texto: (d ? (d[4] ?? '') : medio).trim(),
          codigo: d ? (d[1] ?? '').trim() || null : null,
          comprobante: d ? (d[3] ?? null) : null,
          fecha: fechaIsoDe(m[1]),
          importe: r2(Math.abs(imp)),
        })
      }
    }
  }

  const comprobantes = [...brutos.entries()].map(([k, c]) => {
    const comision = comisiones.get(k) ?? 0
    return { ...c, comision, subtotal: r2(c.bruto + comision) }
  })
  for (const k of comisiones.keys()) if (!brutos.has(k)) avisos.push(`Comisión sin comprobante: ${k}`)
  const netoFinal = totalLiq ?? neto
  if (totalLiq != null && neto != null && r2(totalLiq - neto) !== 0) avisos.push(`Total liquidación ${totalLiq} ≠ saldo neto ${neto}`)

  if (!numero || comprobantes.length === 0 || netoFinal == null) return null
  if (cheques.length === 0 && netoFinal > 0) return null

  return {
    numero, fecha, emisor_cuit: cuit && cuit.length === 11 ? cuit : null, emisor_nombre: emisor,
    comprobantes, subtotal, deducciones, neto: netoFinal, cheques, avisos,
  }
}

// ── Qué comprobante cancela cada renglón ─────────────────────────────────────

export interface DestinoComprobante {
  tipo: 'externo' | 'factura'
  id: number
  comprobante: string
  fecha: string | null
  total: number
  saldo: number
}

export type AvisoComprobante = 'NO_ENCONTRADO' | 'YA_COBRADO' | 'SALDO_MENOR' | 'IMPORTE_DISTINTO'
export type AvisoCheque = 'YA_EN_OTRO_COBRO' | 'EN_CARTERA' | 'SIN_FECHA' | 'LIBRADOR_DESCONOCIDO'

const fmtNro = (pto: number, nro: number) => `${String(pto).padStart(5, '0')}-${String(nro).padStart(8, '0')}`

export interface FilaExterno { id: number; cbte_tipo: number; tipo: string | null; pto_vta: number; numero: number; fecha: string; total: number | string; saldo: number | string; comprobante: string | null }
export interface FilaFactura { id: number; cbte_tipo: number; pto_vta: number; numero: number; fecha_cbte: string; imp_total: number | string; cobro_saldo: number | string | null; numero_fmt: string | null; tipo_nombre: string | null }

/** Arma los destinos: primero los externos (CVLP), después las facturas del ERP. Pura. */
export function destinoDe(
  c: Pick<ComprobanteLiquidado, 'pto_vta' | 'numero' | 'subtotal'>,
  externos: readonly FilaExterno[],
  facturas: readonly FilaFactura[],
): { destino: DestinoComprobante | null; imputar: number; avisos: AvisoComprobante[] } {
  const ext = externos
    .filter((e) => e.pto_vta === c.pto_vta && Number(e.numero) === c.numero && e.tipo !== 'NC')
    .sort((a, b) => Number([60, 61].includes(b.cbte_tipo)) - Number([60, 61].includes(a.cbte_tipo)))[0]
  const fac = ext ? undefined : facturas.find((f) => f.pto_vta === c.pto_vta && Number(f.numero) === c.numero)
  let destino: DestinoComprobante | null = null
  if (ext) {
    destino = { tipo: 'externo', id: ext.id, comprobante: ext.comprobante ?? fmtNro(c.pto_vta, c.numero), fecha: ext.fecha, total: Number(ext.total), saldo: Number(ext.saldo) }
  } else if (fac) {
    destino = {
      tipo: 'factura', id: fac.id, comprobante: `${fac.tipo_nombre ?? 'Factura'} ${fac.numero_fmt ?? fmtNro(c.pto_vta, c.numero)}`,
      fecha: fac.fecha_cbte, total: Number(fac.imp_total), saldo: Number(fac.cobro_saldo ?? 0),
    }
  }
  const avisos: AvisoComprobante[] = []
  if (!destino) return { destino, imputar: 0, avisos: ['NO_ENCONTRADO'] }
  if (Math.abs(destino.total - c.subtotal) > 0.011) avisos.push('IMPORTE_DISTINTO')
  if (destino.saldo <= 0.001) avisos.push('YA_COBRADO')
  else if (destino.saldo + 0.001 < c.subtotal) avisos.push('SALDO_MENOR')
  return { destino, imputar: r2(Math.max(0, Math.min(destino.saldo, c.subtotal))), avisos }
}


// ── Controles ───────────────────────────────────────────────────────────────

export interface ControlesLiquidacion {
  suma_comprobantes: number
  suma_deducciones: number
  suma_cheques: number
  /** Σ comprobantes = subtotal (±0,01). */
  cierra_subtotal: boolean
  /** subtotal − deducciones = neto (±0,01). */
  cierra_neto: boolean
  /** Σ cheques = neto (±0,01). */
  cierra_cheques: boolean
  ok: boolean
}

const TOL = 0.011

export function controlesLiquidacion(l: Pick<LiquidacionLeida, 'comprobantes' | 'subtotal' | 'deducciones' | 'neto' | 'cheques'>): ControlesLiquidacion {
  const sc = r2(l.comprobantes.reduce((a, c) => a + c.subtotal, 0))
  const sd = r2(l.deducciones.reduce((a, d) => a + d.importe, 0))
  const sq = r2(l.cheques.reduce((a, c) => a + c.importe, 0))
  const subtotal = l.subtotal ?? sc
  const cierra_subtotal = Math.abs(sc - subtotal) <= TOL
  const cierra_neto = l.neto != null && Math.abs(r2(subtotal - sd) - l.neto) <= TOL
  const cierra_cheques = l.neto != null && Math.abs(sq - l.neto) <= TOL
  return {
    suma_comprobantes: sc, suma_deducciones: sd, suma_cheques: sq,
    cierra_subtotal, cierra_neto, cierra_cheques, ok: cierra_subtotal && cierra_neto && cierra_cheques,
  }
}

// ── Concepto de cada deducción ──────────────────────────────────────────────

export interface ConceptoGastoMin { id: number; nombre: string; alias: string[]; activo: boolean }

/**
 * El concepto del catálogo que corresponde a una deducción: por el nombre o
 * por un sinónimo, como palabras enteras dentro del texto (y del código de
 * Casilda). Gana el sinónimo más largo; empate entre conceptos → null (que
 * elija la persona). Sólo conceptos activos.
 */
export function conceptoDeDeduccion(
  d: Pick<DeduccionLiquidada, 'texto' | 'codigo'>,
  conceptos: readonly ConceptoGastoMin[],
): { concepto_id: number | null; por: string | null } {
  const hay = ` ${normTxt(`${d.texto} ${d.codigo ?? ''}`)} `
  let mejor: { id: number; largo: number; por: string } | null = null
  let empate = false
  for (const c of conceptos) {
    if (!c.activo) continue
    for (const a of [normTxt(c.nombre), ...c.alias.map((x) => normTxt(x))]) {
      if (!a || !hay.includes(` ${a} `)) continue
      if (!mejor || a.length > mejor.largo) { mejor = { id: c.id, largo: a.length, por: a }; empate = false }
      else if (a.length === mejor.largo && c.id !== mejor.id) empate = true
    }
  }
  if (!mejor || empate) return { concepto_id: null, por: null }
  return { concepto_id: mejor.id, por: mejor.por }
}

/** «CASILDA COMBUSTIBLES S.R.L.» → «Casilda» (para la observación del cobro). */
export function nombreCorto(razonSocial: string | null | undefined): string {
  const p = String(razonSocial ?? '').trim().split(/\s+/)[0] ?? ''
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''
}
