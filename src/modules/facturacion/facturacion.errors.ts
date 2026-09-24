/**
 * Errores tipados de Facturación: `{ error: CODE, detail?, campo?, ...extra }`
 * con status HTTP estable (mismo patrón que Pagos: el frontend lee
 * `body.error`). `extra` lleva lo que el contrato de la API pone al lado del
 * error, p. ej. `factura` (el FJ) en 422 ARCA_RECHAZO y 202 EMISION_INCIERTA.
 *
 * Los códigos de la base salen de los `raise exception 'CODIGO'` de
 * 20260924a/c (con `detail` JSON en texto).
 */
import { ArcaError } from '../../lib/arca/index.js'

export class FacturacionHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
    public extra?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'FacturacionHttpError'
  }
}

/** 400 de validación con el campo que falló: el modal lo muestra bajo el input. */
export function errorDeCampo(code: string, campo: string, extra?: Record<string, unknown>): FacturacionHttpError {
  return new FacturacionHttpError(400, code, { campo, ...(extra ?? {}) })
}

/** Status por código. Lo que no está acá y viene de la base sale como 500 DB_ERROR. */
export const STATUS_POR_CODIGO: Readonly<Record<string, number>> = {
  // 404
  FACTURA_NO_EXISTE: 404, CLIENTE_NO_EXISTE: 404,
  // 400 — datos
  ID_INVALIDO: 400, DATOS_INVALIDOS: 400, USUARIO_REQUERIDO: 400, AMBIENTE_INVALIDO: 400, PTO_VTA_INVALIDO: 400,
  TIPO_INVALIDO: 400, TIPO_NO_HABILITADO: 400, CLIENTE_REQUERIDO: 400, PRODUCTO_INVALIDO: 400,
  OBRA_REQUERIDA: 400, OBRA_NO_EXISTE: 400, OBRA_INTERNA: 400, OBRA_DEPOSITO: 400, CONCEPTO_INVALIDO: 400,
  FECHA_FUERA_DE_RANGO: 400, FECHA_ANTERIOR_AL_ULTIMO: 400, SIN_RENGLONES: 400, RENGLON_INVALIDO: 400,
  TOTAL_CERO: 400, LETRA_INCOMPATIBLE: 400, CF_REQUIERE_IDENTIFICACION: 400, NC_SIN_FACTURA: 400, NC_FACTURA_NO_EXISTE: 400,
  NC_TIPO_NO_COINCIDE: 400, NC_OTRO_CLIENTE: 400, ASOCIADA_SOLO_NC: 400, NUMERO_INVALIDO: 400,
  RESULTADO_INVALIDO: 400, NUMERO_REQUERIDO: 400, CAE_INVALIDO: 400, CAE_VTO_REQUERIDO: 400,
  NUMERO_FINNEGANS_REQUERIDO: 400, SERVICIO_REQUERIDO: 400, SEGUNDOS_INVALIDOS: 400, TA_INVALIDO: 400,
  CUIT_INVALIDO: 400, DOC_INVALIDO: 400, CLIENTE_SIN_LETRA: 400, CONDICION_IVA_INVALIDA: 400, CLIENTE_INVALIDO: 400,
  // 400 — FCE MiPyME (fase 6)
  CORRESPONDE_FCE: 400, NO_CORRESPONDE_FCE: 400, FCE_SIN_CUENTA: 400, FCE_TRANSMISION_INVALIDA: 400,
  FCE_VTO_PAGO_INVALIDO: 400, NC_ANULACION_INVALIDA: 400, CBU_INVALIDO: 400, ALIAS_INVALIDO: 400, CUENTA_INVALIDA: 400,
  CUENTA_NO_EXISTE: 404,
  // 403
  SIN_PERMISO: 403, SIN_PERMISO_EMITIR: 403, SIN_PERMISO_REGISTRAR: 403, FORZAR_SOLO_ADMIN: 403,
  // 409 — estado
  CLIENTE_DUPLICADO: 409, CLIENTE_INACTIVO: 409, AMBIENTE_NO_COINCIDE: 409,
  CUENTA_DUPLICADA: 409, CUENTA_DEFAULT_DUPLICADA: 409, CUENTA_DEFAULT_REQUERIDA: 409, CUENTA_INACTIVA: 409,
  NC_FACTURA_NO_AUTORIZADA: 409, NC_SUPERA_FACTURA: 409,
  FACTURA_NO_EDITABLE: 409, FACTURA_NO_EMITIBLE: 409, FACTURA_NO_EMITIENDO: 409, EMISION_EN_CURSO: 409,
  NUMERO_DESFASADO: 409, NUMERO_NO_COINCIDE: 409, NUMERO_DUPLICADO: 409, CONFLICTO_NUMERACION: 409,
  FACTURA_NO_REVERTIBLE: 409, FACTURA_NO_DESCARTABLE: 409, FACTURA_NO_AUTORIZADA: 409, FACTURA_NO_BORRABLE: 409,
  FACTURA_AUTORIZADA_INMUTABLE: 409, YA_REGISTRADA: 409, NO_REGISTRADA: 409, NUMERO_FINNEGANS_DUPLICADO: 409,
  // 422 / 202 (emisión)
  ARCA_RECHAZO: 422, EMISION_INCIERTA: 202,
  // 503 — ARCA
  ARCA_NO_DISPONIBLE: 503, ARCA_NO_CONFIGURADO: 503, ARCA_TA_PERDIDO: 503,
  // 500: guardas de la base contra escrituras a mano; nunca deberían llegar al front
  VENTAS_SOLO_RPC: 500, FACTURA_NACE_BORRADOR: 500, SOLO_AGREGAR: 500, ARCA_COMPROBANTE_INVALIDO: 500,
}

function parseDetail(details: unknown): unknown {
  if (details == null || details === '') return undefined
  if (typeof details !== 'string') return details
  try { return JSON.parse(details) } catch { return details }
}

export interface PgError {
  message?: string
  details?: string | null
  hint?: string | null
  code?: string
}

/**
 * Error de PostgREST/RPC → FacturacionHttpError.
 *   - `raise exception 'CODIGO'` conocido → su status con `detail` parseado.
 *   - `unique_violation` (23505): si quien llama pasa `unicoComo`, sale con
 *     ese código (clientes → CLIENTE_DUPLICADO); si no, 409 DUPLICADO.
 *   - lo demás → 500 DB_ERROR con el mensaje.
 */
export function mapRpcError(error: PgError, opts: { unicoComo?: string } = {}): FacturacionHttpError {
  const msg = error.message || ''
  if (error.code === '23505') {
    return new FacturacionHttpError(409, opts.unicoComo ?? 'DUPLICADO', { dbMessage: msg })
  }
  const m = msg.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)
  const code = m?.[1]
  if (code && STATUS_POR_CODIGO[code] !== undefined) {
    return new FacturacionHttpError(STATUS_POR_CODIGO[code] ?? 500, code, parseDetail(error.details))
  }
  return new FacturacionHttpError(500, 'DB_ERROR', { dbMessage: msg, code: error.code })
}

/**
 * Falla de ARCA que NO autorizó nada (antes de enviar, o después pero sin que
 * pueda haber llegado) → 503 con el código que el front entiende.
 */
export function errorArca(e: unknown, detalleExtra?: Record<string, unknown>): FacturacionHttpError {
  if (e instanceof FacturacionHttpError) return e
  if (e instanceof ArcaError) {
    const base = { arca_codigo: e.codigo, mensaje: e.message, ...(detalleExtra ?? {}) }
    if (e.codigo === 'ARCA_NO_CONFIGURADO') return new FacturacionHttpError(503, 'ARCA_NO_CONFIGURADO', base)
    if (e.codigo === 'ARCA_TA_PERDIDO') return new FacturacionHttpError(503, 'ARCA_TA_PERDIDO', base)
    if (e.codigo === 'ARCA_COMPROBANTE_INVALIDO') return new FacturacionHttpError(500, 'ARCA_COMPROBANTE_INVALIDO', base)
    return new FacturacionHttpError(503, 'ARCA_NO_DISPONIBLE', { ...base, ...(e.errores.length ? { errores: e.errores } : {}) })
  }
  return new FacturacionHttpError(503, 'ARCA_NO_DISPONIBLE', { mensaje: e instanceof Error ? e.message : String(e), ...(detalleExtra ?? {}) })
}

/** Cuerpo JSON de la respuesta de error. */
export function cuerpoError(err: FacturacionHttpError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: err.code }
  if (err.detail && typeof err.detail === 'object' && 'campo' in (err.detail as object)) {
    body.campo = (err.detail as { campo: string }).campo
  }
  if (err.detail !== undefined) body.detail = err.detail
  if (err.extra) Object.assign(body, err.extra)
  return body
}
