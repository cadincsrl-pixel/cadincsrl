/**
 * Transporte SOAP contra ARCA: un POST con timeout y la clasificación de la
 * falla en "no llegó" / "no sé si llegó" (ver `errores.ts`).
 *
 * TLS: WSFE de producción (servicios1.afip.gov.ar) negocia un Diffie-Hellman
 * de 1024 bits y el OpenSSL de Node moderno lo rechaza con
 * `ERR_SSL_DH_KEY_TOO_SMALL` (verificado 2026-09-23 con Node 26; homologación
 * y WSAA prod andan sin ajuste). Por eso todo lo de ARCA sale por un
 * `https.Agent` propio con `DEFAULT@SECLEVEL=1`, que acepta esa clave y sigue
 * verificando el certificado del servidor.
 *
 * NO usar el paquete `undici` acá (2026-09-23): con solo importarlo instala su
 * Agent como despachador GLOBAL del proceso, y el `fetch` nativo de Node lo
 * empieza a usar para todo. En Render (otra versión de Node que la de la Mac)
 * las dos versiones de undici no son compatibles: `jose` bajaba el JWKS de
 * Supabase, llegaba 200 y fallaba "Failed to parse the JSON Web Key Set HTTP
 * response as JSON" → 401 en /api/me/profile → NADIE podía entrar al ERP.
 * `node:https` no toca nada global.
 */
import https from 'node:https'
import { XMLParser } from 'fast-xml-parser'
import { ArcaError, codigoDeRed, fallaAntesDeEnviar } from './errores.js'

export const ARCA_TIMEOUT_MS = 40_000

const agent = new https.Agent({ ciphers: 'DEFAULT@SECLEVEL=1', keepAlive: true, keepAliveMsecs: 10_000 })

/** Error de red con la fase en que ocurrió: antes de la respuesta o leyéndola. */
export class FallaHttp extends Error {
  constructor(readonly fase: 'conexion' | 'lectura', readonly causa: unknown, readonly status?: number) {
    super(causa instanceof Error ? causa.message : String(causa))
  }
}

/** POST con node:https. Resuelve con status y cuerpo; rechaza con FallaHttp. */
function postHttps(url: string, headers: Record<string, string>, body: string, signal: AbortSignal):
  Promise<{ status: number; ok: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST', agent, signal,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const status = res.statusCode ?? 0
      const partes: Buffer[] = []
      res.on('data', (c: Buffer) => partes.push(c))
      res.on('end', () => resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(partes).toString('utf8') }))
      res.on('error', (e) => reject(new FallaHttp('lectura', e, status)))
      res.on('aborted', () => reject(new FallaHttp('lectura', new Error('respuesta abortada'), status)))
    })
    req.on('error', (e) => reject(new FallaHttp('conexion', e)))
    req.setTimeout(15_000, () => req.destroy(Object.assign(new Error('timeout de conexión'), { code: 'ETIMEDOUT' })))
    req.end(body)
  })
}

/** Tags que ARCA puede devolver una o N veces: siempre como array. */
const TAGS_ARRAY = new Set([
  'Err', 'Obs', 'Evt', 'AlicIva', 'CbteAsoc', 'Tributo',
  'FECAEDetResponse', 'CondicionIvaReceptor', 'IvaTipo', 'Opcional',
  // WSFECRED
  'codigoDescripcion', 'codigoDescripcionString',
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

export type TransporteHttp = typeof postHttps
let transporte: TransporteHttp = postHttps
/** Para tests: reemplaza el POST de red. `null` vuelve a node:https. */
export function configurarTransporteHttp(t: TransporteHttp | null): void {
  transporte = t ?? postHttps
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
    let res: { status: number; ok: boolean; text: string }
    try {
      res = await transporte(opts.url, {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${opts.soapAction}"`,
      }, opts.sobre, ctrl.signal)
    } catch (f) {
      const e = f instanceof FallaHttp ? f.causa : f
      if (f instanceof FallaHttp && f.fase === 'lectura') {
        // Ya hubo status: ARCA recibió el pedido y la respuesta se cortó.
        throw ctrl.signal.aborted
          ? new ArcaError({
              tipo: 'timeout', codigo: 'ARCA_TIMEOUT', quizasLlego: true, httpStatus: f.status, cause: e,
              mensaje: `${opts.contexto}: ARCA no terminó de responder a tiempo`,
            })
          : new ArcaError({
              tipo: 'transporte', codigo: 'ARCA_RESPUESTA_CORTADA', quizasLlego: true, httpStatus: f.status, cause: e,
              mensaje: `${opts.contexto}: se cortó la respuesta de ARCA`,
            })
      }
      throw errorDeRed(e, ctrl.signal.aborted, opts.contexto, timeoutMs)
    }
    const xml = res.text
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
