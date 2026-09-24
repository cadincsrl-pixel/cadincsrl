/**
 * Errores tipados de Contabilidad: `{ error: CODE, campo?, detail? }` con
 * status HTTP estable (mismo patrón que Facturación y Pagos: el frontend lee
 * `body.error`).
 *
 * Los códigos de la base salen de los `raise exception 'CODIGO'` de
 * 20260926a…f (con `detail` JSON en texto). Si el `detail` trae `indice`
 * (error de una línea del asiento), el cuerpo agrega
 * `campo: 'lineas.<indice>.<campo>'` para que el modal lo pinte en la fila.
 */

export class ContabilidadHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
    public extra?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'ContabilidadHttpError'
  }
}

/** 400 de validación con el campo que falló: el modal lo muestra bajo el input. */
export function errorDeCampo(code: string, campo: string, extra?: Record<string, unknown>): ContabilidadHttpError {
  return new ContabilidadHttpError(STATUS_POR_CODIGO[code] ?? 400, code, { campo, ...(extra ?? {}) })
}

/** Status por código. Lo que no está acá y viene de la base sale como 500 DB_ERROR. */
export const STATUS_POR_CODIGO: Readonly<Record<string, number>> = {
  // 404
  ASIENTO_NO_EXISTE: 404, CUENTA_NO_EXISTE: 404, PERIODO_NO_EXISTE: 404, TESORERIA_NO_EXISTE: 404,
  EJERCICIO_NO_EXISTE: 404, ORIGEN_NO_EXISTE: 404,
  // 403 (las RPC vuelven a chequear los flags: espejo de requireFlag)
  SIN_PERMISO: 403, SIN_PERMISO_ASIENTOS: 403, SIN_PERMISO_PLAN: 403, SIN_PERMISO_CERRAR: 403,
  SIN_PERMISO_CONTABILIZAR: 403, SIN_PERMISO_MAPEOS: 403,
  // 400 — datos
  ID_INVALIDO: 400, DATOS_INVALIDOS: 400, USUARIO_REQUERIDO: 400, FECHA_REQUERIDA: 400, FECHA_SIN_PERIODO: 400,
  TIPO_NO_PERMITIDO: 400, ESTADO_INVALIDO: 400, GLOSA_REQUERIDA: 400,
  SIN_LINEAS: 400, DEMASIADAS_LINEAS: 400, MENOS_DE_DOS_LINEAS: 400, LINEA_IMPORTE_INVALIDO: 400,
  CUENTA_INACTIVA: 400, CUENTA_NO_IMPUTABLE: 400, AUXILIAR_REQUERIDO: 400, AUXILIAR_NO_CORRESPONDE: 400,
  AUXILIAR_NO_EXISTE: 400, OBRA_NO_EXISTE: 400,
  APERTURA_FECHA_INVALIDA: 400, MOTIVO_REQUERIDO: 400, FECHA_ANTERIOR_AL_ORIGINAL: 400,
  RANGO_INVALIDO: 400, RANGO_EXCEDE_EJERCICIO: 400,
  CODIGO_INVALIDO: 400, NOMBRE_INVALIDO: 400, RUBRO_REQUERIDO: 400, RUBRO_INVALIDO: 400, AUXILIAR_INVALIDO: 400,
  PADRE_NO_EXISTE: 400, PADRE_IMPUTABLE: 400, RUBRO_DISTINTO_AL_PADRE: 400, AUXILIAR_SOLO_IMPUTABLE: 400,
  IMPUTABLE_CON_HIJAS: 400, IMPUTABLE_INVALIDO: 400,
  // Rubro «resultado» (pieza 5): solo títulos; la hija de un resultado no hereda el rubro.
  RESULTADO_SOLO_TITULO: 400,
  SIN_FILAS: 400, DEMASIADAS_FILAS: 400, CUENTA_TESORERIA_INVALIDA: 400, CBU_INVALIDO: 400, ALIAS_INVALIDO: 400,
  // Fase 3: motor de asientos automáticos y mapeos (20260927d–f)
  CLAVE_INVALIDA: 400, SUBCLAVE_INVALIDA: 400, MAPEO_CUENTA_INCOMPATIBLE: 400, CONFIG_INVALIDA: 400,
  ORIGEN_INVALIDO: 400, FECHA_FUTURA: 400,
  // 422 — el pedido no cierra por sí mismo
  ASIENTO_DESBALANCEADO: 422, ASIENTO_TOTAL_CERO: 422, IMPORTACION_CON_ERRORES: 422,
  // 409 — estado
  PERIODO_CERRADO: 409, EJERCICIO_CERRADO: 409, PERIODO_YA_CERRADO: 409, PERIODO_NO_CERRADO: 409,
  PERIODO_ANTERIOR_ABIERTO: 409, PERIODO_POSTERIOR_CERRADO: 409, HAY_BORRADORES: 409,
  ASIENTO_NO_EDITABLE: 409, ASIENTO_NO_BORRABLE: 409, ASIENTO_ES_BORRADOR: 409, ASIENTO_YA_ANULADO: 409,
  ASIENTO_YA_REVERTIDO: 409, ASIENTO_AUTOMATICO: 409, CONTRAASIENTO_NO_EDITABLE: 409, APERTURA_DUPLICADA: 409,
  CODIGO_DUPLICADO: 409, CUENTA_CON_MOVIMIENTOS: 409, CODIGO_CON_HIJAS: 409, CUENTA_CON_HIJAS: 409,
  CUENTA_CON_HIJAS_ACTIVAS: 409, PADRE_INACTIVO: 409, CUENTA_EN_USO: 409, TESORERIA_DUPLICADA: 409,
  CONTABILIZADOR_OCUPADO: 409, HAY_PENDIENTES_AUTOMATICOS: 409,
  // 500 — guardas de la base contra escrituras a mano: nunca deberían llegar al front
  ASIENTO_SOLO_RPC: 500, NUMERO_SOLO_AL_CERRAR: 500, ASIENTO_ANULADO_INMUTABLE: 500, ASIENTO_TOTAL_INCONSISTENTE: 500,
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
 * Error de PostgREST/RPC → ContabilidadHttpError.
 *   - `raise exception 'CODIGO'` conocido → su status con `detail` parseado.
 *   - `unique_violation` (23505): con `unicoComo` sale con ese código
 *     (cuentas → CODIGO_DUPLICADO, tesorería → TESORERIA_DUPLICADA); si no,
 *     409 DUPLICADO.
 *   - lo demás → 500 DB_ERROR con el mensaje.
 */
export function mapRpcError(error: PgError, opts: { unicoComo?: string } = {}): ContabilidadHttpError {
  const msg = error.message || ''
  if (error.code === '23505') {
    return new ContabilidadHttpError(409, opts.unicoComo ?? 'DUPLICADO', { dbMessage: msg })
  }
  const m = msg.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)
  const code = m?.[1]
  if (code && STATUS_POR_CODIGO[code] !== undefined) {
    return new ContabilidadHttpError(STATUS_POR_CODIGO[code] ?? 500, code, parseDetail(error.details))
  }
  return new ContabilidadHttpError(500, 'DB_ERROR', { dbMessage: msg, code: error.code })
}

/**
 * El campo del formulario al que apunta el error:
 *   - `detail.indice` (una línea del asiento) → `lineas.<indice>.<campo>`;
 *   - `detail.campo` → tal cual.
 */
export function campoDe(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  const d = detail as { indice?: unknown; campo?: unknown }
  if (typeof d.indice === 'number' && Number.isInteger(d.indice)) {
    return typeof d.campo === 'string' && d.campo ? `lineas.${d.indice}.${d.campo}` : `lineas.${d.indice}`
  }
  return typeof d.campo === 'string' && d.campo ? d.campo : undefined
}

/** Cuerpo JSON de la respuesta de error. */
export function cuerpoError(err: ContabilidadHttpError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: err.code }
  const campo = campoDe(err.detail)
  if (campo) body.campo = campo
  if (err.detail !== undefined) body.detail = err.detail
  if (err.extra) Object.assign(body, err.extra)
  return body
}

/**
 * 400 de zod. Si el mensaje del issue es un código conocido (el schema los usa
 * para la partida doble y los importes de las líneas) sale con ese código y su
 * status; si no, DATOS_INVALIDOS { campo, mensaje }.
 */
export function errorDeZod(issue: { path?: PropertyKey[]; message?: string; params?: Record<string, unknown> } | undefined) {
  const campo = issue?.path?.map(String).join('.') || null
  const msg = issue?.message ?? 'dato inválido'
  if (/^[A-Z][A-Z0-9_]+$/.test(msg) && STATUS_POR_CODIGO[msg] !== undefined) {
    return { status: STATUS_POR_CODIGO[msg]!, body: { error: msg, campo, detail: { campo, ...(issue?.params ?? {}) } } }
  }
  return { status: 400, body: { error: 'DATOS_INVALIDOS', campo, detail: { campo, mensaje: msg } } }
}
