/**
 * Libro IVA Digital — COMPRAS (RG 4597): los dos archivos de importación de
 * ancho fijo, y la posición de IVA del mes. Funciones PURAS (sin base, sin
 * red): `lid-compras.service.ts` lee las facturas de proveedor del módulo
 * Compras (`pagos_facturas` + su desglose) y llama acá. Los helpers de campo
 * son los de `lid-ventas.ts`.
 *
 * FUENTES (bajadas y verificadas el 2026-09-24):
 *   - Diseño de registro: ARCA, «ANEXO I – DISEÑOS DE REGISTROS»
 *     https://www.afip.gob.ar/iva/documentos/libro-iva-digital-diseno-registros.pdf
 *       LIBRO_IVA_DIGITAL_COMPRAS_CBTE ....... longitud 325 (25 campos)
 *       LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS .. longitud 84  (8 campos)
 *   - Especificaciones (Revisión 30/07/2025):
 *     https://www.afip.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf
 *       · campo 5 (despacho de importación): con ceros (las importaciones van en otro archivo);
 *       · campo 6: código 80 (CUIT) en todos los casos;
 *       · campo 9: el total es la suma de sus partes, «esta última condición no se
 *         aplica para los comprobantes tipo B o C»;
 *       · campo 19: «para los comprobantes recibidos que no discriminan el IVA, es decir
 *         tipo B o C, este campo se completará con cero» — y en ALICUOTAS «para los
 *         comprobantes tipo B o C no se informarán» registros;
 *       · campo 21 (crédito fiscal computable): sin prorrateo, «idéntico al impuesto
 *         liquidado total del comprobante». CADINC no prorratea (no hace operaciones
 *         exentas): si algún día las hace, el contador elige prorrateo y esto cambia;
 *       · campos 23–25 (emisor/corredor, IVA comisión): solo para 033/058/059/060/063;
 *         el resto con ceros y blancos.
 *
 * La posición de IVA (débito − crédito − percepciones − retenciones) es una
 * AYUDA para el contador, no la DDJJ: no arrastra saldos a favor de meses
 * anteriores (el LID los toma de la declaración anterior).
 */
import {
  ALICUOTAS_LID, TOLERANCIA_ALICUOTA, aCentavos, campoFecha, campoImporte, campoNum, campoTexto,
  campoTipoCambio, cuitValida, unirLineas, LidFormatoError,
  type AlicuotaLid, type Severidad, type Validacion,
} from './lid-ventas.js'

// ── Tipos de comprobante ────────────────────────────────────────────────────

/** Tabla «Comprobantes Compras» del LID, lo que CADINC puede recibir (el CHECK de `pagos_facturas.cbte_tipo_arca`). */
export const NOMBRE_TIPO_COMPRA: Readonly<Record<number, string>> = {
  1: 'Factura A', 2: 'Nota de débito A', 3: 'Nota de crédito A', 4: 'Recibo A', 5: 'Nota de venta al contado A',
  6: 'Factura B', 7: 'Nota de débito B', 8: 'Nota de crédito B', 9: 'Recibo B', 10: 'Nota de venta al contado B',
  11: 'Factura C', 12: 'Nota de débito C', 13: 'Nota de crédito C', 15: 'Recibo C',
  51: 'Factura M', 52: 'Nota de débito M', 53: 'Nota de crédito M', 54: 'Recibo M',
  81: 'Tique factura A', 82: 'Tique factura B', 83: 'Tique',
  201: 'Factura de crédito electrónica MiPyME A', 202: 'Nota de débito electrónica MiPyME A', 203: 'Nota de crédito electrónica MiPyME A',
  206: 'Factura de crédito electrónica MiPyME B', 207: 'Nota de débito electrónica MiPyME B', 208: 'Nota de crédito electrónica MiPyME B',
  211: 'Factura de crédito electrónica MiPyME C', 212: 'Nota de débito electrónica MiPyME C', 213: 'Nota de crédito electrónica MiPyME C',
}
export const TIPOS_NC_COMPRA = new Set([3, 8, 13, 53, 203, 208, 213])
/** Los que NO discriminan IVA: cantidad de alícuotas 0, sin registros de alícuotas, sin crédito fiscal. */
export const TIPOS_SIN_IVA = new Set([6, 7, 8, 9, 10, 11, 12, 13, 15, 82, 83, 206, 207, 208, 211, 212, 213])
/** 49 «bienes usados» va en un archivo propio del LID: no se mezcla con las compras ordinarias. */
export const TIPO_BIENES_USADOS = 49

/** `tipo_comprobante` de la factura → código del LID, cuando la lectura no dejó `cbte_tipo_arca`. */
export function tipoLidDe(tipoComprobante: string, cbteTipoArca: number | null): number | null {
  if (cbteTipoArca) return cbteTipoArca
  if (tipoComprobante === 'A') return 1
  if (tipoComprobante === 'B') return 6
  if (tipoComprobante === 'C') return 11
  return null // recibo / ticket / otro: no es un comprobante del libro
}

/** "08837-00004557" / "0012-00402141" → { pto_vta, numero }. Sin guion no se adivina. */
export function partirNumero(numero: string | null | undefined): { pto_vta: number; numero: number } | null {
  const m = String(numero ?? '').trim().match(/^(\d{1,5})\s*-\s*(\d{1,20})$/)
  if (!m) return null
  return { pto_vta: Number(m[1]), numero: Number(m[2]) }
}

// ── El comprobante normalizado ──────────────────────────────────────────────

export interface CompraLid {
  ref_id: number
  fecha: string            // YYYY-MM-DD
  cbte_tipo: number
  pto_vta: number
  numero: number
  cuit: string
  nombre: string
  total: number
  neto: number
  iva: number
  no_gravado: number
  exento: number
  perc_iva: number
  perc_nacionales: number  // otros impuestos nacionales: ganancias
  perc_iibb: number
  perc_municipales: number
  impuestos_internos: number
  otros_tributos: number
  alicuotas: AlicuotaLid[]
  estado: string
  paga_cliente: boolean
  desglose_a_revisar: boolean
}

export interface FilaFacturaCompra {
  id: number; tipo_comprobante: string; cbte_tipo_arca: number | null; numero: string | null; fecha: string
  neto: number | string | null; iva: number | string | null; no_gravado: number | string | null; exento: number | string | null
  total: number | string; estado: string; paga_cliente: boolean; desglose_a_revisar: boolean | null
  proveedor: { razon_social: string | null; cuit: string | null } | null
  iva_detalle: Array<{ alicuota_id: number; base_imp: number | string; importe: number | string }>
  tributos: Array<{ tipo: string; importe: number | string }>
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))

/**
 * Factura de proveedor → comprobante del libro. Devuelve el motivo si no se
 * puede informar (sin número partible, tipo que no es del libro).
 * `fueraDelLibro`: recibo / ticket / otro sin tipo de ARCA — no es un error ni
 * deja la posición incompleta, simplemente no va (no da crédito fiscal).
 */
export function desdeFacturaCompra(f: FilaFacturaCompra): { c: CompraLid | null; motivo: string | null; etiquetaCruda: string; fueraDelLibro?: boolean } {
  const etiquetaCruda = `${f.tipo_comprobante} ${f.numero ?? 's/n'} (#${f.id})`
  const tipo = tipoLidDe(f.tipo_comprobante, f.cbte_tipo_arca)
  if (tipo === null) return { c: null, etiquetaCruda, fueraDelLibro: true, motivo: `Cargada como «${f.tipo_comprobante}»: no va al Libro IVA (no da crédito fiscal). Si es un tique factura A (081), cargale el tipo de ARCA en la factura.` }
  if (tipo === TIPO_BIENES_USADOS) return { c: null, etiquetaCruda, motivo: 'Compra de bienes usados (049): va en el archivo propio de bienes usados del LID, cargarla a mano.' }
  const partes = partirNumero(f.numero)
  if (!partes) return { c: null, etiquetaCruda, motivo: `El número «${f.numero ?? ''}» no tiene la forma PPPPP-NNNNNNNN: corregirlo en la factura.` }
  const trib = (t: string) => (f.tributos ?? []).filter(x => x.tipo === t).reduce((s, x) => s + num(x.importe), 0)
  return {
    etiquetaCruda,
    motivo: null,
    c: {
      ref_id: f.id, fecha: f.fecha, cbte_tipo: tipo, pto_vta: partes.pto_vta, numero: partes.numero,
      cuit: String(f.proveedor?.cuit ?? '').replace(/\D/g, ''), nombre: f.proveedor?.razon_social ?? '',
      total: num(f.total), neto: num(f.neto), iva: num(f.iva), no_gravado: num(f.no_gravado), exento: num(f.exento),
      perc_iva: trib('percepcion_iva'), perc_nacionales: trib('percepcion_ganancias'), perc_iibb: trib('percepcion_iibb'),
      perc_municipales: trib('percepcion_municipal'), impuestos_internos: trib('impuestos_internos'), otros_tributos: trib('otro'),
      alicuotas: (f.iva_detalle ?? []).map(a => ({ codigo: a.alicuota_id, neto: num(a.base_imp), iva: num(a.importe) })),
      estado: f.estado, paga_cliente: !!f.paga_cliente, desglose_a_revisar: !!f.desglose_a_revisar,
    },
  }
}

// ── Código de operación, alícuotas y crédito fiscal ────────────────────────

export const discriminaIva = (c: Pick<CompraLid, 'cbte_tipo'>) => !TIPOS_SIN_IVA.has(c.cbte_tipo)

/** Registros de alícuota del archivo: ninguno en B/C; en A/M, un 0003 en cero si no hay nada gravado. */
export function alicuotasCompraParaArchivo(c: Pick<CompraLid, 'cbte_tipo' | 'alicuotas'>): AlicuotaLid[] {
  if (!discriminaIva(c)) return []
  const gravadas = c.alicuotas.filter(a => a.codigo !== 3 || aCentavos(a.neto) !== 0)
  return gravadas.length ? gravadas : [{ codigo: 3, neto: 0, iva: 0 }]
}

/**
 * Campo 20, con la convención del archivo que ARCA le aceptó al contador
 * (COMPRAS_CBTE ago-2026 v5): blanco si hay algo gravado, «N» en los que no
 * discriminan (B/C) y E / N en los A/M sin nada gravado.
 */
export function codigoOperacionCompra(c: Pick<CompraLid, 'cbte_tipo' | 'alicuotas' | 'exento' | 'no_gravado'>): string {
  if (!discriminaIva(c)) return 'N'
  const hayGravado = c.alicuotas.some(a => a.codigo !== 3 && (aCentavos(a.neto) !== 0 || aCentavos(a.iva) !== 0))
  if (hayGravado) return ' '
  if (aCentavos(c.exento) !== 0) return 'E'
  if (aCentavos(c.no_gravado) !== 0) return 'N'
  return ' '
}

/** Campo 21, sin prorrateo: el IVA liquidado del comprobante. B/C no dan crédito. */
export function creditoFiscal(c: Pick<CompraLid, 'cbte_tipo' | 'alicuotas'>): number {
  if (!discriminaIva(c)) return 0
  return c.alicuotas.reduce((s, a) => s + aCentavos(a.iva), 0) / 100
}

// ── Líneas ──────────────────────────────────────────────────────────────────

export const LARGO_CBTE_COMPRAS = 325
export const LARGO_ALICUOTA_COMPRAS = 84

/** Registro LIBRO_IVA_DIGITAL_COMPRAS_CBTE (325 posiciones). */
export function lineaCbteCompra(c: CompraLid): string {
  const als = alicuotasCompraParaArchivo(c)
  if (als.length > 9) throw new LidFormatoError('más de 9 alícuotas')
  const partes = [
    campoFecha(c.fecha),                              // 1  fecha                      1-8
    campoNum(c.cbte_tipo, 3),                         // 2  tipo                       9-11
    campoNum(c.pto_vta, 5),                           // 3  punto de venta             12-16
    campoNum(c.numero, 20),                           // 4  número                     17-36
    ' '.repeat(16),                                   // 5  despacho de importación    37-52 (blanco, como el v5 del contador)
    campoNum(80, 2),                                  // 6  código doc. vendedor       53-54
    campoNum(c.cuit || '0', 20),                      // 7  nro. identificación        55-74
    campoTexto(c.nombre, 30),                         // 8  denominación vendedor      75-104
    campoImporte(c.total),                            // 9  total                      105-119
    campoImporte(c.no_gravado),                       // 10 no integran neto gravado   120-134
    campoImporte(c.exento),                           // 11 exentas                    135-149
    campoImporte(c.perc_iva),                         // 12 percepciones IVA           150-164
    campoImporte(c.perc_nacionales),                  // 13 perc. otros nacionales     165-179
    campoImporte(c.perc_iibb),                        // 14 perc. IIBB                 180-194
    campoImporte(c.perc_municipales),                 // 15 perc. municipales          195-209
    campoImporte(c.impuestos_internos),               // 16 impuestos internos         210-224
    campoTexto('PES', 3),                             // 17 moneda                     225-227
    campoTipoCambio(1),                               // 18 tipo de cambio             228-237
    String(als.length),                               // 19 cantidad de alícuotas      238
    codigoOperacionCompra(c),                         // 20 código de operación        239
    campoImporte(creditoFiscal(c)),                   // 21 crédito fiscal computable  240-254
    campoImporte(c.otros_tributos),                   // 22 otros tributos             255-269
    campoNum(0, 11),                                  // 23 CUIT emisor/corredor       270-280
    campoTexto('', 30),                               // 24 denominación corredor      281-310
    campoImporte(0),                                  // 25 IVA comisión               311-325
  ]
  const linea = partes.join('')
  if (linea.length !== LARGO_CBTE_COMPRAS) throw new LidFormatoError(`línea CBTE de ${linea.length} posiciones`)
  return linea
}

/** Registros LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS (84 posiciones c/u). Ninguno para B/C. */
export function lineasAlicuotasCompra(c: CompraLid): string[] {
  return alicuotasCompraParaArchivo(c).map(a => {
    const linea = [
      campoNum(c.cbte_tipo, 3),        // 1 tipo                  1-3
      campoNum(c.pto_vta, 5),          // 2 punto de venta        4-8
      campoNum(c.numero, 20),          // 3 número                9-28
      campoNum(80, 2),                 // 4 código doc. vendedor  29-30
      campoNum(c.cuit || '0', 20),     // 5 nro. identificación   31-50
      campoImporte(a.neto),            // 6 neto gravado          51-65
      campoNum(a.codigo, 4),           // 7 alícuota              66-69
      campoImporte(a.iva),             // 8 impuesto liquidado    70-84
    ].join('')
    if (linea.length !== LARGO_ALICUOTA_COMPRAS) throw new LidFormatoError(`línea ALICUOTAS de ${linea.length} posiciones`)
    return linea
  })
}

// ── Validaciones de un comprobante ──────────────────────────────────────────

export const etiquetaCompra = (c: Pick<CompraLid, 'cbte_tipo' | 'pto_vta' | 'numero' | 'nombre'>) =>
  `${String(c.cbte_tipo).padStart(3, '0')} ${String(c.pto_vta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')} ${c.nombre}`.trim()

const pesos = (c: number) => (c / 100).toFixed(2)

/** Errores que dejan el comprobante AFUERA de los archivos. */
export function motivoExclusion(c: CompraLid): string | null {
  if (!NOMBRE_TIPO_COMPRA[c.cbte_tipo]) return `Tipo de comprobante ${c.cbte_tipo} desconocido para el libro de compras.`
  if (!cuitValida(c.cuit)) return `La CUIT del proveedor «${c.cuit || 'vacía'}» no es válida: corregirla en el padrón de proveedores.`
  if (c.pto_vta < 1 || c.pto_vta > 99997) return `Punto de venta ${c.pto_vta} fuera de rango.`
  if (!c.numero) return 'Sin número de comprobante.'
  if (discriminaIva(c) && (c.desglose_a_revisar || (!c.alicuotas.length && aCentavos(c.exento) === 0 && aCentavos(c.no_gravado) === 0))) {
    return 'Falta el desglose de IVA (alícuotas): completarlo en la factura antes de generar el libro.'
  }
  return null
}

export function validarCompra(c: CompraLid): Validacion[] {
  const v: Validacion[] = []
  const id = etiquetaCompra(c)
  const ce = aCentavos
  if (discriminaIva(c)) {
    const suma = ce(c.neto) + ce(c.no_gravado) + ce(c.exento) + ce(c.iva) + ce(c.perc_iva) + ce(c.perc_nacionales)
      + ce(c.perc_iibb) + ce(c.perc_municipales) + ce(c.impuestos_internos) + ce(c.otros_tributos)
    const dif = suma - ce(c.total)
    if (Math.abs(dif) === 1) {
      // Decisión del dueño (24/09, la #19 Zeramiko): el centavo de redondeo del
      // proveedor se acepta tal como está en el papel, no se inventa un no gravado.
      v.push({ comprobante: id, severidad: 'advertencia', mensaje:
        `Diferencia de redondeo del proveedor: las partes suman ${pesos(suma)} y el total impreso es ${pesos(ce(c.total))}. ` +
        'Se informa como está en el papel; si el importador del LID la rechaza, ajustá el centavo a mano al importar.' })
    } else if (dif !== 0) {
      v.push({ comprobante: id, severidad: 'error', mensaje:
        `No cierra: neto + no gravado + exento + IVA + percepciones + tributos = ${pesos(suma)} y el total es ${pesos(ce(c.total))} (diferencia ${pesos(dif)}). ` +
        'El LID exige que el total sea la suma de sus partes.' })
    }
    const netoAl = c.alicuotas.reduce((s, a) => s + ce(a.neto), 0)
    const ivaAl = c.alicuotas.reduce((s, a) => s + ce(a.iva), 0)
    if (c.alicuotas.length && (netoAl !== ce(c.neto) || ivaAl !== ce(c.iva))) {
      v.push({ comprobante: id, severidad: 'error', mensaje:
        `El detalle por alícuota (neto ${pesos(netoAl)}, IVA ${pesos(ivaAl)}) no coincide con la cabecera (neto ${pesos(ce(c.neto))}, IVA ${pesos(ce(c.iva))}).` })
    }
    for (const a of c.alicuotas) {
      const t = ALICUOTAS_LID[a.codigo]
      if (!t) { v.push({ comprobante: id, severidad: 'error', mensaje: `Alícuota ${a.codigo} fuera de la tabla del LID.` }); continue }
      if (Math.abs(Math.round(ce(a.neto) * t.tasa) - ce(a.iva)) > Math.round(TOLERANCIA_ALICUOTA * 100) + 1) {
        v.push({ comprobante: id, severidad: 'advertencia', mensaje: `IVA ${pesos(ce(a.iva))} no es el ${t.label} de ${pesos(ce(a.neto))}.` })
      }
    }
  } else if (ce(c.iva) !== 0) {
    v.push({ comprobante: id, severidad: 'advertencia', mensaje:
      `Es un comprobante ${NOMBRE_TIPO_COMPRA[c.cbte_tipo] ?? c.cbte_tipo} y tiene IVA cargado (${pesos(ce(c.iva))}): no da crédito fiscal, se informa solo el total.` })
  }
  if (c.estado === 'pendiente' || c.estado === 'observada') {
    const la = TIPOS_NC_COMPRA.has(c.cbte_tipo) ? 'La NC' : 'La factura'
    v.push({ comprobante: id, severidad: 'advertencia', mensaje:
      c.estado === 'observada' ? `${la} está OBSERVADA: confirmá que el comprobante es correcto antes de computar el crédito.` : `${la} todavía no está aprobada: se informa igual (el crédito nace con el comprobante).` })
  }
  if (c.paga_cliente) {
    v.push({ comprobante: id, severidad: 'advertencia', mensaje:
      'La paga el cliente: si el comprobante está a nombre de CADINC el crédito es de CADINC; si está a nombre del cliente, sacala del libro.' })
  }
  return v
}

// ── El libro del período ────────────────────────────────────────────────────

export interface FilaDetalleCompra {
  comprobante: string
  ref_id: number
  fecha: string; cbte_tipo: number | null; tipo: string; pto_vta: number | null; numero: number | null
  cuit: string; nombre: string
  alicuota: string; neto: number; iva: number; credito_fiscal: number; no_gravado: number; exento: number
  perc_iva: number; perc_iibb: number; perc_otras: number; otros_tributos: number; total: number
  estado: string
  incluido: boolean; motivo_exclusion: string | null
}

export interface LibroCompras {
  periodo: string
  resumen: {
    comprobantes: number; neto: number; iva: number; credito_fiscal: number; total: number
    no_gravado: number; exento: number
    perc_iva: number; perc_iibb: number; perc_nacionales: number; perc_municipales: number
    impuestos_internos: number; otros_tributos: number
    por_alicuota: Array<{ codigo: number; alicuota: string; neto: number; iva: number; registros: number }>
    por_tipo: Array<{ cbte_tipo: number; tipo: string; cantidad: number; neto: number; iva: number; total: number }>
    /** Quedaron FUERA por un problema a resolver: la posición está incompleta. No cuenta tickets ni duplicados. */
    excluidos: number
    lineas_cbte: number; lineas_alicuotas: number
  }
  validaciones: Validacion[]
  detalle: FilaDetalleCompra[]
  archivos: { cbte: string; alicuotas: string }
}

const r2 = (cents: number) => cents / 100

/**
 * Arma el libro: facturas ya normalizadas + las que no se pudieron normalizar
 * (con su motivo). Ordena por fecha/tipo/PV/número (mismo orden en los dos
 * archivos) y resta las notas de crédito en el resumen.
 */
export function armarLibroCompras(
  periodo: string,
  filas: Array<{ c: CompraLid | null; motivo: string | null; etiquetaCruda: string; fueraDelLibro?: boolean; fila: FilaFacturaCompra }>,
): LibroCompras {
  const validaciones: Validacion[] = []
  const detalle: FilaDetalleCompra[] = []
  const lineasC: string[] = []
  const lineasA: string[] = []
  const porAl = new Map<number, { neto: number; iva: number; registros: number }>()
  const porTipo = new Map<number, { cantidad: number; neto: number; iva: number; total: number }>()
  const t = { n: 0, neto: 0, iva: 0, cf: 0, total: 0, ng: 0, ex: 0, piva: 0, piibb: 0, pnac: 0, pmun: 0, int: 0, trib: 0 }
  let excluidos = 0
  const ce = aCentavos

  // Las que no se pudieron ni normalizar van primero al detalle, como excluidas.
  for (const x of filas.filter(x => !x.c)) {
    if (x.fueraDelLibro) {
      validaciones.push({ comprobante: x.etiquetaCruda, severidad: 'info', mensaje: x.motivo ?? '' })
    } else {
      excluidos++
      validaciones.push({ comprobante: x.etiquetaCruda, severidad: 'error', mensaje: `${x.motivo} Quedó FUERA de los archivos.` })
    }
    detalle.push({
      comprobante: x.etiquetaCruda, ref_id: x.fila.id, fecha: x.fila.fecha, cbte_tipo: null, tipo: x.fila.tipo_comprobante,
      pto_vta: null, numero: null, cuit: String(x.fila.proveedor?.cuit ?? ''), nombre: x.fila.proveedor?.razon_social ?? '',
      alicuota: '', neto: num(x.fila.neto), iva: num(x.fila.iva), credito_fiscal: 0, no_gravado: num(x.fila.no_gravado),
      exento: num(x.fila.exento), perc_iva: 0, perc_iibb: 0, perc_otras: 0, otros_tributos: 0, total: num(x.fila.total),
      estado: x.fila.estado, incluido: false, motivo_exclusion: x.motivo,
    })
  }

  const comps = filas.map(x => x.c).filter((c): c is CompraLid => !!c).sort((a, b) =>
    a.fecha.localeCompare(b.fecha) || a.cbte_tipo - b.cbte_tipo || a.pto_vta - b.pto_vta || a.numero - b.numero || a.cuit.localeCompare(b.cuit))

  // Mismo comprobante dos veces (misma CUIT, tipo y número): el índice único es por proveedor, no por CUIT.
  const vistos = new Set<string>()

  for (const c of comps) {
    const id = etiquetaCompra(c)
    let motivo = motivoExclusion(c)
    const clave = `${c.cuit}-${c.cbte_tipo}-${c.pto_vta}-${c.numero}`
    const duplicada = !motivo && vistos.has(clave)
    if (duplicada) motivo = 'Cargada dos veces (misma CUIT, tipo y número, en proveedores distintos del padrón): se informa una sola vez.'
    vistos.add(clave)

    let lc: string | null = null, la: string[] = []
    if (!motivo) {
      try {
        lc = lineaCbteCompra(c)
        la = lineasAlicuotasCompra(c)
      } catch (err) {
        motivo = `No se pudo escribir: ${(err as Error).message}`
      }
    }
    if (duplicada) validaciones.push({ comprobante: id, severidad: 'advertencia', mensaje: motivo! })
    else if (motivo) validaciones.push({ comprobante: id, severidad: 'error', mensaje: `${motivo} Quedó FUERA de los archivos.` })
    // Si ya quedó afuera, sus errores de cierre repiten el motivo: solo las advertencias suman.
    validaciones.push(...validarCompra(c).filter(v => !motivo || v.severidad !== 'error'))

    const cf = creditoFiscal(c)
    detalle.push({
      comprobante: id, ref_id: c.ref_id, fecha: c.fecha, cbte_tipo: c.cbte_tipo, tipo: NOMBRE_TIPO_COMPRA[c.cbte_tipo] ?? `Tipo ${c.cbte_tipo}`,
      pto_vta: c.pto_vta, numero: c.numero, cuit: c.cuit, nombre: c.nombre,
      alicuota: alicuotasCompraParaArchivo(c).map(a => ALICUOTAS_LID[a.codigo]?.label ?? String(a.codigo)).join(' + ') || '— (no discrimina)',
      neto: c.neto, iva: c.iva, credito_fiscal: cf, no_gravado: c.no_gravado, exento: c.exento,
      perc_iva: c.perc_iva, perc_iibb: c.perc_iibb, perc_otras: c.perc_nacionales + c.perc_municipales + c.impuestos_internos,
      otros_tributos: c.otros_tributos, total: c.total, estado: c.estado,
      incluido: !motivo, motivo_exclusion: motivo,
    })
    if (motivo || !lc) { if (!duplicada) excluidos++; continue }

    lineasC.push(lc)
    lineasA.push(...la)
    const s = TIPOS_NC_COMPRA.has(c.cbte_tipo) ? -1 : 1
    // B/C no discriminan: su IVA (si lo cargaron) no es IVA del libro.
    const ivaLibro = discriminaIva(c) ? ce(c.iva) : 0
    t.n++
    t.neto += s * ce(c.neto); t.iva += s * ivaLibro; t.cf += s * ce(cf); t.total += s * ce(c.total)
    t.ng += s * ce(c.no_gravado); t.ex += s * ce(c.exento)
    t.piva += s * ce(c.perc_iva); t.piibb += s * ce(c.perc_iibb); t.pnac += s * ce(c.perc_nacionales)
    t.pmun += s * ce(c.perc_municipales); t.int += s * ce(c.impuestos_internos); t.trib += s * ce(c.otros_tributos)
    for (const a of alicuotasCompraParaArchivo(c)) {
      const acc = porAl.get(a.codigo) ?? { neto: 0, iva: 0, registros: 0 }
      acc.neto += s * ce(a.neto); acc.iva += s * ce(a.iva); acc.registros++
      porAl.set(a.codigo, acc)
    }
    const pt = porTipo.get(c.cbte_tipo) ?? { cantidad: 0, neto: 0, iva: 0, total: 0 }
    pt.cantidad++; pt.neto += s * ce(c.neto); pt.iva += s * ivaLibro; pt.total += s * ce(c.total)
    porTipo.set(c.cbte_tipo, pt)
  }

  const orden: Record<Severidad, number> = { error: 0, advertencia: 1, info: 2 }
  validaciones.sort((a, b) => orden[a.severidad] - orden[b.severidad])

  return {
    periodo,
    resumen: {
      comprobantes: t.n, neto: r2(t.neto), iva: r2(t.iva), credito_fiscal: r2(t.cf), total: r2(t.total),
      no_gravado: r2(t.ng), exento: r2(t.ex),
      perc_iva: r2(t.piva), perc_iibb: r2(t.piibb), perc_nacionales: r2(t.pnac), perc_municipales: r2(t.pmun),
      impuestos_internos: r2(t.int), otros_tributos: r2(t.trib),
      por_alicuota: [...porAl.entries()].sort((a, b) => a[0] - b[0]).map(([codigo, a]) => ({
        codigo, alicuota: ALICUOTAS_LID[codigo]?.label ?? String(codigo), neto: r2(a.neto), iva: r2(a.iva), registros: a.registros,
      })),
      por_tipo: [...porTipo.entries()].sort((a, b) => a[0] - b[0]).map(([cbte_tipo, x]) => ({
        cbte_tipo, tipo: NOMBRE_TIPO_COMPRA[cbte_tipo] ?? `Tipo ${cbte_tipo}`, cantidad: x.cantidad, neto: r2(x.neto), iva: r2(x.iva), total: r2(x.total),
      })),
      excluidos,
      lineas_cbte: lineasC.length, lineas_alicuotas: lineasA.length,
    },
    validaciones,
    detalle,
    archivos: { cbte: unirLineas(lineasC), alicuotas: unirLineas(lineasA) },
  }
}

/** Nombre de archivo sugerido. */
export function nombreArchivoCompras(periodo: string, archivo: 'cbte' | 'alicuotas'): string {
  return `LIBRO_IVA_DIGITAL_COMPRAS_${archivo === 'cbte' ? 'CBTE' : 'ALICUOTAS'}_${periodo.replace('-', '')}.txt`
}

// ── Posición de IVA del mes ─────────────────────────────────────────────────

export interface PosicionIva {
  periodo: string
  debito_fiscal: number
  credito_fiscal: number
  /** débito − crédito: positivo = impuesto determinado; negativo = saldo técnico a favor. */
  impuesto_determinado: number
  saldo_tecnico_a_favor: number
  percepciones_iva: number
  retenciones_iva: number
  /** Lo que queda para pagar después de percepciones y retenciones. */
  a_pagar: number
  /** Percepciones y retenciones que sobran: saldo de libre disponibilidad. */
  libre_disponibilidad: number
  /** Cuántos comprobantes quedaron FUERA de cada libro (la posición está incompleta si > 0). */
  excluidos_ventas: number
  excluidos_compras: number
  avisos: string[]
}

/**
 * Débito − crédito − pagos a cuenta (percepciones sufridas + retenciones
 * sufridas). Los pagos a cuenta primero cancelan el impuesto determinado; lo
 * que sobra es libre disponibilidad. NO arrastra saldos de meses anteriores.
 */
export function posicionIva(periodo: string, x: {
  debito: number; credito: number; percepciones: number; retenciones: number; excluidosVentas: number; excluidosCompras: number
}): PosicionIva {
  const ce = aCentavos
  const deb = ce(x.debito), cred = ce(x.credito), perc = ce(x.percepciones), ret = ce(x.retenciones)
  const det = deb - cred
  const aCuenta = perc + ret
  const aPagar = det > 0 ? Math.max(0, det - aCuenta) : 0
  const libre = det > 0 ? Math.max(0, aCuenta - det) : aCuenta
  const avisos: string[] = [
    'No incluye saldos a favor de meses anteriores (técnico ni de libre disponibilidad): el formulario los toma de la declaración anterior.',
  ]
  if (x.excluidosVentas) avisos.push(`${x.excluidosVentas} comprobante(s) de VENTAS quedaron fuera del libro: la posición está incompleta hasta resolverlos.`)
  if (x.excluidosCompras) avisos.push(`${x.excluidosCompras} comprobante(s) de COMPRAS quedaron fuera del libro: la posición está incompleta hasta resolverlos.`)
  return {
    periodo,
    debito_fiscal: r2(deb), credito_fiscal: r2(cred),
    impuesto_determinado: r2(det), saldo_tecnico_a_favor: r2(det < 0 ? -det : 0),
    percepciones_iva: r2(perc), retenciones_iva: r2(ret),
    a_pagar: r2(aPagar), libre_disponibilidad: r2(libre),
    excluidos_ventas: x.excluidosVentas, excluidos_compras: x.excluidosCompras,
    avisos,
  }
}
