/**
 * Fusión del QR de ARCA con la lectura de la IA, y los controles que se le
 * muestran a la persona antes de guardar (20260924u). Todo puro: lo prueba
 * vitest y lo usa `lectura.service.ts`.
 *
 * Reglas:
 *   - El QR MANDA en lo que trae (CUIT emisor, tipo, punto de venta, número,
 *     fecha, total, CAE, receptor). Si la IA leyó otra cosa, se usa el QR y
 *     se avisa: puede ser la IA leyendo mal o un papel adulterado.
 *   - La IA completa lo que el QR no tiene: razón social, vencimiento, IVA
 *     por alícuota, no gravado, exento, percepciones.
 *   - Las sumas tienen que cerrar contra el total (±0,01). Si no cierran, NO
 *     se corrige nada solo: se avisa en el campo total.
 *   - Cada campo dice de dónde salió (`fuente_por_campo`): 'qr', 'ia' o
 *     'qr+ia' (los dos dijeron lo mismo).
 */
import { normCuit, cuitValido, aCentavos, sumaCentavos, cuadra } from '../pagos.util.js'
import { aFecha, aNumero } from '../control.service.js'
import {
  CUIT_CADINC, alicuotaIdDe, arcaDesdeLetra, tipoDesdeArca, esPercepcion, ALICUOTAS, NOMBRE_CBTE,
  type QrArca, type TipoComprobante, type TipoTributo,
} from './arca.js'
import type { LecturaIA } from './ia.js'

export type Severidad = 'error' | 'advertencia' | 'info'
export interface AvisoLectura {
  campo: string
  mensaje: string
  severidad: Severidad
  codigo: string
  /** Cuando QR y papel no coinciden: lo que dice el papel, para usarlo con un clic. */
  alternativa?: string | number | null
}
export type Fuente = 'qr' | 'ia' | 'qr+ia'

export interface IvaPropuesto { alicuota_id: number; base_imp: number; importe: number }
export interface TributoPropuesto {
  tipo: TipoTributo; jurisdiccion: string | null; descripcion: string
  alicuota: number | null; base_imp: number | null; importe: number
}

export interface Propuesta {
  emisor_cuit: string | null
  emisor_razon_social: string | null
  receptor_cuit: string | null
  cbte_tipo_arca: number | null
  tipo_comprobante: TipoComprobante | null
  punto_venta: string | null
  numero_comprobante: string | null
  fecha: string | null
  vence_el: string | null
  cae: string | null
  cae_vto: string | null
  moneda: string | null
  cotizacion: number | null
  neto: number | null
  no_gravado: number | null
  exento: number | null
  iva: IvaPropuesto[]
  tributos: TributoPropuesto[]
  total: number | null
  /** Qué se compró, en pocas palabras (sólo IA): precarga la descripción. */
  descripcion: string | null
  /** 'nota_credito' si el código ARCA (o la letra + clase leídas) es de NC (20260925a). */
  clase: 'factura' | 'nota_credito'
  /** Sólo NC: las facturas que menciona el papel (sólo IA). El service las cruza con las abiertas del proveedor. */
  comprobantes_asociados: ComprobanteAsociado[]
  /**
   * Concepto sugerido por la IA (20260925i), ya validado contra los activos.
   * Lo pone `analizarComprobante` (no la fusión: depende de la base); null si
   * la IA no sugirió o sugirió un id que no está en la lista.
   */
  concepto_id_sugerido?: number | null
  concepto_sugerido?: string | null
}

export interface ComprobanteAsociado { letra: string | null; punto_venta: string | null; numero: string | null }

export interface ResultadoFusion {
  propuesta: Propuesta
  fuente_por_campo: Record<string, Fuente>
  avisos: AvisoLectura[]
  estado: 'manual' | 'qr' | 'qr+ia' | 'ia'
}

const PV_ANCHO = 5
const NRO_ANCHO = 8
const soloDigitos = (s: string | null | undefined) => (s ?? '').replace(/\D+/g, '')
const pad = (s: string, n: number) => s.padStart(n, '0')
/** "0011" | "00011" | 11 → "00011". Vacío → null. */
export function fmtPuntoVenta(v: string | number | null | undefined): string | null {
  const d = soloDigitos(v == null ? '' : String(v)).replace(/^0+(?=\d)/, '')
  return d ? pad(d, PV_ANCHO) : null
}
export function fmtNumeroCbte(v: string | number | null | undefined): string | null {
  const d = soloDigitos(v == null ? '' : String(v)).replace(/^0+(?=\d)/, '')
  return d ? pad(d, NRO_ANCHO) : null
}

const fmtM = (n: number) => '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtF = (iso: string) => iso.split('-').reverse().join('/')

/** Lo que devuelve el modelo, saneado (números en centavos, fechas válidas, CUIT en dígitos). */
function sanear(ia: LecturaIA) {
  const iva: IvaPropuesto[] = []
  const ivaNoReconocido: number[] = []
  for (const f of ia.iva ?? []) {
    const id = alicuotaIdDe(f.alicuota_pct)
    const importe = aNumero(f.importe)
    if (id == null) { ivaNoReconocido.push(f.alicuota_pct); continue }
    if (importe == null) continue
    const base = aNumero(f.base_imponible)
    // Columnas en cero que algunos sistemas imprimen igual ("IVA 10,5 %: 0,00").
    if (importe === 0 && !base) continue
    // Sin base impresa, se deduce del importe (sólo si la alícuota no es 0).
    const baseOk = base ?? (ALICUOTAS[id] ? aCentavos(importe / ((ALICUOTAS[id] ?? 1) / 100)) : 0)
    const existente = iva.find((x) => x.alicuota_id === id)
    if (existente) {           // dos renglones de la misma alícuota: se suman
      existente.base_imp = aCentavos(existente.base_imp + baseOk)
      existente.importe = aCentavos(existente.importe + importe)
    } else {
      iva.push({ alicuota_id: id, base_imp: aCentavos(baseOk), importe: aCentavos(importe) })
    }
  }
  const tributos: TributoPropuesto[] = (ia.tributos ?? [])
    .map((t) => ({
      tipo: t.tipo,
      jurisdiccion: t.jurisdiccion?.trim() || null,
      descripcion: (t.descripcion ?? '').trim().slice(0, 200),
      alicuota: aNumero(t.alicuota_pct),
      base_imp: aNumero(t.base_imponible) == null ? null : aCentavos(aNumero(t.base_imponible)!),
      importe: aCentavos(aNumero(t.importe) ?? 0),
    }))
    .filter((t) => t.importe > 0)
  const cae = soloDigitos(ia.cae)
  return {
    emisor_cuit: normCuit(ia.emisor_cuit),
    emisor_razon_social: ia.emisor_razon_social?.trim() || null,
    receptor_cuit: normCuit(ia.receptor_cuit),
    cbte: ia.codigo_comprobante ?? arcaDesdeLetra(ia.letra, ia.clase),
    punto_venta: fmtPuntoVenta(ia.punto_venta),
    numero: fmtNumeroCbte(ia.numero),
    fecha: aFecha(ia.fecha_emision),
    vence: aFecha(ia.fecha_vencimiento_pago),
    cae: cae.length === 14 ? cae : null,
    cae_vto: aFecha(ia.cae_vencimiento),
    moneda: ia.moneda?.trim().toUpperCase() || null,
    neto: aNumero(ia.neto_gravado_total),
    no_gravado: aNumero(ia.no_gravado),
    exento: aNumero(ia.exento),
    iva, ivaNoReconocido, tributos,
    total: aNumero(ia.total),
    letra: ia.letra,
    clase: ia.clase,
    notas: ia.notas?.trim() || null,
    descripcion: ia.detalle_breve?.trim().slice(0, 120) || null,
    asociados: (ia.comprobantes_asociados ?? [])
      .map((x) => ({ letra: x.letra ?? null, punto_venta: fmtPuntoVenta(x.punto_venta), numero: fmtNumeroCbte(x.numero) }))
      .filter((x) => x.numero != null),
    legible: ia.legible,
  }
}

/**
 * QR + IA → propuesta. `qr` o `ia` pueden faltar (los dos no: sin nada, el
 * service ni llama). Los avisos de contexto (proveedor, duplicados) los suma
 * `controlesDeContexto`.
 */
export function fusionar(qr: QrArca | null, ia: LecturaIA | null, opts: { hoy: string }): ResultadoFusion {
  const avisos: AvisoLectura[] = []
  const fuente: Record<string, Fuente> = {}
  const s = ia ? sanear(ia) : null
  const av = (campo: string, severidad: Severidad, codigo: string, mensaje: string) =>
    avisos.push({ campo, severidad, codigo, mensaje })

  /** El QR manda; si la IA dijo otra cosa, se avisa. `igual` compara normalizado. */
  function elegir<T>(campo: string, deQr: T | null | undefined, deIa: T | null | undefined,
    igual: (a: T, b: T) => boolean, mostrar: (v: T) => string): T | null {
    const q = deQr ?? null
    const i = deIa ?? null
    if (q != null && i != null) {
      if (igual(q, i)) { fuente[campo] = 'qr+ia'; return q }
      fuente[campo] = 'qr'
      // Error y no advertencia: en la prueba con facturas reales (24/09) hubo
      // un QR con el número truncado (00000462 impreso 00004620). Cuál está
      // bien lo decide la persona mirando el papel.
      avisos.push({ campo, severidad: 'error', codigo: 'QR_DISTINTO_DE_LECTURA', alternativa: i as unknown as string | number,
        mensaje: `El QR de ARCA dice ${mostrar(q)} y en el papel se lee ${mostrar(i)}: se tomó el QR. Confirmalo contra el papel.` })
      return q
    }
    if (q != null) { fuente[campo] = 'qr'; return q }
    if (i != null) { fuente[campo] = 'ia'; return i }
    return null
  }
  const mismo = <T,>(a: T, b: T) => a === b
  const mismoNum = (a: number, b: number) => cuadra(a, b)
  const id = <T,>(v: T) => String(v)

  const emisor_cuit = elegir('emisor_cuit', qr?.cuit, s?.emisor_cuit, mismo, id)
  const receptorQr = qr && qr.tipoDocRec === 80 ? qr.nroDocRec : null
  const receptor_cuit = elegir('receptor_cuit', receptorQr, s?.receptor_cuit, mismo, id)
  const cbte_tipo_arca = elegir('cbte_tipo_arca', qr?.tipoCmp, s?.cbte, mismo, (v) => NOMBRE_CBTE[v] ?? `código ${v}`)
  const punto_venta = elegir('punto_venta', qr ? fmtPuntoVenta(qr.ptoVta) : null, s?.punto_venta,
    (a, b) => Number(a) === Number(b), (v) => v)
  const numero_comprobante = elegir('numero_comprobante', qr ? fmtNumeroCbte(qr.nroCmp) : null, s?.numero,
    (a, b) => Number(a) === Number(b), (v) => v)
  const fecha = elegir('fecha', qr?.fecha, s?.fecha, mismo, fmtF)
  // El importe del QR viene mal armado seguido (prueba del 24/09: 3 de 8 QR
  // reales): Cencosud y ABC lo mandan en CENTAVOS (15260959 = $152.609,59).
  // Si el QR ÷ 100 es lo que dice el papel, era eso. Y si aun así no
  // coinciden pero el desglose leído cierra contra el total del papel y no
  // contra el del QR, manda el papel: esa diferencia sí se puede verificar.
  let qrTotal = qr?.importe ?? null
  if (qr && s?.total != null && !cuadra(qr.importe, s.total) && cuadra(qr.importe / 100, s.total)) {
    qrTotal = aCentavos(qr.importe / 100)
    av('total', 'info', 'QR_IMPORTE_EN_CENTAVOS', 'El QR del emisor trae el importe en centavos: se corrigió con el total impreso.')
  }
  let total: number | null
  const sumaPapel = s ? sumaCentavos([
    s.iva.length ? sumaCentavos(s.iva.map((f) => f.base_imp)) : (s.neto ?? 0), s.no_gravado ?? 0, s.exento ?? 0,
    ...s.iva.map((f) => f.importe), ...s.tributos.map((t) => t.importe)]) : null
  if (qrTotal != null && s?.total != null && sumaPapel != null && !cuadra(qrTotal, s.total)
      && cuadra(sumaPapel, s.total) && !cuadra(sumaPapel, qrTotal)) {
    total = s.total
    fuente.total = 'ia'
    av('total', 'error', 'QR_TOTAL_NO_CIERRA',
      `El QR dice ${fmtM(qrTotal)} pero el papel dice ${fmtM(s.total)} y su desglose cierra con el papel: se tomó el papel. Confirmalo.`)
  } else {
    total = elegir('total', qrTotal, s?.total, mismoNum, fmtM)
  }
  const cae = elegir('cae', qr?.codAut && qr.codAut.length === 14 ? qr.codAut : null, s?.cae, mismo, id)

  // Punto de venta con el ancho que traía el papel si coincide con el QR
  // ("0012" y no "00012"): así el número queda como lo tipearía la persona.
  const pvFinal = punto_venta && s?.punto_venta && Number(s.punto_venta) === Number(punto_venta)
    ? (ia?.punto_venta ? soloDigitos(ia.punto_venta) || punto_venta : punto_venta)
    : punto_venta
  const nroFinal = numero_comprobante && s?.numero && Number(s.numero) === Number(numero_comprobante)
    ? (ia?.numero ? soloDigitos(ia.numero) || numero_comprobante : numero_comprobante)
    : numero_comprobante

  // Lo que sólo trae la IA.
  const soloIa = <K extends string>(campo: K, v: unknown) => { if (v != null) fuente[campo] = 'ia'; return v }
  const emisor_razon_social = soloIa('emisor_razon_social', s?.emisor_razon_social) as string | null ?? null
  const vence_el = soloIa('vence_el', s?.vence) as string | null ?? null
  const cae_vto = soloIa('cae_vto', s?.cae_vto) as string | null ?? null
  const neto = soloIa('neto', s?.neto) as number | null ?? null
  const no_gravado = soloIa('no_gravado', s?.no_gravado) as number | null ?? null
  const exento = soloIa('exento', s?.exento) as number | null ?? null
  const iva = s?.iva ?? []
  const tributos = s?.tributos ?? []
  if (iva.length) fuente.iva = 'ia'
  if (tributos.length) fuente.tributos = 'ia'
  const moneda = qr?.moneda ?? s?.moneda ?? null
  const cotizacion = qr?.ctz ?? null

  const tipoInfo = tipoDesdeArca(cbte_tipo_arca)
  let tipo_comprobante: TipoComprobante | null = tipoInfo?.tipo ?? null
  if (!tipo_comprobante && s?.letra && ['A', 'B', 'C'].includes(s.letra)) tipo_comprobante = s.letra as TipoComprobante
  if (!tipo_comprobante && s?.letra === 'M') tipo_comprobante = 'A'
  if (!tipo_comprobante && s?.clase === 'ticket') tipo_comprobante = 'ticket'
  if (tipo_comprobante) fuente.tipo_comprobante = fuente.cbte_tipo_arca ?? 'ia'

  // Neto gravado: si hay alícuotas, es la suma de sus bases (así lo guarda la base).
  const netoGravado = iva.length ? sumaCentavos(iva.map((f) => f.base_imp)) : neto
  if (iva.length && neto != null && !cuadra(neto, netoGravado ?? 0)) {
    av('iva', 'advertencia', 'NETO_DISTINTO_DE_BASES',
      `El neto gravado leído (${fmtM(neto)}) no coincide con la suma de las bases por alícuota (${fmtM(netoGravado ?? 0)}).`)
  }

  // ── Controles de la lectura ──────────────────────────────────────────────
  if (!qr) av('qr', 'info', 'SIN_QR', 'No se encontró el QR de ARCA: todo sale de la lectura del papel. Revisalo.')
  if (!ia) av('ia', 'advertencia', 'SIN_LECTURA_IA', 'No se pudo leer el detalle del comprobante: el IVA y las percepciones van a mano.')
  if (s && !s.legible) av('ia', 'advertencia', 'ILEGIBLE', 'El comprobante se lee con dificultad: revisá cada dato contra el papel.')
  if (s?.notas) av('ia', 'info', 'NOTA_LECTURA', s.notas)
  for (const p of s?.ivaNoReconocido ?? []) {
    av('iva', 'advertencia', 'ALICUOTA_DESCONOCIDA', `Se leyó un IVA al ${p} %, que no es una alícuota vigente: cargalo a mano.`)
  }

  // Desde el 2026-09-25 una NC se carga como comprobante (clase
  // 'nota_credito'): el aviso es informativo, no un error.
  const esNc = !!tipoInfo?.esNotaCredito
  if (esNc) {
    av('tipo_comprobante', 'info', 'ES_NOTA_DE_CREDITO',
      'Es una nota de crédito: se carga como NC, con su desglose, y se indica a qué factura(s) acredita (o queda como crédito a favor).')
  }
  if (cbte_tipo_arca != null && !tipoInfo) {
    av('tipo_comprobante', 'advertencia', 'TIPO_DESCONOCIDO', `El comprobante es de un tipo que el módulo no reconoce (código ${cbte_tipo_arca}).`)
  }

  if (emisor_cuit && !cuitValido(emisor_cuit)) {
    av('emisor_cuit', 'advertencia', 'CUIT_EMISOR_INVALIDO', `El CUIT del emisor (${emisor_cuit}) no tiene un dígito verificador válido.`)
  }
  if (receptor_cuit && receptor_cuit !== CUIT_CADINC) {
    av('receptor_cuit', 'error', 'RECEPTOR_NO_ES_CADINC',
      `La factura está hecha a otro CUIT (${receptor_cuit}), no a CADINC (${CUIT_CADINC}). No sirve como crédito fiscal.`)
  } else if (!receptor_cuit && (tipo_comprobante === 'A')) {
    av('receptor_cuit', 'advertencia', 'RECEPTOR_NO_LEIDO', 'No se pudo confirmar que la factura esté hecha a CADINC.')
  }
  if (tipo_comprobante === 'A' && iva.length === 0 && ia) {
    av('iva', 'advertencia', 'A_SIN_IVA', 'Es una factura A pero no se leyó IVA discriminado.')
  }
  if ((tipo_comprobante === 'B' || tipo_comprobante === 'C') && iva.length > 0) {
    av('iva', 'advertencia', 'BC_CON_IVA', `Una factura ${tipo_comprobante} no discrimina IVA y se leyó IVA: revisalo.`)
  }
  if (moneda && moneda !== 'PES') {
    av('moneda', 'advertencia', 'MONEDA_EXTRANJERA',
      `El comprobante está en ${moneda}${cotizacion ? ` (cotización ${cotizacion})` : ''}: el módulo carga pesos.`)
  }
  if (fecha && fecha > opts.hoy) av('fecha', 'error', 'FECHA_FUTURA', `La fecha de emisión (${fmtF(fecha)}) es posterior a hoy.`)
  if (vence_el && fecha && vence_el < fecha) {
    av('vence_el', 'advertencia', 'VENCE_ANTES', 'El vencimiento leído es anterior a la emisión: se descartó.')
  }

  // Cada alícuota: importe ≈ base × %. Tolerancia de $1 o 0,5 %.
  for (const f of iva) {
    const pct = ALICUOTAS[f.alicuota_id] ?? 0
    const esperado = aCentavos(f.base_imp * pct / 100)
    if (Math.abs(esperado - f.importe) > Math.max(1, esperado * 0.005)) {
      av('iva', 'advertencia', 'IVA_NO_CUADRA_CON_BASE',
        `IVA ${pct} %: sobre ${fmtM(f.base_imp)} daría ${fmtM(esperado)} y se leyó ${fmtM(f.importe)}.`)
    }
  }

  // Cierre contra el total.
  const perc = sumaCentavos(tributos.filter((t) => esPercepcion(t.tipo)).map((t) => t.importe))
  const otros = sumaCentavos(tributos.filter((t) => !esPercepcion(t.tipo)).map((t) => t.importe))
  const ivaTot = sumaCentavos(iva.map((f) => f.importe))
  if (total != null && (netoGravado != null || iva.length || tributos.length)) {
    const suma = sumaCentavos([netoGravado ?? 0, no_gravado ?? 0, exento ?? 0, ivaTot, perc, otros])
    if (!cuadra(suma, total)) {
      av('total', 'error', 'NO_CIERRA',
        `Neto + no gravado + exento + IVA + percepciones da ${fmtM(suma)} y el total es ${fmtM(total)} (diferencia ${fmtM(aCentavos(total - suma))}).`)
    }
  }
  if (total == null) av('total', 'error', 'SIN_TOTAL', 'No se pudo leer el total.')

  const hayQr = !!qr
  const hayIa = !!ia
  const estado = hayQr && hayIa ? 'qr+ia' : hayQr ? 'qr' : hayIa ? 'ia' : 'manual'

  return {
    propuesta: {
      emisor_cuit, emisor_razon_social, receptor_cuit, cbte_tipo_arca, tipo_comprobante,
      punto_venta: pvFinal, numero_comprobante: nroFinal,
      fecha, vence_el: vence_el && fecha && vence_el < fecha ? null : vence_el,
      cae, cae_vto, moneda, cotizacion,
      neto: netoGravado, no_gravado, exento, iva, tributos, total,
      descripcion: (soloIa('descripcion', s?.descripcion) as string | null) ?? null,
      clase: esNc ? 'nota_credito' : 'factura',
      comprobantes_asociados: esNc ? (s?.asociados ?? []) : [],
    },
    fuente_por_campo: fuente,
    avisos,
    estado,
  }
}

// ── Controles que dependen de la base ───────────────────────────────────────

export interface ContextoLectura {
  /** Proveedor del padrón de Compras con ese CUIT, si existe. */
  proveedor: { id: number; razon_social: string; activo: boolean } | null
  /** Comprobantes no anulados del mismo proveedor, CLASE, tipo y número. */
  duplicadas: { id: number; numero: string | null; estado: string }[]
  /** El mismo archivo ya está adjunto como factura. */
  archivoRepetido: { factura_id: number } | null
}

export function controlesDeContexto(p: Propuesta, ctx: ContextoLectura): AvisoLectura[] {
  const out: AvisoLectura[] = []
  if (ctx.archivoRepetido) {
    out.push({ campo: 'archivo', severidad: 'error', codigo: 'ARCHIVO_YA_CARGADO',
      mensaje: `Este mismo archivo ya está cargado en la factura #${ctx.archivoRepetido.factura_id}.` })
  }
  if (ctx.duplicadas.length) {
    const d = ctx.duplicadas[0]!
    out.push({ campo: 'numero_comprobante', severidad: 'error', codigo: 'FACTURA_YA_CARGADA',
      mensaje: `${p.clase === 'nota_credito' ? 'Esta nota de crédito' : 'Esta factura'} ya está cargada (#${d.id}, ${d.estado}).` })
  }
  if (p.emisor_cuit && !ctx.proveedor) {
    out.push({ campo: 'proveedor', severidad: 'advertencia', codigo: 'PROVEEDOR_NUEVO',
      mensaje: `El proveedor ${p.emisor_razon_social ?? ''} (CUIT ${p.emisor_cuit}) no está en el padrón de Compras: se propone darlo de alta.`.replace('  ', ' ') })
  }
  if (ctx.proveedor && !ctx.proveedor.activo) {
    out.push({ campo: 'proveedor', severidad: 'error', codigo: 'PROVEEDOR_INACTIVO',
      mensaje: `${ctx.proveedor.razon_social} está dado de baja en el padrón: reactivalo antes de cargarle una factura.` })
  }
  if (!p.emisor_cuit) {
    out.push({ campo: 'proveedor', severidad: 'advertencia', codigo: 'SIN_CUIT_EMISOR',
      mensaje: 'No se pudo leer el CUIT del emisor: elegí el proveedor a mano.' })
  }
  return out
}
