/**
 * Transporte SOAP contra ARCA: un POST con timeout y la clasificación de la
 * falla en "no llegó" / "no sé si llegó" (ver `errores.ts`).
 *
 * TLS: WSFE de producción (servicios1.afip.gov.ar) negocia un Diffie-Hellman
 * de 1024 bits y el OpenSSL de Node moderno lo rechaza con
 * `ERR_SSL_DH_KEY_TOO_SMALL` (verificado 2026-09-23 con Node 26; homologación
 * y WSAA prod andan sin ajuste). Por eso todo lo de ARCA sale por un Agent de
 * undici con `DEFAULT@SECLEVEL=1`, que acepta esa clave y sigue verificando
 * el certificado del servidor. Se usa el `fetch` del paquete undici y no el
 * global para que Agent y fetch sean de la misma versión.
 */
import { Agent, fetch as undiciFetch } from 'undici'
import { XMLParser } from 'fast-xml-parser'
import { ArcaError, codigoDeRed, fallaAntesDeEnviar } from './errores.js'

export const ARCA_TIMEOUT_MS = 40_000

const agent = new Agent({
  connect: { ciphers: 'DEFAULT@SECLEVEL=1', timeout: 15_000 },
  keepAliveTimeout: 10_000,
})

/** Tags que ARCA puede devolver una o N veces: siempre como array. */
const TAGS_ARRAY = new Set([
  'Err', 'Obs', 'Evt', 'AlicIva', 'CbteAsoc', 'Tributo',
  'FECAEDetResponse', 'CondicionIvaReceptor', 'IvaTipo',
])

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Todo queda como string: el CAE (14 dígitos) y el token no se tocan.
  parseTagValue: false,
  trimValues: true,
  isArray: (nombre) => TAGS_ARRAY.has(nombre),
})

export type XmlNodo = Record<string, unknown>

export function parsearXml(xml: string): XmlNodo {
  return parser.parse(xml) as XmlNodo
}

export function nodo(v: unknown): XmlNodo | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as XmlNodo) : undefined
}

export function texto(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

export function lista(v: unknown): XmlNodo[] {
  if (Array.isArray(v)) return v.filter((x): x is XmlNodo => !!nodo(x))
  const n = nodo(v)
  return n ? [n] : []
}

/**
 * Devuelve el contenido de `soap:Body`. Si trae un Fault, lanza `soap_fault`
 * con `quizasLlego=false`: ARCA contestó, y un fault no autoriza nada.
 */
export function cuerpoSoap(xml: string, contexto: string, httpStatus?: number): XmlNodo {
  let doc: XmlNodo
  try {
    doc = parsearXml(xml)
  } catch (e) {
    throw new ArcaError({
      tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: true, httpStatus, cause: e,
      mensaje: `${contexto}: ARCA respondió algo que no es XML válido`,
    })
  }
  const body = nodo(nodo(doc.Envelope)?.Body)
  if (!body) {
    throw new ArcaError({
      tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: true, httpStatus,
      mensaje: `${contexto}: la respuesta de ARCA no trae un sobre SOAP (HTTP ${httpStatus ?? '?'})`,
    })
  }
  const fault = nodo(body.Fault)
  if (fault) {
    const faultcode = texto(fault.faultcode).replace(/^[^:]*:/, '')
    const faultstring = texto(fault.faultstring)
    throw new ArcaError({
      tipo: 'soap_fault', codigo: 'ARCA_SOAP_FAULT', quizasLlego: false, httpStatus, faultcode,
      mensaje: `${contexto}: ARCA respondió un error (${faultcode || 'sin código'}): ${faultstring || 'sin detalle'}`,
    })
  }
  return body
}

/**
 * POST SOAP. Devuelve el texto de la respuesta si hubo respuesta HTTP (aunque
 * sea 500: los SOAP Fault vienen con 500 y los interpreta quien llama).
 */
export async function postSoap(opts: {
  url: string
  soapAction: string
  sobre: string
  contexto: string
  timeoutMs?: number
}): Promise<{ status: number; xml: string }> {
  const ctrl = new AbortController()
  const timeoutMs = opts.timeoutMs ?? ARCA_TIMEOUT_MS
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Awaited<ReturnType<typeof undiciFetch>>
    try {
      res = await undiciFetch(opts.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"${opts.soapAction}"`,
        },
        body: opts.sobre,
        signal: ctrl.signal,
        dispatcher: agent,
      })
    } catch (e) {
      throw errorDeRed(e, ctrl.signal.aborted, opts.contexto, timeoutMs)
    }
    let xml: string
    try {
      xml = await res.text()
    } catch (e) {
      // Ya hubo status: ARCA recibió el pedido y la respuesta se cortó.
      throw ctrl.signal.aborted
        ? new ArcaError({
            tipo: 'timeout', codigo: 'ARCA_TIMEOUT', quizasLlego: true, httpStatus: res.status, cause: e,
            mensaje: `${opts.contexto}: ARCA no terminó de responder a tiempo`,
          })
        : new ArcaError({
            tipo: 'transporte', codigo: 'ARCA_RESPUESTA_CORTADA', quizasLlego: true, httpStatus: res.status, cause: e,
            mensaje: `${opts.contexto}: se cortó la respuesta de ARCA`,
          })
    }
    const esSoap = /<(\w+:)?Envelope[\s>]/.test(xml)
    if (!res.ok && !esSoap) {
      // 502/503 de un balanceador: no se sabe si el servicio de atrás lo procesó.
      throw new ArcaError({
        tipo: 'transporte', codigo: 'ARCA_HTTP_ERROR', quizasLlego: res.status >= 500, httpStatus: res.status,
        mensaje: `${opts.contexto}: ARCA respondió HTTP ${res.status}`,
      })
    }
    return { status: res.status, xml }
  } finally {
    clearTimeout(timer)
  }
}

function errorDeRed(e: unknown, abortadoPorTimeout: boolean, contexto: string, timeoutMs: number): ArcaError {
  const code = codigoDeRed(e)
  if (abortadoPorTimeout) {
    return new ArcaError({
      tipo: 'timeout', codigo: 'ARCA_TIMEOUT', quizasLlego: true, cause: e,
      mensaje: `${contexto}: ARCA no respondió en ${Math.round(timeoutMs / 1000)} s`,
    })
  }
  const antes = fallaAntesDeEnviar(code)
  return new ArcaError({
    tipo: 'transporte',
    codigo: antes ? 'ARCA_SIN_CONEXION' : 'ARCA_CONEXION_CORTADA',
    quizasLlego: !antes,
    cause: e,
    mensaje: antes
      ? `${contexto}: no se pudo conectar con ARCA (${code})`
      : `${contexto}: se cortó la conexión con ARCA (${code ?? 'sin código'}); puede haber llegado`,
  })
}

/** Escapa texto para meterlo en un elemento XML. */
export function xmlEsc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
