/**
 * Libro IVA Digital — VENTAS (RG 4597): armado de los dos archivos de
 * importación de ancho fijo. Funciones PURAS (sin base, sin red): el service
 * (`lid-ventas.service.ts`) lee los comprobantes y llama acá.
 *
 * FUENTES (bajadas y verificadas el 2026-09-24):
 *   - Diseño de registro: ARCA, «ANEXO I – DISEÑOS DE REGISTROS»
 *     https://www.afip.gob.ar/iva/documentos/libro-iva-digital-diseno-registros.pdf
 *       LIBRO_IVA_DIGITAL_VENTAS_CBTE ....... longitud 266 (22 campos)
 *       LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS .. longitud 62  (6 campos)
 *   - Especificaciones (Revisión 30/07/2025):
 *     https://www.afip.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf
 *       · importes POSITIVOS, en centavos, 13 enteros + 2 decimales, sin punto;
 *         numéricos con ceros a la izquierda, alfanuméricos con blancos a la derecha;
 *       · tipo de cambio: 4 enteros + 6 decimales, obligatorio aun con PES;
 *       · campo 19 (cantidad de alícuotas): '1' también si hay exento + gravado a tasa única;
 *       · campo 20 (código de operación): solo si la alícuota es 0 (E exento, N no gravado,
 *         X exportación, …); si no, blanco o cero;
 *       · alícuotas: neto gravado puede ser 0 con alícuota 0003 (op. no gravada en su totalidad);
 *         «aún tratándose de consumidores finales, exentos y monotributistas igualmente
 *         deberá consignarse el IVA contenido» (campo 6 de VENTAS_ALICUOTAS);
 *       · mismo orden de comprobantes en los dos archivos;
 *       · archivos ANSI: ISO 8859-1 o Windows-1252.
 *   - Tablas del sistema (alícuotas 3/4/5/6/8/9, código de doc. 80/86/96/99, moneda PES/DOL,
 *     tipo 060 «Cuentas de venta y líquido producto A»):
 *     https://www.afip.gob.ar/libro-iva-digital/documentos/Libro-IVA-Digital-Tablas-del-Sistema.pdf
 *   - CVLP: «ANEXO VII — Nota de venta y líquido producto», apartado B «VENDEDOR»:
 *     el comitente la registra en el Libro VENTAS con código 060, CUIT del EMISOR
 *     (el comisionista) como comprador, SUBTOTAL → neto gravado, IVA → impuesto
 *     liquidado, TOTAL → total de la operación (modalidad general).
 *     https://www.afip.gob.ar/libro-iva-digital/documentos/MODALIDADES-ESPECIALES-DE-REGISTRACION-ANEXO-VII.pdf
 *
 * Decisión sobre los comprobantes B: las «consideraciones particulares» de la
 * especificación dicen «para los comprobantes B o C, cantidad de alícuotas = 0»,
 * pero ARCA aclaró que eso es para COMPRAS (el B no da crédito fiscal). En
 * VENTAS el débito fiscal del B existe y el campo 6 de VENTAS_ALICUOTAS pide
 * expresamente el IVA contenido: el B se informa con su alícuota, igual que el A.
 */

// ── Tipos ───────────────────────────────────────────────────────────────────

/** Códigos de alícuota de la tabla del LID (los mismos Id de WSFE). */
export const ALICUOTAS_LID: Readonly<Record<number, { tasa: number; label: string }>> = {
  3: { tasa: 0,     label: '0 %' },
  4: { tasa: 0.105, label: '10,5 %' },
  5: { tasa: 0.21,  label: '21 %' },
  6: { tasa: 0.27,  label: '27 %' },
  8: { tasa: 0.05,  label: '5 %' },
  9: { tasa: 0.025, label: '2,5 %' },
}

export const NOMBRE_TIPO_LID: Readonly<Record<number, string>> = {
  1: 'Factura A', 2: 'Nota de débito A', 3: 'Nota de crédito A',
  6: 'Factura B', 7: 'Nota de débito B', 8: 'Nota de crédito B',
  60: 'Cta. de venta y líquido producto A',
  201: 'Factura de crédito electrónica MiPyME A', 202: 'Nota de débito electrónica MiPyME A',
  203: 'Nota de crédito electrónica MiPyME A',
}
/** Notas de crédito: en el archivo van POSITIVAS (el tipo ya dice que restan); en el resumen, con signo. */
export const TIPOS_NC_LID = new Set([3, 8, 13, 203, 208, 213])
export const TIPO_CVLP = 60

export type Severidad = 'error' | 'advertencia' | 'info'
export interface Validacion { comprobante: string; severidad: Severidad; mensaje: string }

export interface AlicuotaLid { codigo: number; neto: number; iva: number }

/** Un comprobante normalizado, listo para escribir. Importes en la moneda del comprobante. */
export interface ComprobanteLid {
  origen: 'erp' | 'externo'
  ref_id: number
  fecha: string            // YYYY-MM-DD
  cbte_tipo: number
  pto_vta: number
  numero: number
  doc_tipo: number
  doc_nro: string
  nombre: string
  total: number
  neto: number             // suma de los netos gravados (informativo: el archivo lo lleva en ALICUOTAS)
  iva: number
  no_gravado: number
  exento: number
  perc_no_categorizados: number
  perc_nacionales: number
  perc_iibb: number
  perc_municipales: number
  impuestos_internos: number
  otros_tributos: number
  moneda: string           // código LID (PES, DOL, 060…)
  tipo_cambio: number
  alicuotas: AlicuotaLid[]
  vto_pago: string | null  // YYYY-MM-DD
}

// ── Formateo de campos ──────────────────────────────────────────────────────

export class LidFormatoError extends Error {
  constructor(msg: string) { super(msg); this.name = 'LidFormatoError' }
}

/**
 * Importe → centavos enteros, half-up, sin errores de coma flotante. Acepta el
 * string de un `numeric` de Postgres ("1234.56") o un number.
 */
export function aCentavos(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0
  const s = typeof v === 'number' ? v.toFixed(6) : String(v).trim()
  const m = s.match(/^(-)?(\d*)(?:\.(\d*))?$/)
  if (!m) throw new LidFormatoError(`importe inválido: ${s}`)
  const neg = m[1] === '-'
  const ent = m[2] || '0'
  const dec = (m[3] ?? '').padEnd(3, '0')
  let c = Number(ent) * 100 + Number(dec.slice(0, 2))
  if (Number(dec[2]) >= 5) c += 1
  return neg && c !== 0 ? -c : c
}

/** Número entero con ceros a la izquierda en `len` posiciones. */
export function campoNum(n: number | string, len: number): string {
  const s = String(n).replace(/\D/g, '')
  if (s.length > len) throw new LidFormatoError(`«${n}» no entra en ${len} posiciones`)
  return s.padStart(len, '0')
}

/**
 * Importe de 15 posiciones: 13 enteros + 2 decimales sin punto. Si fuera
 * negativo, el «-» va en la primera posición (consideraciones generales, pto. 1).
 */
export function campoImporte(v: number | string | null | undefined, len = 15): string {
  const c = aCentavos(v)
  if (c < 0) return '-' + campoNum(-c, len - 1)
  return campoNum(c, len)
}

/** Tipo de cambio: 4 enteros + 6 decimales sin punto (10 posiciones). */
export function campoTipoCambio(tc: number | string | null | undefined): string {
  const n = tc === null || tc === undefined || tc === '' || Number(tc) <= 0 ? 1 : Number(tc)
  const micro = Math.round(n * 1_000_000)
  return campoNum(micro, 10)
}

/** AAAAMMDD desde YYYY-MM-DD; sin fecha → ceros. */
export function campoFecha(iso: string | null | undefined): string {
  if (!iso) return '00000000'
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) throw new LidFormatoError(`fecha inválida: ${iso}`)
  return `${m[1]}${m[2]}${m[3]}`
}

/**
 * Texto a la izquierda, con blancos a la derecha, cortado a `len`. El archivo
 * es ANSI (ISO 8859-1 / Windows-1252): se reemplazan comillas tipográficas y
 * guiones largos, y lo que igual quede fuera de Latin-1 pasa a «?».
 */
export function campoTexto(s: string | null | undefined, len: number): string {
  const limpio = (s ?? '')
    .normalize('NFC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .trim()
  return limpio.slice(0, len).padEnd(len, ' ')
}

// ── Código de operación y alícuotas ─────────────────────────────────────────

/**
 * Campo 20. Solo cuando no hay IVA (todo a alícuota 0): E si hay exento, N si
 * hay no gravado. Con IVA → '0' («No corresponde»: blanco o cero, tabla 2).
 */
export function codigoOperacion(c: Pick<ComprobanteLid, 'alicuotas' | 'exento' | 'no_gravado'>): string {
  const hayGravado = c.alicuotas.some(a => a.codigo !== 3 && (aCentavos(a.neto) !== 0 || aCentavos(a.iva) !== 0))
  if (hayGravado) return '0'
  if (aCentavos(c.exento) !== 0) return 'E'
  if (aCentavos(c.no_gravado) !== 0) return 'N'
  return '0'
}

/**
 * Las alícuotas que van al archivo. Sin ninguna gravada, un registro 0003
 * con neto 0 e IVA 0 (la parte exenta/no gravada vive en la cabecera).
 */
export function alicuotasParaArchivo(c: Pick<ComprobanteLid, 'alicuotas'>): AlicuotaLid[] {
  const gravadas = c.alicuotas.filter(a => a.codigo !== 3 || aCentavos(a.neto) !== 0)
  return gravadas.length ? gravadas : [{ codigo: 3, neto: 0, iva: 0 }]
}

/**
 * Comprobante sin desglose (externos de «Mis Comprobantes»): deduce la alícuota
 * si iva/neto cierra con UNA de la tabla con tolerancia de centavos. Si no
 * cierra, null: NO se inventa (va a revisar).
 *   - neto 0 e IVA 0 → sin alícuota gravada (exento / no gravado), [].
 */
export const TOLERANCIA_ALICUOTA = 0.05
export function deducirAlicuota(neto: number, iva: number): AlicuotaLid[] | null {
  const n = aCentavos(neto), i = aCentavos(iva)
  if (n === 0 && i === 0) return []
  if (n <= 0) return null
  const tol = Math.round(TOLERANCIA_ALICUOTA * 100)
  const candidatas = [5, 4, 6, 8, 9].filter(cod => Math.abs(Math.round(n * ALICUOTAS_LID[cod]!.tasa) - i) <= tol)
  if (candidatas.length !== 1) return null
  return [{ codigo: candidatas[0]!, neto, iva }]
}

// ── Líneas ──────────────────────────────────────────────────────────────────

export const LARGO_CBTE = 266
export const LARGO_ALICUOTA = 62

/** Registro LIBRO_IVA_DIGITAL_VENTAS_CBTE (266 posiciones). */
export function lineaCbte(c: ComprobanteLid): string {
  const als = alicuotasParaArchivo(c)
  if (als.length > 9) throw new LidFormatoError('más de 9 alícuotas')
  const esCF = c.doc_tipo === 99
  const partes = [
    campoFecha(c.fecha),                                 // 1  fecha                  1-8
    campoNum(c.cbte_tipo, 3),                            // 2  tipo                   9-11
    campoNum(c.pto_vta, 5),                              // 3  punto de venta         12-16
    campoNum(c.numero, 20),                              // 4  número                 17-36
    campoNum(c.numero, 20),                              // 5  número hasta           37-56
    campoNum(c.doc_tipo, 2),                             // 6  código de documento    57-58
    campoNum(esCF ? 0 : (c.doc_nro || '0'), 20),         // 7  nro. identificación    59-78
    campoTexto(esCF && !c.nombre ? 'CONSUMIDOR FINAL' : c.nombre, 30), // 8          79-108
    campoImporte(Math.abs(c.total)),                     // 9  total                  109-123
    campoImporte(Math.abs(c.no_gravado)),                // 10 no integran neto grav. 124-138
    campoImporte(Math.abs(c.perc_no_categorizados)),     // 11 percepción no categ.   139-153
    campoImporte(Math.abs(c.exento)),                    // 12 exentas                154-168
    campoImporte(Math.abs(c.perc_nacionales)),           // 13 perc. nacionales       169-183
    campoImporte(Math.abs(c.perc_iibb)),                 // 14 perc. IIBB             184-198
    campoImporte(Math.abs(c.perc_municipales)),          // 15 perc. municipales      199-213
    campoImporte(Math.abs(c.impuestos_internos)),        // 16 impuestos internos     214-228
    campoTexto(c.moneda, 3),                             // 17 moneda                 229-231
    campoTipoCambio(c.tipo_cambio),                      // 18 tipo de cambio         232-241
    String(als.length),                                  // 19 cantidad de alícuotas  242
    codigoOperacion(c),                                  // 20 código de operación    243
    campoImporte(Math.abs(c.otros_tributos)),            // 21 otros tributos         244-258
    campoFecha(c.vto_pago),                              // 22 vto. o pago            259-266
  ]
  const linea = partes.join('')
  if (linea.length !== LARGO_CBTE) throw new LidFormatoError(`línea CBTE de ${linea.length} posiciones`)
  return linea
}

/** Registros LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS (62 posiciones c/u). */
export function lineasAlicuotas(c: ComprobanteLid): string[] {
  return alicuotasParaArchivo(c).map(a => {
    const linea = [
      campoNum(c.cbte_tipo, 3),           // 1 tipo              1-3
      campoNum(c.pto_vta, 5),             // 2 punto de venta    4-8
      campoNum(c.numero, 20),             // 3 número            9-28
      campoImporte(Math.abs(a.neto)),     // 4 neto gravado      29-43
      campoNum(a.codigo, 4),              // 5 alícuota          44-47
      campoImporte(Math.abs(a.iva)),      // 6 impuesto liq.     48-62
    ].join('')
    if (linea.length !== LARGO_ALICUOTA) throw new LidFormatoError(`línea ALICUOTAS de ${linea.length} posiciones`)
    return linea
  })
}

/** CRLF entre líneas y al final (archivo vacío si no hay líneas). */
export function unirLineas(lineas: string[]): string {
  return lineas.length ? lineas.join('\r\n') + '\r\n' : ''
}

// ── Normalización desde las fuentes ─────────────────────────────────────────

export const etiqueta = (c: Pick<ComprobanteLid, 'cbte_tipo' | 'pto_vta' | 'numero'>) =>
  `${String(c.cbte_tipo).padStart(3, '0')} ${String(c.pto_vta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}`

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))
const soloDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '')

/** Moneda de la base (ARCA MonId o lo que traiga el Excel) → código LID. */
export function monedaLid(m: string | null | undefined): string {
  const s = (m ?? '').trim().toUpperCase()
  if (!s || s === '$' || s === 'ARS' || s === 'PES') return 'PES'
  if (s === 'USD' || s === 'U$S' || s === 'US$' || s === 'DOL') return 'DOL'
  if (s === 'EUR') return '060'
  return s.slice(0, 3)
}

export interface FilaFacturaErp {
  id: number; cbte_tipo: number; pto_vta: number; numero: number | null; fecha_cbte: string
  fch_vto_pago?: string | null
  rec_doc_tipo: number; rec_doc_nro: string | null; rec_razon_social: string | null
  moneda: string | null; cotizacion: number | string | null
  imp_neto: number | string; imp_iva: number | string; imp_trib: number | string
  imp_op_ex: number | string; imp_tot_conc: number | string; imp_total: number | string
  alicuotas: Array<{ alicuota_id: number; base_imp: number | string; importe: number | string }>
}

export interface FilaExterno {
  id: number; cbte_tipo: number | null; pto_vta: number; numero: number; fecha: string
  rec_doc_tipo: number | null; rec_doc_nro: string | null; rec_razon_social: string | null
  neto: number | string | null; no_gravado: number | string | null; exento: number | string | null
  iva: number | string | null; total: number | string; moneda: string | null; tipo_cambio: number | string | null
}

/** Factura emitida por el ERP (ya con CAE): trae el desglose por alícuota de ARCA. */
export function desdeErp(f: FilaFacturaErp): ComprobanteLid {
  return {
    origen: 'erp', ref_id: f.id,
    fecha: f.fecha_cbte, cbte_tipo: f.cbte_tipo, pto_vta: f.pto_vta, numero: Number(f.numero ?? 0),
    doc_tipo: f.rec_doc_tipo, doc_nro: soloDigitos(f.rec_doc_nro), nombre: f.rec_razon_social ?? '',
    total: num(f.imp_total), neto: num(f.imp_neto), iva: num(f.imp_iva),
    no_gravado: num(f.imp_tot_conc), exento: num(f.imp_op_ex),
    perc_no_categorizados: 0, perc_nacionales: 0, perc_iibb: 0, perc_municipales: 0, impuestos_internos: 0,
    // WSFE no desglosa ImpTrib en el total del comprobante: va entero a «Otros tributos».
    otros_tributos: num(f.imp_trib),
    moneda: monedaLid(f.moneda), tipo_cambio: num(f.cotizacion) || 1,
    alicuotas: (f.alicuotas ?? []).map(a => ({ codigo: a.alicuota_id, neto: num(a.base_imp), iva: num(a.importe) })),
    vto_pago: f.fch_vto_pago ?? null,
  }
}

/**
 * Comprobante externo (ARCA «Mis Comprobantes Emitidos»): sin desglose por
 * alícuota. Devuelve `alicuotas: null` si no se puede deducir.
 */
export function desdeExterno(e: FilaExterno): ComprobanteLid & { alicuotaDeducida: boolean } {
  const neto = num(e.neto), iva = num(e.iva)
  const als = deducirAlicuota(neto, iva)
  return {
    origen: 'externo', ref_id: e.id,
    fecha: e.fecha, cbte_tipo: Number(e.cbte_tipo ?? 0), pto_vta: e.pto_vta, numero: Number(e.numero),
    doc_tipo: e.rec_doc_tipo ?? 80, doc_nro: soloDigitos(e.rec_doc_nro), nombre: e.rec_razon_social ?? '',
    total: num(e.total), neto, iva, no_gravado: num(e.no_gravado), exento: num(e.exento),
    perc_no_categorizados: 0, perc_nacionales: 0, perc_iibb: 0, perc_municipales: 0, impuestos_internos: 0,
    // «Mis Comprobantes» no trae tributos sueltos: si total > neto+ng+ex+iva, la diferencia son tributos.
    otros_tributos: 0,
    moneda: monedaLid(e.moneda), tipo_cambio: num(e.tipo_cambio) || 1,
    alicuotas: als ?? [],
    alicuotaDeducida: als !== null,
    vto_pago: null,
  }
}

// ── Validaciones de un comprobante ──────────────────────────────────────────

/** Dígito verificador de la CUIT/CUIL. */
export function cuitValida(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((s, p, i) => s + p * Number(cuit[i]), 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(cuit[10])
}

export function validarComprobante(c: ComprobanteLid): Validacion[] {
  const v: Validacion[] = []
  const id = etiqueta(c)
  const ce = aCentavos
  const suma = ce(c.neto) + ce(c.no_gravado) + ce(c.exento) + ce(c.iva) + ce(c.otros_tributos)
    + ce(c.perc_no_categorizados) + ce(c.perc_nacionales) + ce(c.perc_iibb) + ce(c.perc_municipales) + ce(c.impuestos_internos)
  const dif = suma - ce(c.total)
  if (dif !== 0) {
    v.push({ comprobante: id, severidad: 'error', mensaje:
      `No cierra: neto + no gravado + exento + IVA + tributos = ${(suma / 100).toFixed(2)} y el total es ${(ce(c.total) / 100).toFixed(2)} (diferencia ${(dif / 100).toFixed(2)}).` +
      (Math.abs(dif) <= 5 ? ' Parece redondeo del emisor: el LID exige que el total sea la suma de sus partes; revisar el comprobante en ARCA y corregirlo a mano al importar.' : '') })
  }
  const netoAl = c.alicuotas.reduce((s, a) => s + ce(a.neto), 0)
  const ivaAl = c.alicuotas.reduce((s, a) => s + ce(a.iva), 0)
  if (c.alicuotas.length && (netoAl !== ce(c.neto) || ivaAl !== ce(c.iva))) {
    v.push({ comprobante: id, severidad: 'error', mensaje:
      `El detalle por alícuota (neto ${(netoAl / 100).toFixed(2)}, IVA ${(ivaAl / 100).toFixed(2)}) no coincide con la cabecera (neto ${Number(c.neto).toFixed(2)}, IVA ${Number(c.iva).toFixed(2)}).` })
  }
  for (const a of c.alicuotas) {
    const t = ALICUOTAS_LID[a.codigo]
    if (!t) { v.push({ comprobante: id, severidad: 'error', mensaje: `Alícuota ${a.codigo} fuera de la tabla del LID.` }); continue }
    if (Math.abs(Math.round(ce(a.neto) * t.tasa) - ce(a.iva)) > Math.round(TOLERANCIA_ALICUOTA * 100) + 1) {
      v.push({ comprobante: id, severidad: 'advertencia', mensaje: `IVA ${Number(a.iva).toFixed(2)} no es el ${t.label} de ${Number(a.neto).toFixed(2)}.` })
    }
  }
  if (!NOMBRE_TIPO_LID[c.cbte_tipo]) {
    v.push({ comprobante: id, severidad: 'error', mensaje: `Tipo de comprobante ${c.cbte_tipo} desconocido para el libro de ventas.` })
  }
  if (c.pto_vta < 1 || c.pto_vta > 9997) {
    v.push({ comprobante: id, severidad: 'error', mensaje: `Punto de venta ${c.pto_vta} fuera de rango (1 a 9997).` })
  }
  if (!c.numero) v.push({ comprobante: id, severidad: 'error', mensaje: 'Sin número de comprobante.' })
  if (c.doc_tipo === 80 && !cuitValida(c.doc_nro)) {
    v.push({ comprobante: id, severidad: 'advertencia', mensaje: `La CUIT del comprador «${c.doc_nro}» no es válida (dígito verificador).` })
  }
  if (c.doc_tipo !== 99 && !c.doc_nro) {
    v.push({ comprobante: id, severidad: 'error', mensaje: 'Falta el número de documento del comprador.' })
  }
  if (c.moneda !== 'PES') {
    v.push({ comprobante: id, severidad: 'advertencia', mensaje: `En moneda ${c.moneda} (tipo de cambio ${c.tipo_cambio}): los importes se informan en la moneda ORIGINAL; al importar elegir esa opción o convertir.` })
  }
  return v
}

// ── El libro del período ────────────────────────────────────────────────────

export interface FilaDetalle {
  comprobante: string
  origen: 'erp' | 'externo'
  fecha: string; cbte_tipo: number; tipo: string; pto_vta: number; numero: number
  doc_tipo: number; doc_nro: string; nombre: string
  alicuota: string; neto: number; iva: number; no_gravado: number; exento: number; otros_tributos: number; total: number
  moneda: string; tipo_cambio: number; codigo_operacion: string
  incluido: boolean; motivo_exclusion: string | null
}

export interface LibroVentas {
  periodo: string
  resumen: {
    comprobantes: number; neto: number; iva: number; total: number
    no_gravado: number; exento: number; otros_tributos: number
    por_alicuota: Array<{ codigo: number; alicuota: string; neto: number; iva: number; registros: number }>
    por_tipo: Array<{ cbte_tipo: number; tipo: string; cantidad: number; neto: number; iva: number; total: number }>
    excluidos: number
    lineas_cbte: number; lineas_alicuotas: number
  }
  validaciones: Validacion[]
  detalle: FilaDetalle[]
  archivos: { cbte: string; alicuotas: string }
}

const r2 = (cents: number) => cents / 100

/**
 * Arma el libro: dedup por (tipo, PV, número) priorizando el ERP, ordena por
 * fecha/tipo/PV/número (mismo orden en los dos archivos), deja afuera los
 * externos sin alícuota deducible y — salvo `incluirCvlp` — las CVLP (060).
 * El resumen resta las notas de crédito.
 */
export function armarLibro(periodo: string, erp: ComprobanteLid[], externos: Array<ComprobanteLid & { alicuotaDeducida?: boolean }>, opts: { incluirCvlp: boolean }): LibroVentas {
  const validaciones: Validacion[] = []
  const clave = (c: ComprobanteLid) => `${c.cbte_tipo}-${c.pto_vta}-${c.numero}`
  const porClave = new Map<string, ComprobanteLid & { alicuotaDeducida?: boolean }>()
  for (const c of erp) porClave.set(clave(c), c)
  for (const e of externos) {
    const k = clave(e)
    const previo = porClave.get(k)
    if (previo) {
      validaciones.push({ comprobante: etiqueta(e), severidad: 'info', mensaje:
        previo.origen === 'erp'
          ? 'Está emitido por el ERP y también importado de ARCA: se informa una sola vez, con los datos del ERP.'
          : 'Importado dos veces de ARCA: se informa una sola vez.' })
      continue
    }
    porClave.set(k, e)
  }

  const todos = [...porClave.values()].sort((a, b) =>
    a.fecha.localeCompare(b.fecha) || a.cbte_tipo - b.cbte_tipo || a.pto_vta - b.pto_vta || a.numero - b.numero)

  const lineasC: string[] = []
  const lineasA: string[] = []
  const detalle: FilaDetalle[] = []
  const porAl = new Map<number, { neto: number; iva: number; registros: number }>()
  const porTipo = new Map<number, { cantidad: number; neto: number; iva: number; total: number }>()
  let tot = { n: 0, neto: 0, iva: 0, total: 0, ng: 0, ex: 0, trib: 0 }
  let excluidos = 0
  const cvlpExcluidas: ComprobanteLid[] = []

  for (const c of todos) {
    const id = etiqueta(c)
    let motivo: string | null = null
    if (c.cbte_tipo === TIPO_CVLP && !opts.incluirCvlp) {
      motivo = 'CVLP (060) fuera del libro: la opción «incluir CVLP» está apagada.'
      cvlpExcluidas.push(c)
    } else if (c.origen === 'externo' && (c as { alicuotaDeducida?: boolean }).alicuotaDeducida === false) {
      motivo = 'Sin desglose por alícuota y el IVA no cierra con ninguna tasa: A REVISAR, cargarlo a mano en el LID.'
      validaciones.push({ comprobante: id, severidad: 'error', mensaje:
        `A revisar: IVA ${Number(c.iva).toFixed(2)} sobre neto ${Number(c.neto).toFixed(2)} no corresponde a ninguna alícuota (21 / 10,5 / 27 / 5 / 2,5 %). Quedó FUERA de los archivos.` })
    }

    let lc: string | null = null, la: string[] = []
    if (!motivo) {
      try {
        lc = lineaCbte(c)
        la = lineasAlicuotas(c)
      } catch (err) {
        motivo = `No se pudo escribir: ${(err as Error).message}`
        validaciones.push({ comprobante: id, severidad: 'error', mensaje: `${motivo}. Quedó FUERA de los archivos.` })
      }
    }
    validaciones.push(...validarComprobante(c))

    const codOp = codigoOperacion(c)
    const tipo = NOMBRE_TIPO_LID[c.cbte_tipo] ?? `Tipo ${c.cbte_tipo}`
    const alsTxt = alicuotasParaArchivo(c).map(a => ALICUOTAS_LID[a.codigo]?.label ?? String(a.codigo)).join(' + ')
    detalle.push({
      comprobante: id, origen: c.origen, fecha: c.fecha, cbte_tipo: c.cbte_tipo, tipo, pto_vta: c.pto_vta, numero: c.numero,
      doc_tipo: c.doc_tipo, doc_nro: c.doc_nro, nombre: c.nombre, alicuota: alsTxt,
      neto: c.neto, iva: c.iva, no_gravado: c.no_gravado, exento: c.exento, otros_tributos: c.otros_tributos, total: c.total,
      moneda: c.moneda, tipo_cambio: c.tipo_cambio, codigo_operacion: codOp,
      incluido: !motivo, motivo_exclusion: motivo,
    })
    if (motivo || !lc) { excluidos++; continue }

    lineasC.push(lc)
    lineasA.push(...la)
    const s = TIPOS_NC_LID.has(c.cbte_tipo) ? -1 : 1
    const ce = aCentavos
    tot.n++
    tot.neto += s * ce(c.neto); tot.iva += s * ce(c.iva); tot.total += s * ce(c.total)
    tot.ng += s * ce(c.no_gravado); tot.ex += s * ce(c.exento); tot.trib += s * ce(c.otros_tributos)
    for (const a of alicuotasParaArchivo(c)) {
      const acc = porAl.get(a.codigo) ?? { neto: 0, iva: 0, registros: 0 }
      acc.neto += s * ce(a.neto); acc.iva += s * ce(a.iva); acc.registros++
      porAl.set(a.codigo, acc)
    }
    const t = porTipo.get(c.cbte_tipo) ?? { cantidad: 0, neto: 0, iva: 0, total: 0 }
    t.cantidad++; t.neto += s * ce(c.neto); t.iva += s * ce(c.iva); t.total += s * ce(c.total)
    porTipo.set(c.cbte_tipo, t)
  }

  if (cvlpExcluidas.length) {
    const iva = cvlpExcluidas.reduce((s, c) => s + aCentavos(c.iva), 0)
    validaciones.unshift({ comprobante: `${cvlpExcluidas.length} CVLP (060)`, severidad: 'advertencia', mensaje:
      `Quedaron fuera ${cvlpExcluidas.length} cuentas de venta y líquido producto (IVA $ ${(iva / 100).toFixed(2)}). ` +
      'Según el Anexo VII del LID el comitente las registra en VENTAS (código 060, CUIT del comisionista como comprador). ' +
      'Confirmalo con el contador y generá el libro con «incluir CVLP».' })
  }

  const orden: Record<Severidad, number> = { error: 0, advertencia: 1, info: 2 }
  validaciones.sort((a, b) => orden[a.severidad] - orden[b.severidad])

  return {
    periodo,
    resumen: {
      comprobantes: tot.n, neto: r2(tot.neto), iva: r2(tot.iva), total: r2(tot.total),
      no_gravado: r2(tot.ng), exento: r2(tot.ex), otros_tributos: r2(tot.trib),
      por_alicuota: [...porAl.entries()].sort((a, b) => a[0] - b[0]).map(([codigo, a]) => ({
        codigo, alicuota: ALICUOTAS_LID[codigo]?.label ?? String(codigo), neto: r2(a.neto), iva: r2(a.iva), registros: a.registros,
      })),
      por_tipo: [...porTipo.entries()].sort((a, b) => a[0] - b[0]).map(([cbte_tipo, t]) => ({
        cbte_tipo, tipo: NOMBRE_TIPO_LID[cbte_tipo] ?? `Tipo ${cbte_tipo}`, cantidad: t.cantidad, neto: r2(t.neto), iva: r2(t.iva), total: r2(t.total),
      })),
      excluidos,
      lineas_cbte: lineasC.length, lineas_alicuotas: lineasA.length,
    },
    validaciones,
    detalle,
    archivos: { cbte: unirLineas(lineasC), alicuotas: unirLineas(lineasA) },
  }
}

/** YYYY-MM → [desde, hasta] (fechas ISO inclusive). */
export function rangoPeriodo(periodo: string): { desde: string; hasta: string } {
  const m = periodo.match(/^(\d{4})-(\d{2})$/)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new LidFormatoError(`período inválido: ${periodo}`)
  const y = Number(m[1]), mes = Number(m[2])
  const ultimo = new Date(Date.UTC(y, mes, 0)).getUTCDate()
  return { desde: `${m[1]}-${m[2]}-01`, hasta: `${m[1]}-${m[2]}-${String(ultimo).padStart(2, '0')}` }
}

/** Nombre de archivo sugerido. */
export function nombreArchivo(periodo: string, archivo: 'cbte' | 'alicuotas'): string {
  return `LIBRO_IVA_DIGITAL_VENTAS_${archivo === 'cbte' ? 'CBTE' : 'ALICUOTAS'}_${periodo.replace('-', '')}.txt`
}

/** Texto → bytes ANSI (Latin-1). `campoTexto` ya dejó todo dentro de 0x00–0xFF. */
export function aAnsi(texto: string): Uint8Array {
  const out = new Uint8Array(texto.length)
  for (let i = 0; i < texto.length; i++) {
    const cp = texto.charCodeAt(i)
    out[i] = cp <= 0xff ? cp : 0x3f
  }
  return out
}
