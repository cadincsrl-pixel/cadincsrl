/**
 * Lo que ARCA define y la lectura del comprobante necesita (20260924u).
 *
 * Funciones puras: el QR, los códigos de comprobante y de alícuota. Las
 * prueba vitest.
 *
 * ── El QR de las facturas electrónicas ──────────────────────────────────────
 * Desde 2021 todo comprobante electrónico lleva un QR con la URL
 *   https://www.afip.gob.ar/fe/qr/?p=<base64 de un JSON>
 * y el JSON trae {ver, fecha, cuit, ptoVta, tipoCmp, nroCmp, importe, moneda,
 * ctz, tipoDocRec, nroDocRec, tipoCodAut, codAut}. Es lo que el emisor le
 * informó a ARCA, así que para esos campos MANDA sobre lo que se lea del
 * papel. No trae ni el IVA ni las percepciones: eso sale de la lectura.
 *
 * En la calle aparecen QR mal armados: base64url, padding faltante, la URL
 * con `&p=` o doble codificada, JSON con comillas simples o un campo de más.
 * `parsearQrArca` es tolerante con todo eso y devuelve null si no encuentra
 * al menos CUIT, tipo, punto de venta, número e importe.
 */

/** CUIT de CADINC: el receptor que tiene que decir toda factura de compra. */
export { CUIT_EMPRESA as CUIT_CADINC } from '../../../lib/empresa.js'

export interface QrArca {
  ver:        number | null
  fecha:      string | null      // AAAA-MM-DD
  cuit:       string             // emisor, 11 dígitos
  ptoVta:     number
  tipoCmp:    number
  nroCmp:     number
  importe:    number
  moneda:     string | null      // 'PES', 'DOL'…
  ctz:        number | null
  tipoDocRec: number | null      // 80 = CUIT
  nroDocRec:  string | null
  tipoCodAut: string | null      // 'E' = CAE, 'A' = CAEA
  codAut:     string | null      // 14 dígitos
}

function b64decode(s: string): string | null {
  let t = s.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4 !== 0) t += '='
  try {
    return Buffer.from(t, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/** Busca `"clave": valor` en un JSON roto (comillas simples, coma de más…). */
function campoSuelto(txt: string, clave: string): string | null {
  const r = new RegExp(`["']?${clave}["']?\\s*:\\s*["']?([^"',}]*)`, 'i').exec(txt)
  const v = r?.[1]?.trim()
  return v ? v : null
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function digitos(v: unknown): string | null {
  if (v == null) return null
  // Un número grande en JSON (un CAE de 14 dígitos) llega bien como number:
  // Number.MAX_SAFE_INTEGER tiene 16 dígitos.
  const d = (typeof v === 'number' ? v.toFixed(0) : String(v)).replace(/\D+/g, '')
  return d ? d : null
}

/** El texto crudo del QR → los datos, o null si no es un QR de factura de ARCA. */
export function parsearQrArca(texto: string | null | undefined): QrArca | null {
  if (!texto) return null
  const t = texto.trim()
  let p: string | null = null
  const m = /[?&]p=([^&#\s]+)/i.exec(t)
  if (m?.[1]) {
    try { p = decodeURIComponent(m[1]) } catch { p = m[1] }
    // Hay emisores que codifican dos veces.
    if (/%[0-9a-f]{2}/i.test(p)) { try { p = decodeURIComponent(p) } catch { /* queda como está */ } }
  } else if (/^[A-Za-z0-9+/=_-]{40,}$/.test(t)) {
    p = t            // a veces el QR trae sólo el base64
  }
  if (!p) return null
  const json = b64decode(p)
  if (!json || !json.includes('{')) return null

  let o: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1))
    if (v && typeof v === 'object') o = v as Record<string, unknown>
  } catch {
    o = null
  }
  const leer = (k: string): unknown => (o ? o[k] : campoSuelto(json, k))

  const cuit = digitos(leer('cuit'))
  const ptoVta = num(leer('ptoVta'))
  const tipoCmp = num(leer('tipoCmp'))
  const nroCmp = num(leer('nroCmp'))
  // "000000013838240": ancho fijo con los centavos implícitos (visto en un QR
  // real de ABC S.A.). Con ceros a la izquierda y sin punto, son centavos.
  const importeRaw = leer('importe')
  const importeCent = typeof importeRaw === 'string' && /^0\d{3,}$/.test(importeRaw.trim())
  const importe0 = num(importeRaw)
  const importe = importe0 == null ? null : importeCent ? importe0 / 100 : importe0
  if (!cuit || cuit.length !== 11 || ptoVta == null || tipoCmp == null || nroCmp == null || importe == null) return null

  const fechaRaw = leer('fecha')
  const fecha = typeof fechaRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fechaRaw) ? fechaRaw.slice(0, 10) : null
  const codAut = digitos(leer('codAut'))
  const monedaRaw = leer('moneda')
  const tipoCodRaw = leer('tipoCodAut')
  return {
    ver: num(leer('ver')),
    fecha,
    cuit,
    ptoVta: Math.trunc(ptoVta),
    tipoCmp: Math.trunc(tipoCmp),
    nroCmp: Math.trunc(nroCmp),
    importe: Math.round(importe * 100) / 100,
    moneda: typeof monedaRaw === 'string' && monedaRaw.trim() ? monedaRaw.trim().toUpperCase() : null,
    ctz: num(leer('ctz')),
    tipoDocRec: num(leer('tipoDocRec')),
    nroDocRec: digitos(leer('nroDocRec')),
    tipoCodAut: typeof tipoCodRaw === 'string' && tipoCodRaw.trim() ? tipoCodRaw.trim().toUpperCase() : null,
    codAut,
  }
}

// ── Tipos de comprobante ────────────────────────────────────────────────────

export type TipoComprobante = 'A' | 'B' | 'C' | 'recibo' | 'ticket' | 'otro'

/** Los códigos que acepta `pagos_facturas.cbte_tipo_arca` (CHECK de 20260924u). */
export const CBTE_TIPOS_ARCA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 49, 51, 52, 53, 54, 81, 82, 83,
  201, 202, 203, 206, 207, 208, 211, 212, 213] as const

/**
 * Notas de crédito (A, B, C, M y las MiPyME 203/208/213). Desde el 2026-09-25
 * una NC de proveedor es un COMPROBANTE de `pagos_facturas` con
 * `clase = 'nota_credito'` (CHECK `pagos_facturas_nc_chk`: sólo estos códigos).
 */
export const CBTE_TIPOS_NC = [3, 8, 13, 53, 203, 208, 213] as const
const NOTAS_CREDITO = new Set<number>(CBTE_TIPOS_NC)
export const esCbteNotaCredito = (codigo: number | null | undefined) => codigo != null && NOTAS_CREDITO.has(codigo)
/** Una NC sin código de ARCA: la base lo deduce por letra (A→3, B→8, C→13). */
export const CBTE_NC_POR_LETRA: Readonly<Record<string, number>> = { A: 3, B: 8, C: 13 }
const RECIBOS = new Set([4, 9, 15, 54])

/**
 * Código ARCA → tipo del módulo. La M (51-54) va como A: discrimina IVA igual.
 * Las notas de crédito se marcan aparte (`esNotaCredito`): se cargan como
 * comprobante con `clase = 'nota_credito'`, con su desglose y a qué facturas
 * acreditan (20260925a).
 */
export function tipoDesdeArca(codigo: number | null | undefined): { tipo: TipoComprobante; esNotaCredito: boolean } | null {
  if (codigo == null) return null
  const esNotaCredito = NOTAS_CREDITO.has(codigo)
  if (RECIBOS.has(codigo)) return { tipo: 'recibo', esNotaCredito }
  if ([1, 2, 3, 5, 51, 52, 53, 81, 201, 202, 203].includes(codigo)) return { tipo: 'A', esNotaCredito }
  if ([6, 7, 8, 10, 82, 206, 207, 208].includes(codigo)) return { tipo: 'B', esNotaCredito }
  if ([11, 12, 13, 83, 211, 212, 213].includes(codigo)) return { tipo: 'C', esNotaCredito }
  if (codigo === 49) return { tipo: 'otro', esNotaCredito }
  return null
}

/** Letra + clase → código ARCA (lo que devuelve la lectura cuando no hay QR). */
export function arcaDesdeLetra(letra: string | null | undefined, clase: string | null | undefined): number | null {
  const L = (letra ?? '').toUpperCase()
  const base: Record<string, number> = { A: 1, B: 6, C: 11, M: 51 }
  const b = base[L]
  if (b == null) return null
  switch (clase) {
    case 'nota_debito':  return b + 1
    case 'nota_credito': return b + 2
    case 'recibo':       return L === 'C' ? 15 : b + 3
    case 'factura':
    case null:
    case undefined:      return b
    default:             return b
  }
}

export const NOMBRE_CBTE: Record<number, string> = {
  1: 'Factura A', 2: 'Nota de débito A', 3: 'Nota de crédito A', 4: 'Recibo A',
  6: 'Factura B', 7: 'Nota de débito B', 8: 'Nota de crédito B', 9: 'Recibo B',
  11: 'Factura C', 12: 'Nota de débito C', 13: 'Nota de crédito C', 15: 'Recibo C',
  51: 'Factura M', 52: 'Nota de débito M', 53: 'Nota de crédito M', 54: 'Recibo M',
  81: 'Tique factura A', 82: 'Tique factura B', 83: 'Tique',
  201: 'Factura de crédito electrónica A', 202: 'Nota de débito electrónica MiPyME A', 203: 'Nota de crédito electrónica MiPyME A',
  206: 'Factura de crédito electrónica B', 207: 'Nota de débito electrónica MiPyME B', 208: 'Nota de crédito electrónica MiPyME B',
  211: 'Factura de crédito electrónica C', 212: 'Nota de débito electrónica MiPyME C', 213: 'Nota de crédito electrónica MiPyME C',
}

// ── Alícuotas de IVA ────────────────────────────────────────────────────────

/** Código ARCA de alícuota → porcentaje. */
export const ALICUOTAS: Record<number, number> = { 3: 0, 4: 10.5, 5: 21, 6: 27, 8: 5, 9: 2.5 }
export const ALICUOTA_IDS = [3, 4, 5, 6, 8, 9] as const

/** 21 → 5, 10.5 → 4… null si no es una alícuota de IVA vigente. */
export function alicuotaIdDe(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct)) return null
  for (const [id, p] of Object.entries(ALICUOTAS)) {
    if (Math.abs(p - pct) < 0.01) return Number(id)
  }
  return null
}

export const TIPOS_TRIBUTO = ['percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias',
  'percepcion_municipal', 'impuestos_internos', 'otro'] as const
export type TipoTributo = (typeof TIPOS_TRIBUTO)[number]
export const esPercepcion = (t: string) => t.startsWith('percepcion_')
