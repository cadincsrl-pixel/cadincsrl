/**
 * WSFEv1: factura electrónica contra ARCA (2026-09-23).
 *
 * Sobres SOAP escritos a mano (namespace `http://ar.gov.afip.dif.FEV1/`).
 * El orden de los elementos sigue el WSDL: el servicio es .NET y un elemento
 * fuera de orden se IGNORA en silencio, no da error.
 *
 * Reglas:
 * - En el `Auth` va SIEMPRE el CUIT de CADINC (`ARCA_CUIT`), nunca el del
 *   certificado.
 * - `solicitarCAE` pide UN comprobante por llamada. ARCA no asigna el número:
 *   se manda el que corresponde (último autorizado + 1). Si la llamada falla
 *   con `quizasLlego = true`, antes de reintentar hay que mirar
 *   `consultarComprobante` con ese mismo número.
 * - Un rechazo (Resultado R) NO lanza: vuelve como `{ resultado: 'R' }` con
 *   los errores y observaciones de ARCA. Lanza solo lo que no es una
 *   respuesta de negocio (transporte, timeout, SOAP fault, respuesta ilegible).
 */
import { arcaConfig, type ArcaConfig } from './config.js'
import { ArcaError, type ErrArca } from './errores.js'
import { cuerpoSoap, lista, nodo, postSoap, texto, xmlEsc, type XmlNodo } from './soap.js'
import { obtenerTA, type TicketAcceso } from './wsaa.js'

const NS = 'http://ar.gov.afip.dif.FEV1/'

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface AlicuotaIva {
  /** Id de ARCA: 3 = 0%, 4 = 10,5%, 5 = 21%, 6 = 27%, 8 = 5%, 9 = 2,5%. */
  id: number
  baseImp: number
  importe: number
}

export interface ComprobanteAsociado {
  tipo: number
  ptoVta: number
  nro: number
  /** CUIT del emisor del comprobante asociado (el de CADINC). */
  cuit?: string
  /** yyyymmdd o yyyy-mm-dd. */
  cbteFch?: string
}

/**
 * Dato opcional de FECAESolicitar (`Opcionales/Opcional`). Los de la FCE
 * MiPyME (manual WSFEv1): 2101 CBU del emisor, 2102 alias, 27 opción de
 * transferencia (SCA | ADC), 23 referencia comercial, 22 «es anulación»
 * (S | N) en las NC/ND FCE.
 */
export interface Opcional {
  id: string
  valor: string
}

/** Tipos FCE MiPyME que son nota de débito o crédito: NO llevan FchVtoPago ni CBU. */
export const TIPOS_NC_ND_FCE = new Set([202, 203, 207, 208, 212, 213])

export interface ComprobanteSolicitud {
  ptoVta: number
  cbteTipo: number
  /** El número a autorizar (último autorizado + 1). */
  numero: number
  /** 1 productos, 2 servicios, 3 productos y servicios. */
  concepto: 1 | 2 | 3
  /** 80 CUIT, 86 CUIL, 96 DNI, 99 sin identificar. */
  docTipo: number
  docNro: string | number
  /** yyyymmdd o yyyy-mm-dd. */
  cbteFch: string
  impTotal: number
  impTotConc: number
  impNeto: number
  impOpEx: number
  impTrib: number
  impIva: number
  /** Obligatorias con concepto 2 y 3. yyyymmdd o yyyy-mm-dd. */
  fchServDesde?: string
  fchServHasta?: string
  fchVtoPago?: string
  /** Default 'PES'. */
  monId?: string
  /** Default 1. */
  monCotiz?: number
  /** Condición frente al IVA del receptor (FEParamGetCondicionIvaReceptor). Se manda siempre. */
  condicionIvaReceptorId: number
  iva?: AlicuotaIva[]
  cbtesAsoc?: ComprobanteAsociado[]
  opcionales?: Opcional[]
}

export interface ResultadoCAE {
  resultado: 'A' | 'R'
  numero: number
  /** Solo con resultado A. */
  cae: string | null
  /** yyyymmdd. Solo con resultado A. */
  caeVto: string | null
  /** Fecha y hora de proceso de ARCA (yyyymmddhhmmss), si vino. */
  fchProceso: string | null
  observaciones: ErrArca[]
  errores: ErrArca[]
  eventos: ErrArca[]
}

export interface UltimoAutorizado {
  ptoVta: number
  cbteTipo: number
  numero: number
}

export interface ComprobanteConsultado {
  ptoVta: number
  cbteTipo: number
  numero: number
  concepto: number
  docTipo: number
  docNro: string
  cbteFch: string
  impTotal: number
  impTotConc: number
  impNeto: number
  impOpEx: number
  impTrib: number
  impIva: number
  monId: string
  monCotiz: number
  condicionIvaReceptorId: number | null
  /** 'A' aprobado, 'R' rechazado. */
  resultado: string
  /** El CAE. */
  codAutorizacion: string
  /** 'CAE' o 'CAEA'. */
  emisionTipo: string
  /** Vencimiento del CAE, yyyymmdd. */
  fchVto: string
  fchProceso: string
  iva: AlicuotaIva[]
  cbtesAsoc: ComprobanteAsociado[]
  opcionales: Opcional[]
  observaciones: ErrArca[]
}

export interface CondicionIvaReceptor {
  id: number
  descripcion: string
  /** 'A', 'B', 'C', 'M' o 'A/M/C'. */
  clase: string
}

export interface TipoIva {
  id: number
  descripcion: string
  fchDesde: string
  fchHasta: string
}

export interface EstadoServidores {
  appServer: string
  dbServer: string
  authServer: string
}

export interface OpcionesWsfe {
  config?: ArcaConfig
  /** Para scripts/tests; si no, `obtenerTA('wsfe')`. */
  ta?: TicketAcceso
}

// ─── Traza de XML (para ventas_facturas_arca_log) ────────────────────────────

/**
 * Recibe cada intercambio con WSFE. El pedido llega con Token y Sign
 * reemplazados por `***`. Un error adentro del callback no afecta la llamada.
 */
export type TrazaXml = (t: {
  metodo: string
  pedido: string
  respuesta: string | null
  httpStatus: number | null
  /** Milisegundos desde que salió el pedido hasta la respuesta o la falla. */
  duracionMs?: number
  /** Código y mensaje del ArcaError si la llamada falló en el transporte. */
  error?: string | null
}) => void

let traza: TrazaXml | null = null
export function configurarTrazaXml(fn: TrazaXml | null): void {
  traza = fn
}

export function redactarAuth(xml: string): string {
  return xml
    .replace(/(<(?:\w+:)?Token>)[\s\S]*?(<\/(?:\w+:)?Token>)/g, '$1***$2')
    .replace(/(<(?:\w+:)?Sign>)[\s\S]*?(<\/(?:\w+:)?Sign>)/g, '$1***$2')
}

// ─── Armado de sobres ────────────────────────────────────────────────────────

/** yyyymmdd desde yyyymmdd o yyyy-mm-dd. */
export function fechaArca(s: string, campo: string): string {
  const limpio = s.trim().replace(/-/g, '')
  if (!/^\d{8}$/.test(limpio)) {
    throw new ArcaError({
      tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO',
      mensaje: `${campo}: fecha inválida (se espera yyyymmdd o yyyy-mm-dd)`,
    })
  }
  return limpio
}

function importe(n: number, campo: string): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: `${campo}: importe inválido` })
  }
  return (Math.round(n * 100) / 100).toFixed(2)
}

function entero(n: number, campo: string): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: `${campo}: tiene que ser un entero` })
  }
  return String(n)
}

const el = (nombre: string, valor: string) => `<ar:${nombre}>${valor}</ar:${nombre}>`

function sobre(contenido: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">` +
    `<soap:Header/><soap:Body>${contenido}</soap:Body></soap:Envelope>`
  )
}

function auth(ta: TicketAcceso, cuit: string): string {
  return `<ar:Auth>${el('Token', xmlEsc(ta.token))}${el('Sign', xmlEsc(ta.sign))}${el('Cuit', xmlEsc(cuit))}</ar:Auth>`
}

/** El sobre de FECAESolicitar. Exportado para tests. */
export function sobreFECAESolicitar(ta: TicketAcceso, cuit: string, c: ComprobanteSolicitud): string {
  const docNro = String(c.docNro).replace(/\D/g, '')
  if (!docNro) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: 'DocNro vacío' })
  }
  // Las NC/ND de FCE no llevan vencimiento de pago (manual WSFEv1).
  const ncFce = TIPOS_NC_ND_FCE.has(c.cbteTipo)
  if (c.concepto !== 1 && (!c.fchServDesde || !c.fchServHasta || (!c.fchVtoPago && !ncFce))) {
    throw new ArcaError({
      tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO',
      mensaje: 'Con concepto 2 o 3 ARCA exige FchServDesde, FchServHasta y FchVtoPago',
    })
  }
  if (c.cbteTipo === 201 && !c.fchVtoPago) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: 'La FCE (201) exige FchVtoPago' })
  }
  const cotiz = c.monCotiz ?? 1
  if (!Number.isFinite(cotiz) || cotiz <= 0) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: 'MonCotiz inválida' })
  }

  const asoc = (c.cbtesAsoc ?? []).map((a, i) =>
    '<ar:CbteAsoc>' +
    el('Tipo', entero(a.tipo, `CbtesAsoc[${i}].Tipo`)) +
    el('PtoVta', entero(a.ptoVta, `CbtesAsoc[${i}].PtoVta`)) +
    el('Nro', entero(a.nro, `CbtesAsoc[${i}].Nro`)) +
    (a.cuit ? el('Cuit', xmlEsc(a.cuit.replace(/\D/g, ''))) : '') +
    (a.cbteFch ? el('CbteFch', fechaArca(a.cbteFch, `CbtesAsoc[${i}].CbteFch`)) : '') +
    '</ar:CbteAsoc>').join('')

  const iva = (c.iva ?? []).map((a, i) =>
    '<ar:AlicIva>' +
    el('Id', entero(a.id, `Iva[${i}].Id`)) +
    el('BaseImp', importe(a.baseImp, `Iva[${i}].BaseImp`)) +
    el('Importe', importe(a.importe, `Iva[${i}].Importe`)) +
    '</ar:AlicIva>').join('')

  const opcionales = (c.opcionales ?? []).map((o, i) => {
    if (!o.id || !String(o.valor ?? '').trim()) {
      throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: `Opcionales[${i}]: Id y Valor obligatorios` })
    }
    return `<ar:Opcional>${el('Id', xmlEsc(o.id))}${el('Valor', xmlEsc(String(o.valor).trim()))}</ar:Opcional>`
  }).join('')

  // Orden de FEDetRequest en el WSDL (Iva va antes que Opcionales).
  const det =
    el('Concepto', entero(c.concepto, 'Concepto')) +
    el('DocTipo', entero(c.docTipo, 'DocTipo')) +
    el('DocNro', docNro) +
    el('CbteDesde', entero(c.numero, 'CbteDesde')) +
    el('CbteHasta', entero(c.numero, 'CbteHasta')) +
    el('CbteFch', fechaArca(c.cbteFch, 'CbteFch')) +
    el('ImpTotal', importe(c.impTotal, 'ImpTotal')) +
    el('ImpTotConc', importe(c.impTotConc, 'ImpTotConc')) +
    el('ImpNeto', importe(c.impNeto, 'ImpNeto')) +
    el('ImpOpEx', importe(c.impOpEx, 'ImpOpEx')) +
    el('ImpTrib', importe(c.impTrib, 'ImpTrib')) +
    el('ImpIVA', importe(c.impIva, 'ImpIVA')) +
    (c.fchServDesde ? el('FchServDesde', fechaArca(c.fchServDesde, 'FchServDesde')) : '') +
    (c.fchServHasta ? el('FchServHasta', fechaArca(c.fchServHasta, 'FchServHasta')) : '') +
    (c.fchVtoPago ? el('FchVtoPago', fechaArca(c.fchVtoPago, 'FchVtoPago')) : '') +
    el('MonId', xmlEsc(c.monId ?? 'PES')) +
    el('MonCotiz', String(cotiz)) +
    el('CondicionIVAReceptorId', entero(c.condicionIvaReceptorId, 'CondicionIVAReceptorId')) +
    (asoc ? `<ar:CbtesAsoc>${asoc}</ar:CbtesAsoc>` : '') +
    (iva ? `<ar:Iva>${iva}</ar:Iva>` : '') +
    (opcionales ? `<ar:Opcionales>${opcionales}</ar:Opcionales>` : '')

  return sobre(
    '<ar:FECAESolicitar>' +
    auth(ta, cuit) +
    '<ar:FeCAEReq>' +
    `<ar:FeCabReq>${el('CantReg', '1')}${el('PtoVta', entero(c.ptoVta, 'PtoVta'))}${el('CbteTipo', entero(c.cbteTipo, 'CbteTipo'))}</ar:FeCabReq>` +
    `<ar:FeDetReq><ar:FECAEDetRequest>${det}</ar:FECAEDetRequest></ar:FeDetReq>` +
    '</ar:FeCAEReq>' +
    '</ar:FECAESolicitar>',
  )
}

// ─── Parseo ──────────────────────────────────────────────────────────────────

const num = (v: unknown) => Number(texto(v) || 0)

function erroresDe(n: XmlNodo | undefined, contenedor: string, item: string): ErrArca[] {
  return lista(nodo(n?.[contenedor])?.[item]).map((e) => ({ code: num(e.Code), msg: texto(e.Msg) }))
}

function resultadoDe(body: XmlNodo, metodo: string): XmlNodo {
  const r = nodo(nodo(body[`${metodo}Response`])?.[`${metodo}Result`])
  if (!r) {
    throw new ArcaError({
      tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: true,
      mensaje: `WSFE ${metodo}: la respuesta no trae ${metodo}Result`,
    })
  }
  return r
}

function lanzarSiErrores(r: XmlNodo, metodo: string): void {
  const errores = erroresDe(r, 'Errors', 'Err')
  if (errores.length) {
    throw new ArcaError({
      tipo: 'rechazo', codigo: 'ARCA_ERROR', quizasLlego: false, errores,
      mensaje: `WSFE ${metodo}: ${errores.map((e) => `${e.code} ${e.msg}`).join(' | ')}`,
    })
  }
}

export function parsearFECAESolicitar(xml: string, httpStatus?: number): ResultadoCAE {
  const r = resultadoDe(cuerpoSoap(xml, 'WSFE FECAESolicitar', httpStatus), 'FECAESolicitar')
  const cab = nodo(r.FeCabResp)
  const det = lista(nodo(r.FeDetResp)?.FECAEDetResponse)[0]
  const errores = erroresDe(r, 'Errors', 'Err')
  const eventos = erroresDe(r, 'Events', 'Evt')
  const observaciones = erroresDe(det, 'Observaciones', 'Obs')
  const resDet = texto(det?.Resultado)
  const resCab = texto(cab?.Resultado)
  const cae = texto(det?.CAE)
  const caeVto = texto(det?.CAEFchVto)

  if (resDet === 'A' || (!resDet && resCab === 'A')) {
    if (!/^\d{14}$/.test(cae) || !/^\d{8}$/.test(caeVto)) {
      // Dice aprobado pero no trae CAE legible: tratarlo como incierto.
      throw new ArcaError({
        tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: true, httpStatus,
        mensaje: 'WSFE FECAESolicitar: resultado A sin CAE o vencimiento válido',
      })
    }
    return {
      resultado: 'A', numero: num(det?.CbteDesde), cae, caeVto,
      fchProceso: texto(cab?.FchProceso) || null, observaciones, errores, eventos,
    }
  }
  if (resDet === 'R' || resCab === 'R' || errores.length) {
    return {
      resultado: 'R', numero: num(det?.CbteDesde), cae: null, caeVto: null,
      fchProceso: texto(cab?.FchProceso) || null, observaciones, errores, eventos,
    }
  }
  throw new ArcaError({
    tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: true, httpStatus,
    mensaje: `WSFE FECAESolicitar: resultado inesperado (${resDet || resCab || 'vacío'})`,
  })
}

export function parsearUltimoAutorizado(xml: string, httpStatus?: number): UltimoAutorizado {
  const r = resultadoDe(cuerpoSoap(xml, 'WSFE FECompUltimoAutorizado', httpStatus), 'FECompUltimoAutorizado')
  lanzarSiErrores(r, 'FECompUltimoAutorizado')
  const nro = texto(r.CbteNro)
  if (!/^\d+$/.test(nro)) {
    throw new ArcaError({
      tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: false, httpStatus,
      mensaje: 'WSFE FECompUltimoAutorizado: la respuesta no trae CbteNro',
    })
  }
  return { ptoVta: num(r.PtoVta), cbteTipo: num(r.CbteTipo), numero: Number(nro) }
}

/** null si ARCA dice que el comprobante no existe (error 602). */
export function parsearFECompConsultar(xml: string, httpStatus?: number): ComprobanteConsultado | null {
  const r = resultadoDe(cuerpoSoap(xml, 'WSFE FECompConsultar', httpStatus), 'FECompConsultar')
  const errores = erroresDe(r, 'Errors', 'Err')
  if (errores.some((e) => e.code === 602)) return null
  lanzarSiErrores(r, 'FECompConsultar')
  const g = nodo(r.ResultGet)
  if (!g) return null
  const condIva = texto(g.CondicionIVAReceptorId)
  return {
    ptoVta: num(g.PtoVta),
    cbteTipo: num(g.CbteTipo),
    numero: num(g.CbteDesde),
    concepto: num(g.Concepto),
    docTipo: num(g.DocTipo),
    docNro: texto(g.DocNro),
    cbteFch: texto(g.CbteFch),
    impTotal: num(g.ImpTotal),
    impTotConc: num(g.ImpTotConc),
    impNeto: num(g.ImpNeto),
    impOpEx: num(g.ImpOpEx),
    impTrib: num(g.ImpTrib),
    impIva: num(g.ImpIVA),
    monId: texto(g.MonId),
    monCotiz: num(g.MonCotiz),
    condicionIvaReceptorId: condIva ? Number(condIva) : null,
    resultado: texto(g.Resultado),
    codAutorizacion: texto(g.CodAutorizacion),
    emisionTipo: texto(g.EmisionTipo),
    fchVto: texto(g.FchVto),
    fchProceso: texto(g.FchProceso),
    iva: lista(nodo(g.Iva)?.AlicIva).map((a) => ({ id: num(a.Id), baseImp: num(a.BaseImp), importe: num(a.Importe) })),
    cbtesAsoc: lista(nodo(g.CbtesAsoc)?.CbteAsoc).map((a) => ({
      tipo: num(a.Tipo), ptoVta: num(a.PtoVta), nro: num(a.Nro),
      cuit: texto(a.Cuit) || undefined, cbteFch: texto(a.CbteFch) || undefined,
    })),
    opcionales: lista(nodo(g.Opcionales)?.Opcional).map((o) => ({ id: texto(o.Id), valor: texto(o.Valor) })),
    observaciones: erroresDe(g, 'Observaciones', 'Obs'),
  }
}

export function parsearCondicionIvaReceptor(xml: string, httpStatus?: number): CondicionIvaReceptor[] {
  const r = resultadoDe(cuerpoSoap(xml, 'WSFE FEParamGetCondicionIvaReceptor', httpStatus), 'FEParamGetCondicionIvaReceptor')
  lanzarSiErrores(r, 'FEParamGetCondicionIvaReceptor')
  return lista(nodo(r.ResultGet)?.CondicionIvaReceptor).map((c) => ({
    id: num(c.Id), descripcion: texto(c.Desc), clase: texto(c.Cmp_Clase),
  }))
}

export function parsearTiposIva(xml: string, httpStatus?: number): TipoIva[] {
  const r = resultadoDe(cuerpoSoap(xml, 'WSFE FEParamGetTiposIva', httpStatus), 'FEParamGetTiposIva')
  lanzarSiErrores(r, 'FEParamGetTiposIva')
  return lista(nodo(r.ResultGet)?.IvaTipo).map((t) => ({
    id: num(t.Id), descripcion: texto(t.Desc), fchDesde: texto(t.FchDesde), fchHasta: texto(t.FchHasta),
  }))
}

export function parsearFEDummy(xml: string, httpStatus?: number): EstadoServidores {
  const r = resultadoDe(cuerpoSoap(xml, 'WSFE FEDummy', httpStatus), 'FEDummy')
  return { appServer: texto(r.AppServer), dbServer: texto(r.DbServer), authServer: texto(r.AuthServer) }
}

// ─── Llamadas ────────────────────────────────────────────────────────────────

async function llamar(metodo: string, sobreXml: string, cfg: ArcaConfig): Promise<{ status: number; xml: string }> {
  const contexto = `WSFE ${metodo}`
  let resp: { status: number; xml: string } | null = null
  let falla: string | null = null
  const t0 = Date.now()
  try {
    resp = await postSoap({ url: cfg.urls.wsfe, soapAction: `${NS}${metodo}`, sobre: sobreXml, contexto })
    return resp
  } catch (e) {
    falla = e instanceof ArcaError ? `${e.codigo}: ${e.message}` : e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    if (traza) {
      try {
        traza({
          metodo, pedido: redactarAuth(sobreXml), respuesta: resp?.xml ?? null, httpStatus: resp?.status ?? null,
          duracionMs: Date.now() - t0, error: falla,
        })
      } catch {
        // la traza nunca tira abajo la llamada
      }
    }
  }
}

async function contexto(opts: OpcionesWsfe): Promise<{ cfg: ArcaConfig; ta: TicketAcceso }> {
  const cfg = opts.config ?? arcaConfig()
  const ta = opts.ta ?? (await obtenerTA('wsfe', { config: cfg }))
  return { cfg, ta }
}

/** Estado de los servidores de ARCA. No necesita ticket. */
export async function feDummy(opts: Pick<OpcionesWsfe, 'config'> = {}): Promise<EstadoServidores> {
  const cfg = opts.config ?? arcaConfig()
  const { status, xml } = await llamar('FEDummy', sobre('<ar:FEDummy/>'), cfg)
  return parsearFEDummy(xml, status)
}

/** Último número autorizado del talonario (0 si nunca se emitió). */
export async function ultimoAutorizado(ptoVta: number, cbteTipo: number, opts: OpcionesWsfe = {}): Promise<UltimoAutorizado> {
  const { cfg, ta } = await contexto(opts)
  const s = sobre(
    `<ar:FECompUltimoAutorizado>${auth(ta, cfg.cuit)}${el('PtoVta', entero(ptoVta, 'PtoVta'))}${el('CbteTipo', entero(cbteTipo, 'CbteTipo'))}</ar:FECompUltimoAutorizado>`,
  )
  const { status, xml } = await llamar('FECompUltimoAutorizado', s, cfg)
  return parsearUltimoAutorizado(xml, status)
}

/** Pide el CAE de UN comprobante. Un rechazo vuelve como `resultado: 'R'`, no lanza. */
export async function solicitarCAE(comprobante: ComprobanteSolicitud, opts: OpcionesWsfe = {}): Promise<ResultadoCAE> {
  const { cfg, ta } = await contexto(opts)
  const s = sobreFECAESolicitar(ta, cfg.cuit, comprobante)
  const { status, xml } = await llamar('FECAESolicitar', s, cfg)
  const r = parsearFECAESolicitar(xml, status)
  // ARCA a veces no devuelve el detalle en un rechazo de cabecera.
  return r.numero ? r : { ...r, numero: comprobante.numero }
}

/** Un comprobante ya emitido, o null si ARCA no lo tiene. Para reconciliar. */
export async function consultarComprobante(
  ptoVta: number,
  cbteTipo: number,
  numero: number,
  opts: OpcionesWsfe = {},
): Promise<ComprobanteConsultado | null> {
  const { cfg, ta } = await contexto(opts)
  const s = sobre(
    '<ar:FECompConsultar>' + auth(ta, cfg.cuit) +
    `<ar:FeCompConsReq>${el('CbteTipo', entero(cbteTipo, 'CbteTipo'))}${el('CbteNro', entero(numero, 'CbteNro'))}${el('PtoVta', entero(ptoVta, 'PtoVta'))}</ar:FeCompConsReq>` +
    '</ar:FECompConsultar>',
  )
  const { status, xml } = await llamar('FECompConsultar', s, cfg)
  return parsearFECompConsultar(xml, status)
}

/** Condiciones de IVA del receptor válidas para una clase de comprobante ('A', 'B', 'C', 'M'). */
export async function paramCondicionIvaReceptor(clase: string, opts: OpcionesWsfe = {}): Promise<CondicionIvaReceptor[]> {
  const { cfg, ta } = await contexto(opts)
  const s = sobre(
    `<ar:FEParamGetCondicionIvaReceptor>${auth(ta, cfg.cuit)}${el('ClaseCmp', xmlEsc(clase))}</ar:FEParamGetCondicionIvaReceptor>`,
  )
  const { status, xml } = await llamar('FEParamGetCondicionIvaReceptor', s, cfg)
  return parsearCondicionIvaReceptor(xml, status)
}

/** Alícuotas de IVA vigentes. */
export async function paramTiposIva(opts: OpcionesWsfe = {}): Promise<TipoIva[]> {
  const { cfg, ta } = await contexto(opts)
  const s = sobre(`<ar:FEParamGetTiposIva>${auth(ta, cfg.cuit)}</ar:FEParamGetTiposIva>`)
  const { status, xml } = await llamar('FEParamGetTiposIva', s, cfg)
  return parsearTiposIva(xml, status)
}
