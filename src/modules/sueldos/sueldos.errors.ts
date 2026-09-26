/**
 * Errores tipados de Sueldos: `{ error: CODE, campo?, detail? }` con status
 * HTTP estable (mismo patrón que Contabilidad y Pagos: el frontend lee
 * `body.error` y lo traduce en `utils/sueldos.errores.ts`).
 *
 * Los códigos de la base salen de los `raise exception 'CODIGO'` de
 * 20261004c/d (con `detail` JSON en texto). Si el `detail` trae `indice`
 * (error de una línea del recibo), el cuerpo agrega `campo: 'lineas.<i>…'`.
 */

export class SueldosHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
  ) {
    super(code)
    this.name = 'SueldosHttpError'
  }
}

/** Status por código. Lo que no está acá y viene de la base sale como 500 DB_ERROR. */
export const STATUS_POR_CODIGO: Readonly<Record<string, number>> = {
  // 404
  LEGAJO_NO_EXISTE: 404, LIQUIDACION_NO_EXISTE: 404, RECIBO_NO_EXISTE: 404, CONVENIO_NO_EXISTE: 404,
  CATEGORIA_NO_EXISTE: 404, ESCALA_NO_EXISTE: 404, CONCEPTO_NO_EXISTE: 404, VALOR_NO_EXISTE: 404,
  PARAMETRO_NO_EXISTE: 404, PERSONAL_NO_EXISTE: 404, CHOFER_NO_EXISTE: 404,
  // 403
  SIN_PERMISO: 403, SIN_PERMISO_PII: 403,
  // 400 — datos
  ID_INVALIDO: 400, DATOS_INVALIDOS: 400, USUARIO_REQUERIDO: 400, NOMBRE_REQUERIDO: 400,
  CUIL_INVALIDO: 400, CBU_INVALIDO: 400, CONVENIO_INVALIDO: 400, CATEGORIA_OTRO_CONVENIO: 400,
  FECHAS_INVALIDAS: 400, TITULO_INVALIDO: 400, JORNADA_INVALIDA: 400, ZONA_INVALIDA: 400,
  MODALIDAD_INVALIDA: 400, HIJOS_INVALIDO: 400, OBRA_NO_EXISTE: 400,
  CODIGO_INVALIDO: 400, PERIODICIDAD_INVALIDA: 400, UNIDAD_INVALIDA: 400, FECHA_REQUERIDA: 400,
  VALOR_INVALIDO: 400, VALOR_REQUERIDO: 400, TIPO_INVALIDO: 400, CALCULO_INVALIDO: 400, BASE_INVALIDA: 400,
  BASE_REQUERIDA: 400, CONDICION_INVALIDA: 400, CODIGO_ARCA_INVALIDO: 400, DESTINO_INVALIDO: 400,
  GRUPO_INVALIDO: 400, CLAVE_INVALIDA: 400, PORCENTAJE_INVALIDO: 400, CONCEPTO_USA_PARAMETRO: 400,
  PERIODO_REQUERIDO: 400, QUINCENA_INVALIDA: 400, TIPO_NO_CORRESPONDE_CONVENIO: 400,
  LEGAJO_OTRO_CONVENIO: 400, LINEAS_INVALIDAS: 400, DEMASIADAS_LINEAS: 400, CONCEPTO_OTRO_CONVENIO: 400,
  LINEA_TIPO_INVALIDO: 400, LINEA_TIPO_NO_COINCIDE: 400, LINEA_NOMBRE_REQUERIDO: 400, LINEA_IMPORTE_INVALIDO: 400,
  LINEA_DESTINO_INVALIDO: 400, LINEA_CODIGO_ARCA_INVALIDO: 400, LINEA_UNIDAD_INVALIDA: 400,
  MOTIVO_REQUERIDO: 400,
  // Motor de cálculo (backend)
  LEGAJO_SIN_CATEGORIA: 400, SIN_ESCALA: 400, CONCEPTO_DESCONOCIDO: 400, IMPORTE_REQUERIDO: 400,
  LEGAJO_SIN_FECHA_EGRESO: 400, LEGAJOS_REQUERIDOS: 400,
  // 422 — el pedido no cierra
  TOTALES_NO_CUADRAN: 422, NETO_NO_CUADRA: 422,
  // 409 — estado / duplicados
  LEGAJO_DUPLICADO: 409, CUIL_DUPLICADO: 409, CODIGO_DUPLICADO: 409, CODIGO_NO_EDITABLE: 409,
  ESCALA_DUPLICADA: 409, VALOR_DUPLICADO: 409, PARAMETRO_DUPLICADO: 409, SIN_ESCALAS_VIGENTES: 409,
  ESCALA_YA_EXISTE: 409, LIQUIDACION_DUPLICADA: 409, LIQUIDACION_ANULADA: 409, LIQUIDACION_NO_BORRADOR: 409,
  LIQUIDACION_NO_CERRADA: 409, SIN_RECIBOS: 409, NETO_NEGATIVO: 409, LEGAJOS_SIN_FECHA_INGRESO: 409, FECHA_PAGO_REQUERIDA: 409, ASIENTO_YA_GENERADO: 409, PERIODO_CERRADO: 409,
}

export function parseDetail(details: unknown): unknown {
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
 * Error de PostgREST/RPC → SueldosHttpError.
 *   - `raise exception 'CODIGO'` conocido → su status con `detail` parseado.
 *   - `unique_violation` (23505) → 409 con `unicoComo` o DUPLICADO.
 *   - lo demás → 500 DB_ERROR con el mensaje.
 */
export function mapRpcError(error: PgError, opts: { unicoComo?: string } = {}): SueldosHttpError {
  const msg = error.message || ''
  if (error.code === '23505') return new SueldosHttpError(409, opts.unicoComo ?? 'DUPLICADO', { dbMessage: msg })
  const m = msg.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)
  const code = m?.[1]
  if (code && STATUS_POR_CODIGO[code] !== undefined) {
    return new SueldosHttpError(STATUS_POR_CODIGO[code] ?? 500, code, parseDetail(error.details))
  }
  return new SueldosHttpError(500, 'DB_ERROR', { dbMessage: msg, code: error.code })
}

/** `detail.indice` → `lineas.<i>.<campo>`; `detail.campo` → tal cual. */
export function campoDe(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  const d = detail as { indice?: unknown; campo?: unknown }
  if (typeof d.indice === 'number' && Number.isInteger(d.indice)) {
    return typeof d.campo === 'string' && d.campo ? `lineas.${d.indice}.${d.campo}` : `lineas.${d.indice}`
  }
  return typeof d.campo === 'string' && d.campo ? d.campo : undefined
}

export function cuerpoError(err: SueldosHttpError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: err.code }
  const campo = campoDe(err.detail)
  if (campo) body.campo = campo
  if (err.detail !== undefined) body.detail = err.detail
  return body
}

/** 400 de zod → DATOS_INVALIDOS { campo, mensaje } (o el código si el mensaje es uno conocido). */
export function errorDeZod(issue: { path?: PropertyKey[]; message?: string } | undefined) {
  const campo = issue?.path?.map(String).join('.') || null
  const msg = issue?.message ?? 'dato inválido'
  if (/^[A-Z][A-Z0-9_]+$/.test(msg) && STATUS_POR_CODIGO[msg] !== undefined) {
    return { status: STATUS_POR_CODIGO[msg]!, body: { error: msg, campo, detail: { campo } } }
  }
  return { status: 400, body: { error: 'DATOS_INVALIDOS', campo, detail: { campo, mensaje: msg } } }
}

