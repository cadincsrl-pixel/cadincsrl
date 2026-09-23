/**
 * Errores de la conexión con ARCA (ex AFIP), 2026-09-23.
 *
 * La pregunta que importa cuando algo falla NO es "qué pasó" sino
 * "¿ARCA pudo haber autorizado el comprobante igual?". Eso es `quizasLlego`:
 *
 * - `quizasLlego = false` → ARCA seguro NO procesó el pedido (no se pudo
 *   conectar, el TLS no cerró, faltaba configuración, o ARCA contestó con un
 *   rechazo / SOAP fault). Reintentar es seguro.
 * - `quizasLlego = true`  → el pedido pudo haber salido y ARCA pudo haberlo
 *   autorizado, pero la respuesta no llegó entera (timeout, corte a mitad,
 *   un 502 del balanceador, una respuesta que no se puede leer). NO se
 *   reintenta a ciegas: hay que reconciliar con `FECompConsultar` antes de
 *   volver a pedir el mismo número.
 *
 * Nunca meter en `message` ni en `detalle` el certificado, la clave, el token
 * ni el sign.
 */

export type TipoArcaError = 'rechazo' | 'transporte' | 'timeout' | 'soap_fault' | 'config'

export interface ErrArca {
  code: number
  msg: string
}

export class ArcaError extends Error {
  readonly tipo: TipoArcaError
  /** Código estable para el frontend y los logs (ej. ARCA_NO_CONFIGURADO). */
  readonly codigo: string
  /** true = pudo haber llegado a ARCA: reconciliar antes de reintentar. */
  readonly quizasLlego: boolean
  /** Errores de negocio devueltos por ARCA (`Errors/Err`), si los hubo. */
  readonly errores: ErrArca[]
  /** Status HTTP de la respuesta, si hubo respuesta. */
  readonly httpStatus?: number
  /** `faultcode` del SOAP Fault, sin prefijo de namespace (ej. coe.alreadyAuthenticated). */
  readonly faultcode?: string

  constructor(opts: {
    tipo: TipoArcaError
    codigo: string
    mensaje: string
    quizasLlego?: boolean
    errores?: ErrArca[]
    httpStatus?: number
    faultcode?: string
    cause?: unknown
  }) {
    super(opts.mensaje, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ArcaError'
    this.tipo = opts.tipo
    this.codigo = opts.codigo
    this.quizasLlego = opts.quizasLlego ?? false
    this.errores = opts.errores ?? []
    this.httpStatus = opts.httpStatus
    this.faultcode = opts.faultcode
  }
}

export function esArcaError(e: unknown): e is ArcaError {
  return e instanceof ArcaError
}

/**
 * Códigos de error de red que se producen ANTES de mandar un solo byte del
 * pedido: DNS, conexión rechazada, timeout de conexión, handshake TLS. Con
 * cualquiera de estos, ARCA no vio el pedido.
 */
const CODIGOS_ANTES_DE_ENVIAR = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/** Busca el `code` de red en la cadena de causes (undici lo anida). */
export function codigoDeRed(e: unknown): string | undefined {
  let actual: unknown = e
  for (let i = 0; i < 5 && actual && typeof actual === 'object'; i++) {
    const code = (actual as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
    actual = (actual as { cause?: unknown }).cause
  }
  return undefined
}

export function fallaAntesDeEnviar(code: string | undefined): boolean {
  if (!code) return false
  if (CODIGOS_ANTES_DE_ENVIAR.has(code)) return true
  // ERR_SSL_* (ej. ERR_SSL_DH_KEY_TOO_SMALL) es siempre del handshake.
  return code.startsWith('ERR_SSL_')
}
