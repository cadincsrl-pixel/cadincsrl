/**
 * Errores tipados del módulo Pagos: `{ error: CODE, detail?, campo? }` con
 * status HTTP estable, para que el frontend traduzca cada código a un mensaje
 * en castellano. Los códigos vienen del diseño v3 §3.
 */

export class PagosHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'PagosHttpError'
  }
}

/** 400 de validación con el campo que falló: el modal lo muestra bajo el input. */
export function errorDeCampo(code: string, campo: string, extra?: Record<string, unknown>): PagosHttpError {
  return new PagosHttpError(400, code, { campo, ...(extra ?? {}) })
}

/**
 * Status por código de las RPC (`raise exception 'CODE'` en la base; el
 * detalle llega en `details` como JSON o texto). Lo que no está acá es un
 * error de base y sale como 500 DB_ERROR con el mensaje.
 */
const STATUS_POR_CODIGO: Record<string, number> = {
  // 404
  FACTURA_NO_EXISTE: 404, ORDEN_NO_EXISTE: 404, PROVEEDOR_NO_EXISTE: 404, ADJ_NO_EXISTE: 404,
  // 400
  LINEA_DUPLICADA: 400, SUMA_LINEAS_DISTINTA: 400, IMPUTACION_NO_CUADRA: 400, DESGLOSE_NO_CUADRA: 400,
  OBRA_ARCHIVADA: 400, OBRA_NO_EXISTE: 400, MOTIVO_REQUERIDO: 400, FECHA_FUTURA: 400,
  COMPROBANTE_REQUERIDO: 400, FECHA_COBRO_REQUERIDA: 400, FORMA_PAGO_REQUERIDA: 400,
  CUIT_INVALIDO: 400, CBU_INVALIDO: 400, ALIAS_INVALIDO: 400, ARCHIVO_NO_SUBIDO: 400, PATH_INVALIDO: 400,
  LINEA_INVALIDA: 400, LINEAS_REQUERIDAS: 400, NC_DATOS_REQUERIDOS: 400, ADJUNTO_INVALIDO: 400,
  FORMA_PAGO_INVALIDA: 400, FECHA_COBRO_INVALIDA: 400, VENCIMIENTO_INVALIDO: 400, TOTAL_INVALIDO: 400,
  DESCRIPCION_REQUERIDA: 400, CAMPO_NO_EDITABLE: 400, IMPUTACION_DUPLICADA: 400, IMPUTACION_INVALIDA: 400,
  IMPUTACION_REQUERIDA: 400, OBRA_INEXISTENTE: 400, PROVEEDOR_REQUERIDO: 400, FECHA_REQUERIDA: 400,
  IDS_REQUERIDOS: 400, USUARIO_REQUERIDO: 400, NUMERO_FINNEGANS_REQUERIDO: 400,
  // 403
  NO_PUEDE_APROBAR_PROPIA: 403, NO_PUEDE_PAGAR_PROPIA: 403, NO_PUEDE_PAGAR_LO_QUE_APROBO: 403,
  SIN_PERMISO: 403, ORDEN_NO_ES_TUYA_O_VIEJA: 403, PAGADA_AL_CARGAR_FORMA: 403, PAGADA_AL_CARGAR_SIN_PERMISO: 403,
  // 409
  FACTURA_DUPLICADA: 409, FACTURA_CON_PAGOS: 409, FACTURA_CERRADA: 409, FACTURA_NO_APROBADA: 409,
  FACTURA_NO_APROBABLE: 409, FACTURA_PAGA_CLIENTE: 409, FACTURA_NO_PAGABLE: 409, FACTURA_OTRO_PROVEEDOR: 409,
  FACTURA_NO_OBSERVADA: 409, FACTURA_NO_OBSERVABLE: 409, PAGADA_AL_CARGAR_NO_ANULABLE: 409, PAGADA_AL_CARGAR_INMUTABLE: 409,
  MONTO_SUPERA_SALDO: 409, ORDEN_INMUTABLE: 409, ORDEN_YA_ANULADA: 409, PROVEEDOR_SIN_DATOS_PAGO: 409,
  ADJ_DUPLICADO: 409, ADJUNTO_REQUERIDO: 409, PROVEEDOR_INACTIVO: 409, PROVEEDOR_DUPLICADO: 409,
  PROVEEDOR_CON_SALDO: 409, ESTADO_SOLO_RECALCULADOR: 409,
  ORDEN_ANULADA: 409, ORDEN_YA_REGISTRADA: 409, ORDEN_NO_REGISTRADA: 409, FINNEGANS_DUPLICADO: 409,
  DEVOLUCION_SOLO_FACTURAS: 409, DEVOLUCION_PARCIAL_CON_CHEQUES: 409, DEVOLUCION_INVALIDA: 400,
  CHEQUES_REQUERIDOS: 400, CHEQUES_INESPERADOS: 400, SUMA_CHEQUES_DISTINTA: 400, CHEQUE_INVALIDO: 400,
  // 500: nunca deberían llegar al front (guards de la base contra escrituras a mano)
  APROBACION_SOLO_RPC: 500,
}

function parseDetail(details: unknown): unknown {
  if (details == null || details === '') return undefined
  if (typeof details !== 'string') return details
  try { return JSON.parse(details) } catch { return details }
}

export function mapRpcError(error: { message?: string; details?: string | null; hint?: string | null; code?: string }): PagosHttpError {
  const msg = error.message || ''
  const m = msg.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)
  const code = m?.[1]
  if (code && STATUS_POR_CODIGO[code] !== undefined) {
    return new PagosHttpError(STATUS_POR_CODIGO[code] ?? 500, code, parseDetail(error.details))
  }
  return new PagosHttpError(500, 'DB_ERROR', { dbMessage: msg, code: error.code })
}
