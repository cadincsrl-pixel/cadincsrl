/**
 * Parser de «Mis Comprobantes — Recibidos» de ARCA (20260927b/c). PURO: sin
 * base ni red, lo prueba vitest. Arma las filas de `pagos_importar_recibidos`
 * (`FilaRecibidaDto`); la base decide todo lo de negocio (tipo soportado,
 * duplicados, proveedor, desglose) y marca los errores por fila.
 *
 * Hay DOS layouts y el parser se guía por PATRONES de encabezado, no por
 * posición ni por nombres fijos (ARCA no publicó el nuevo y ya lo cambió más
 * de una vez):
 *
 *   Clásico: Fecha | Tipo («1 - Factura A», o solo el código en el CSV) |
 *     Punto de Venta | Número Desde | Número Hasta | Cód. Autorización |
 *     Tipo Doc. Emisor | Nro. Doc. Emisor | Denominación Emisor | Tipo Cambio |
 *     Moneda | Imp. Neto Gravado | Imp. Neto No Gravado | Imp. Op. Exentas |
 *     Otros Tributos | IVA | Imp. Total
 *
 *   Nuevo (ARCA, sep-2025): el punto de venta puede venir pegado al número
 *     («00003-00001234») y el neto y el IVA vienen POR ALÍCUOTA
 *     («Neto Grav. IVA 21%» / «IVA 21%», también 0 / 2,5 / 5 / 10,5 / 27 %),
 *     más «Total Neto Gravado» y «Total IVA».
 *
 * Lo que tolera: CSV con `;` o `,` (y tab), BOM, línea `sep=;` de Excel,
 * comillas, fila de título antes del encabezado (se busca en las primeras 10
 * filas), encabezados con o sin tildes / puntos / «($)», números «1.234,56»,
 * «1234.56», «1,234.56» o del Excel, fechas dd/mm/aaaa, ISO o serial de Excel,
 * y el tipo como «1 - Factura A», «001», 1 o solo «Factura A».
 *
 * El FE hace lo mismo en `modules/pagos/utils/arcaRecibidos.ts` sobre la
 * hoja de xlsx; el backend acepta además el CSV / la matriz crudos y usa esto.
 */
import type { FilaRecibidaDto } from './pagos.schema.js'

export type Celda = string | number | boolean | Date | null | undefined

export interface FilaRecibidaParseada extends FilaRecibidaDto {
  /** Fila del archivo, 1-based como la ve el usuario. */
  fila_archivo: number
  /** El tipo tal cual vino («1 - Factura A»). */
  tipo_texto: string
}

export interface ErrorParseoRecibidos {
  fila_archivo: number
  motivo: string
}

export interface ResultadoRecibidos {
  formato: 'clasico' | 'por_alicuota' | null
  /** Fila del encabezado (1-based), 0 si no se encontró. */
  encabezado_fila: number
  filas: FilaRecibidaParseada[]
  errores: ErrorParseoRecibidos[]
  /** Error que invalida el archivo entero (no es el de Recibidos, no tiene encabezado). */
  error_archivo: string | null
}

// ── Normalización de encabezados ────────────────────────────────────────────

/**
 * «Cód. Autorización» → «cod autorizacion»; «IVA 10.5%» → «iva 10.5%».
 * Sin tildes, minúsculas, sin «($)», los puntos de abreviatura pasan a
 * espacio (los decimales entre dígitos se conservan) y espacios colapsados.
 */
export function normEncabezado(v: unknown): string {
  return String(v ?? '')
    .replace(/^﻿/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(\s*\$\s*\)/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[:_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

type Campo =
  | 'fecha' | 'tipo' | 'pto_vta' | 'numero' | 'numero_hasta' | 'cod_autorizacion'
  | 'emisor_doc_tipo' | 'emisor_doc_nro' | 'emisor_razon_social' | 'tipo_cambio' | 'moneda'
  | 'neto_gravado' | 'no_gravado' | 'exento' | 'otros_tributos' | 'iva' | 'total'

/** Encabezados aceptados por campo (ya normalizados), en orden de prioridad. */
export const ENCABEZADOS: Readonly<Record<Campo, readonly string[]>> = {
  fecha:               ['fecha de emision', 'fecha emision', 'fecha', 'fecha cbte', 'fecha comprobante'],
  tipo:                ['tipo', 'tipo de comprobante', 'tipo comprobante', 'tipo cbte'],
  pto_vta:             ['punto de venta', 'pto vta', 'punto venta', 'pv'],
  numero:              ['numero desde', 'nro desde', 'numero', 'numero de comprobante', 'nro comprobante', 'numero comprobante'],
  numero_hasta:        ['numero hasta', 'nro hasta'],
  cod_autorizacion:    ['cod autorizacion', 'codigo de autorizacion', 'codigo autorizacion', 'cae'],
  emisor_doc_tipo:     ['tipo doc emisor', 'tipo documento emisor', 'tipo doc vendedor'],
  emisor_doc_nro:      ['nro doc emisor', 'numero doc emisor', 'nro documento emisor', 'nro doc vendedor', 'cuit emisor'],
  emisor_razon_social: ['denominacion emisor', 'razon social emisor', 'denominacion vendedor'],
  tipo_cambio:         ['tipo cambio', 'tipo de cambio'],
  moneda:              ['moneda'],
  neto_gravado:        ['imp neto gravado', 'imp neto gravado total', 'total neto gravado', 'neto gravado', 'neto gravado total'],
  no_gravado:          ['imp neto no gravado', 'neto no gravado', 'no gravado', 'imp no gravado'],
  exento:              ['imp op exentas', 'op exentas', 'exento', 'exentas', 'imp exento'],
  otros_tributos:      ['otros tributos', 'o otros tributos', 'imp otros tributos'],
  iva:                 ['iva', 'total iva', 'imp iva'],
  total:               ['imp total', 'total', 'importe total'],
}

const OBLIGATORIOS: Campo[] = ['fecha', 'tipo', 'numero', 'total']

/** Tasa (%) → código de alícuota de ARCA. */
const ALICUOTA_POR_TASA: ReadonlyArray<[number, number]> = [[0, 3], [2.5, 9], [5, 8], [10.5, 4], [21, 5], [27, 6]]
export function alicuotaIdDeTasa(tasa: number): number | null {
  return ALICUOTA_POR_TASA.find(([t]) => Math.abs(t - tasa) < 0.001)?.[1] ?? null
}

const RE_NETO_ALIC = /^(imp\s*)?neto\s*grav(ado)?\s*(iva\s*)?(\d+(?:[.,]\d+)?)\s*%$/
const RE_IVA_ALIC = /^(imp\s*)?iva\s*(\d+(?:[.,]\d+)?)\s*%$/

interface Mapa {
  campos: Partial<Record<Campo, number>>
  /** alicuota_id → columnas de neto e IVA. */
  alicuotas: Map<number, { neto?: number; iva?: number }>
}

function mapearEncabezado(fila: readonly unknown[]): Mapa | null {
  const norm = fila.map(normEncabezado)
  const campos: Partial<Record<Campo, number>> = {}
  for (const campo of Object.keys(ENCABEZADOS) as Campo[]) {
    for (const alias of ENCABEZADOS[campo]) {
      const i = norm.indexOf(alias)
      if (i >= 0) { campos[campo] = i; break }
    }
  }
  if (!OBLIGATORIOS.every((c) => campos[c] !== undefined)) return null
  const alicuotas = new Map<number, { neto?: number; iva?: number }>()
  norm.forEach((h, i) => {
    const mn = h.match(RE_NETO_ALIC)
    const mi = mn ? null : h.match(RE_IVA_ALIC)
    const tasaTxt = mn?.[4] ?? mi?.[2]
    if (tasaTxt === undefined) return
    const id = alicuotaIdDeTasa(Number(tasaTxt.replace(',', '.')))
    if (id === null) return
    const acc = alicuotas.get(id) ?? {}
    if (mn && acc.neto === undefined) acc.neto = i
    if (mi && acc.iva === undefined) acc.iva = i
    alicuotas.set(id, acc)
  })
  return { campos, alicuotas }
}

/** ¿Es el archivo de EMITIDOS? (encabezado con datos del comprador). */
function esDeEmitidos(fila: readonly unknown[]): boolean {
  return fila.map(normEncabezado).some((h) => ['denominacion comprador', 'nro doc comprador', 'tipo doc comprador', 'denominacion receptor'].includes(h))
}

// ── Celdas ──────────────────────────────────────────────────────────────────

export type EstiloDecimal = 'coma' | 'punto' | null

/**
 * Número de una celda. Número tal cual; texto en cualquiera de las formas:
 * «1.234,56», «1234,56», «1,234.56», «1234.56», «$ -1.234», «(1.234,56)».
 * «1.234» (un solo punto y 3 dígitos) es ambiguo: miles salvo que el archivo
 * use punto decimal (`estilo='punto'`).
 */
export function numeroDeCelda(v: Celda, estilo: EstiloDecimal = null): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || v instanceof Date) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v).replace(/[\s $]/g, '')
  if (!s || s === '-') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) }
  else if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1) }
  if (!/^[\d.,]+$/.test(s)) return null
  const comas = (s.match(/,/g) ?? []).length
  const puntos = (s.match(/\./g) ?? []).length
  if (comas && puntos) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (comas) {
    s = comas > 1 ? s.replace(/,/g, '') : s.replace(',', '.')
  } else if (puntos > 1) {
    s = s.replace(/\./g, '')
  } else if (puntos === 1 && /^\d{1,3}\.\d{3}$/.test(s) && estilo !== 'punto') {
    s = s.replace('.', '')
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

/** Qué separador decimal usa el archivo, mirando los importes con 1 o 2 decimales. */
export function estiloDecimalDe(celdas: Celda[]): EstiloDecimal {
  let coma = 0, punto = 0
  for (const v of celdas) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (/,\d{1,2}$/.test(s)) coma++
    else if (/\.\d{1,2}$/.test(s)) punto++
  }
  if (coma === 0 && punto === 0) return null
  return coma >= punto ? 'coma' : 'punto'
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function fechaValida(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/** Fecha → YYYY-MM-DD: «dd/mm/aaaa» (o con guiones / 2 dígitos de año), ISO, Date o serial de Excel. */
export function fechaDeCelda(v: Celda): string | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`
  }
  if (typeof v === 'number') {
    // Serial de Excel (días desde 1899-12-30): 20000 ≈ 1954, 80000 ≈ 2119.
    if (!(v > 20000 && v < 80000)) return null
    const d = new Date(Math.round((Math.floor(v) - 25569) * 86400 * 1000))
    return d.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:\s.*)?$/)
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return fechaValida(y, Number(m[2]), Number(m[1]))
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/)
  if (m) return fechaValida(Number(m[1]), Number(m[2]), Number(m[3]))
  if (/^\d{5}(\.\d+)?$/.test(s)) return fechaDeCelda(Number(s))
  return null
}

/**
 * «Factura A» → 1, «Nota de Crédito Electrónica MiPyMEs (FCE) B» → 208.
 * Lo que no reconoce → null (la fila sale con error de tipo ilegible).
 */
export function codigoDeNombreTipo(nombre: string): number | null {
  const n = normEncabezado(nombre)
  const letra = n.match(/\b([abcm])$/)?.[1]
  if (/bienes usados/.test(n)) return 49
  if (/liquido producto|cuenta de venta/.test(n)) return letra === 'a' ? 60 : letra === 'b' ? 61 : null
  if (n === 'tique' || n === 'ticket') return 83
  if (!letra) return null
  const fce = /mipyme|\bfce\b|factura de credito electronica|credito electronica/.test(n)
  if (/^tique factura|^ticket factura/.test(n)) return letra === 'a' ? 81 : letra === 'b' ? 82 : null
  let clase: 'fc' | 'nd' | 'nc' | 'recibo' | 'contado' | null = null
  if (/^nota de credito/.test(n)) clase = 'nc'
  else if (/^nota de debito/.test(n)) clase = 'nd'
  else if (/^factura/.test(n)) clase = 'fc'
  else if (/^recibo/.test(n)) clase = 'recibo'
  else if (/^nota de venta al contado/.test(n)) clase = 'contado'
  if (!clase) return null
  if (fce) {
    const base: Record<string, number> = { a: 201, b: 206, c: 211 }
    const b = base[letra]
    if (b === undefined || clase === 'recibo' || clase === 'contado') return null
    return b + (clase === 'nd' ? 1 : clase === 'nc' ? 2 : 0)
  }
  const base: Record<string, number> = { a: 1, b: 6, c: 11, m: 51 }
  const b = base[letra]!
  if (clase === 'recibo') return ({ a: 4, b: 9, c: 15, m: 54 } as Record<string, number>)[letra] ?? null
  if (clase === 'contado') return ({ a: 5, b: 10 } as Record<string, number>)[letra] ?? null
  return b + (clase === 'nd' ? 1 : clase === 'nc' ? 2 : 0)
}

/** «1 - Factura A» → 1; «011» → 11; 201 → 201; «Factura A» → 1. null si no se entiende. */
export function codigoDeTipo(v: Celda): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = s.match(/^\s*(\d{1,3})\b/)
  if (m) return Number(m[1]) || null
  return codigoDeNombreTipo(s)
}

/** «CUIT» → 80, «CUIL» → 86, «DNI» → 96, «80» → 80; otro texto viaja tal cual (la base lo rechaza por fila). */
export function docTipoDeCelda(v: Celda): number | string {
  if (typeof v === 'number') return Math.trunc(v)
  const s = String(v ?? '').trim().toUpperCase()
  if (/^\d+$/.test(s)) return Number(s)
  const m = s.match(/^(\d+)\s*-/)
  if (m) return Number(m[1])
  if (s.startsWith('CUIT')) return 80
  if (s.startsWith('CUIL')) return 86
  if (s.startsWith('DNI')) return 96
  return s.slice(0, 20)
}

/** Dígitos del documento. Un CUIT como número del Excel entra entero en un double. */
export function docNroDeCelda(v: Celda): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(v)) : ''
  return String(v ?? '').replace(/\D/g, '').slice(0, 20)
}

/** «$» / «PES» / «ARS» → PES; dólares → DOL (códigos de ARCA). */
export function monedaDeCelda(v: Celda): string {
  const s = normEncabezado(v).toUpperCase().replace(/\s/g, '')
  if (!s || s === '$' || s === 'PES' || s === 'ARS' || s === 'PESOS') return 'PES'
  if (['USD', 'U$S', 'US$', 'DOL', 'DOLAR', 'DOLARES'].includes(s)) return 'DOL'
  return s.slice(0, 5)
}

const redondear = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const vacia = (v: Celda) => v === null || v === undefined || String(v).trim() === ''

// ── CSV → matriz ────────────────────────────────────────────────────────────

/** Cuántas veces aparece `sep` fuera de comillas en la línea. */
function contar(linea: string, sep: string): number {
  let n = 0, comillas = false
  for (const ch of linea) {
    if (ch === '"') comillas = !comillas
    else if (!comillas && ch === sep) n++
  }
  return n
}

/**
 * CSV → filas de celdas (texto). BOM, CRLF, comillas con `""`, la línea
 * `sep=;` de Excel y el separador (`;`, `,` o tab) que más aparece fuera de
 * comillas en las primeras 10 líneas (la primera puede ser un título).
 */
export function csvAMatriz(csv: string): string[][] {
  let texto = csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  let sep: string | null = null
  const hint = texto.match(/^sep=(.)\n/i)
  if (hint) { sep = hint[1]!; texto = texto.slice(hint[0].length) }
  if (!sep) {
    const lineas = texto.split('\n').filter((l) => l.trim() !== '').slice(0, 10)
    sep = [';', ',', '\t']
      .map((s) => ({ s, n: lineas.reduce((acc, l) => acc + contar(l, s), 0) }))
      .sort((a, b) => b.n - a.n)[0]!.s
  }
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ''
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++ }
      else if (ch === '"') comillas = false
      else campo += ch
    } else if (ch === '"') comillas = true
    else if (ch === sep) { fila.push(campo); campo = '' }
    else if (ch === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = '' }
    else campo += ch
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila) }
  return filas
}

// ── La hoja ─────────────────────────────────────────────────────────────────

/**
 * Las filas de una hoja (array de arrays, como `sheet_to_json({ header: 1 })`
 * o `csvAMatriz`). El encabezado se busca en las primeras 10 filas.
 */
export function leerFilasRecibidos(matriz: readonly (readonly Celda[])[]): ResultadoRecibidos {
  const res: ResultadoRecibidos = { formato: null, encabezado_fila: 0, filas: [], errores: [], error_archivo: null }
  let mapa: Mapa | null = null
  let iEnc = -1
  for (let i = 0; i < Math.min(matriz.length, 10); i++) {
    const fila = matriz[i] ?? []
    if (esDeEmitidos(fila)) {
      res.error_archivo = 'Es el archivo de EMITIDOS, no de RECIBIDOS: bajá «Mis Comprobantes — Recibidos» de ARCA.'
      return res
    }
    mapa = mapearEncabezado(fila)
    if (mapa) { iEnc = i; break }
  }
  if (!mapa) {
    res.error_archivo = 'No encontré los encabezados de «Mis Comprobantes Recibidos» (Fecha, Tipo, Número, Total). ¿Es el archivo de ARCA?'
    return res
  }
  res.encabezado_fila = iEnc + 1
  const porAlicuota = mapa.alicuotas.size > 0
  res.formato = porAlicuota ? 'por_alicuota' : 'clasico'
  const cols = mapa.campos
  const col = (fila: readonly Celda[], c: Campo): Celda => (cols[c] === undefined ? undefined : fila[cols[c]!])

  // Separador decimal del archivo (solo importa en textos ambiguos como «1.234»).
  const colsImporte = [...(['neto_gravado', 'no_gravado', 'exento', 'otros_tributos', 'iva', 'total'] as Campo[]).map((c) => cols[c]),
    ...[...mapa.alicuotas.values()].flatMap((a) => [a.neto, a.iva])].filter((i): i is number => i !== undefined)
  const estilo = estiloDecimalDe(matriz.slice(iEnc + 1).flatMap((f) => colsImporte.map((i) => f[i])))
  const num = (v: Celda) => numeroDeCelda(v, estilo)
  const importe = (v: Celda) => redondear(num(v) ?? 0)

  for (let i = iEnc + 1; i < matriz.length; i++) {
    const fila = matriz[i] ?? []
    if (fila.every(vacia)) continue
    // Pie de totales (sin fecha ni número): no es un comprobante.
    if (vacia(col(fila, 'fecha')) && vacia(col(fila, 'numero'))) continue
    const filaArchivo = i + 1
    const err = (motivo: string) => res.errores.push({ fila_archivo: filaArchivo, motivo })

    const tipoTexto = String(col(fila, 'tipo') ?? '').trim()
    const cbte = codigoDeTipo(col(fila, 'tipo'))
    if (cbte === null || cbte > 999) { err(`Tipo de comprobante ilegible: «${tipoTexto}»`); continue }

    // Punto de venta y número: separados, o pegados en la misma columna («00003-00001234»).
    let pv = num(col(fila, 'pto_vta'))
    let numero: number | null
    const numCelda = col(fila, 'numero')
    const pegado = typeof numCelda === 'string' ? numCelda.trim().match(/^(\d{1,5})\s*-\s*(\d{1,8})$/) : null
    if (pegado && (pv === null || vacia(col(fila, 'pto_vta')))) {
      pv = Number(pegado[1]); numero = Number(pegado[2])
    } else if (pegado) {
      numero = Number(pegado[2])
    } else {
      numero = typeof numCelda === 'string' && /^\d+$/.test(numCelda.trim()) ? Number(numCelda.trim()) : num(numCelda)
    }
    if (pv === null) { err('Falta el punto de venta'); continue }
    if (!Number.isInteger(pv) || pv < 0 || pv > 99999) { err(`Punto de venta inválido: «${String(col(fila, 'pto_vta') ?? pv)}»`); continue }
    if (numero === null || !Number.isInteger(numero) || numero < 1 || numero > 99999999) {
      err(`Número de comprobante inválido: «${String(numCelda ?? '')}»`); continue
    }
    const hastaCrudo = col(fila, 'numero_hasta')
    const hastaPegado = typeof hastaCrudo === 'string' ? hastaCrudo.trim().match(/^\d{1,5}\s*-\s*(\d{1,8})$/) : null
    const hasta = hastaPegado ? Number(hastaPegado[1]) : num(hastaCrudo)

    const fecha = fechaDeCelda(col(fila, 'fecha'))
    if (!fecha) { err(`Fecha ilegible: «${String(col(fila, 'fecha') ?? '')}»`); continue }
    const total = num(col(fila, 'total'))
    if (total === null) { err('Falta el total'); continue }

    const cae = col(fila, 'cod_autorizacion')
    const caeTxt = typeof cae === 'number' ? (Number.isFinite(cae) ? String(Math.trunc(cae)) : '') : String(cae ?? '').replace(/\D/g, '')
    const tc = num(col(fila, 'tipo_cambio'))

    let alicuotas: FilaRecibidaDto['alicuotas'] = null
    let netoGravado = importe(col(fila, 'neto_gravado'))
    let iva = importe(col(fila, 'iva'))
    if (porAlicuota) {
      alicuotas = []
      for (const [id, c] of [...mapa.alicuotas.entries()].sort((a, b) => a[0] - b[0])) {
        const base = c.neto === undefined ? 0 : importe(fila[c.neto])
        const imp = c.iva === undefined ? 0 : importe(fila[c.iva])
        if (base !== 0 || imp !== 0) alicuotas.push({ alicuota_id: id, base_imp: Math.abs(base), importe: Math.abs(imp) })
      }
      // Sin columna de totales, el total sale de las alícuotas.
      if (cols.neto_gravado === undefined) netoGravado = redondear(alicuotas.reduce((s, a) => s + a.base_imp, 0))
      if (cols.iva === undefined) iva = redondear(alicuotas.reduce((s, a) => s + a.importe, 0))
    }

    res.filas.push({
      fila_archivo: filaArchivo,
      tipo_texto: tipoTexto,
      fecha,
      cbte_tipo: cbte,
      pto_vta: pv,
      numero,
      numero_hasta: hasta !== null && Number.isInteger(hasta) ? hasta : null,
      cod_autorizacion: caeTxt ? caeTxt.slice(0, 20) : null,
      emisor_doc_tipo: docTipoDeCelda(col(fila, 'emisor_doc_tipo')),
      emisor_doc_nro: docNroDeCelda(col(fila, 'emisor_doc_nro')),
      emisor_razon_social: String(col(fila, 'emisor_razon_social') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      moneda: monedaDeCelda(col(fila, 'moneda')),
      tipo_cambio: tc !== null && tc > 0 ? tc : 1,
      // Algunas exportaciones traen las NC en negativo: el signo lo pone el tipo.
      neto_gravado: Math.abs(netoGravado),
      no_gravado: Math.abs(importe(col(fila, 'no_gravado'))),
      exento: Math.abs(importe(col(fila, 'exento'))),
      otros_tributos: Math.abs(importe(col(fila, 'otros_tributos'))),
      iva: Math.abs(iva),
      total: Math.abs(redondear(total)),
      alicuotas,
    })
  }
  return res
}

/** CSV crudo → filas. */
export function parsearRecibidosCsv(csv: string): ResultadoRecibidos {
  return leerFilasRecibidos(csvAMatriz(csv))
}

/** Lo que viaja a la RPC: la fila sin los datos de pantalla. */
export function filaParaRpc(f: FilaRecibidaParseada | FilaRecibidaDto): FilaRecibidaDto {
  const { fila_archivo: _f, tipo_texto: _t, ...resto } = f as FilaRecibidaParseada
  return resto
}
