/**
 * Errores tipados del módulo Pagos: `{ error: CODE, detail?, campo? }` con
 * status HTTP estable, para que el frontend traduzca cada código a un mensaje
 * en castellano. Los códigos vienen del diseño v3 §3.
 */
import { ArcaError } from '../../lib/arca/errores.js'
import { errorDePadron } from '../../lib/arca/padron-datos.js'

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
 * Error del padrón de ARCA → PagosHttpError, con los mismos códigos y status
 * que Ventas: 404 PADRON_CUIT_INEXISTENTE, 422 PADRON_NO_ALCANZADO /
 * PADRON_CLAVE_INACTIVA / PADRON_SIN_DATOS, 503 PADRON_SIN_AUTORIZACION /
 * ARCA_NO_CONFIGURADO / ARCA_NO_DISPONIBLE (ARCA caída o cualquier otra cosa).
 */
export function errorPadronPagos(e: unknown, cuit: string): PagosHttpError {
  if (e instanceof PagosHttpError) return e
  const m = errorDePadron(e)
  if (m && e instanceof ArcaError) {
    return new PagosHttpError(m[0], m[1], {
      campo: 'cuit', cuit, mensaje: e.message, ...(e.errores.length ? { errores: e.errores.map((x) => x.msg) } : {}),
    })
  }
  if (e instanceof ArcaError && e.codigo === 'ARCA_NO_CONFIGURADO') {
    return new PagosHttpError(503, 'ARCA_NO_CONFIGURADO', { cuit, arca_codigo: e.codigo, mensaje: e.message })
  }
  return new PagosHttpError(503, 'ARCA_NO_DISPONIBLE', {
    cuit,
    ...(e instanceof ArcaError ? { arca_codigo: e.codigo } : {}),
    mensaje: e instanceof Error ? e.message : String(e),
  })
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
  // De qué cuenta propia salió la plata (20260926g): tesoreria_cuentas activa.
  CUENTA_ORIGEN_INVALIDA: 400,
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
  CONTACTO_EMAIL_DUPLICADO: 409, CONTACTO_DE_OTRO: 400, DATOS_INVALIDOS: 400,
  ORDEN_ANULADA: 409, ORDEN_YA_REGISTRADA: 409, ORDEN_NO_REGISTRADA: 409, FINNEGANS_DUPLICADO: 409,
  // Nota de crédito como comprobante (20260925a–d). El circuito de devolución
  // (DEVOLUCION_*) se borró con su RPC.
  NC_TIPO_INVALIDO: 400, NC_APLICACION_INVALIDA: 400, NC_ES_COMPROBANTE: 400, NC_SUPERA_TOTAL: 400,
  NC_NO_SE_PAGA: 409, NC_SUPERA_SALDO: 409, NC_OTRO_PROVEEDOR: 409, NC_APLICACION_CONGELADA: 409,
  NC_NO_APROBADA: 409, NC_SIN_CREDITO: 409, FACTURA_CON_NC: 409,
  DESGLOSE_INCONSISTENTE: 400, LECTURA_NO_EXISTE: 404, LECTURA_YA_USADA: 409,
  // Completar el desglose (20260924v)
  DESGLOSE_REQUERIDO: 400, DESGLOSE_INVALIDO: 400, DESGLOSE_SIN_IVA: 400, CAE_INVALIDO: 400,
  DESGLOSE_CAMBIA_PERCEPCIONES: 409, ADJUNTO_FACTURA_NO_EXISTE: 404,
  CHEQUES_REQUERIDOS: 400, CHEQUES_INESPERADOS: 400, SUMA_CHEQUES_DISTINTA: 400, CHEQUE_INVALIDO: 400,
  // Concepto de la factura y código de proveedor (20260925i–n)
  CONCEPTO_INVALIDO: 400, CONCEPTO_REQUERIDO: 400, CONCEPTO_NO_EXISTE: 404,
  CONCEPTO_DUPLICADO: 409, CONCEPTO_ULTIMO_ACTIVO: 409, CODIGO_NO_EDITABLE: 409,
  // Padrón de ARCA para proveedores (20260925o). Mismos códigos y status que
  // Ventas (lib/arca/padron-datos.ts → ERRORES_PADRON).
  PADRON_CUIT_INEXISTENTE: 404, PADRON_NO_ALCANZADO: 422, PADRON_CLAVE_INACTIVA: 422, PADRON_SIN_DATOS: 422,
  PADRON_SIN_AUTORIZACION: 503, ARCA_NO_DISPONIBLE: 503, ARCA_NO_CONFIGURADO: 503,
  PROVEEDOR_SIN_CUIT: 400, CONDICION_IVA_INVALIDA: 400, PROVEEDOR_INVALIDO: 400,
  // Foto del cheque (20260925p)
  CHEQUE_ILEGIBLE: 422,
  // Período IVA (20260927a)
  PERIODO_IVA_INVALIDO: 400, PERIODO_IVA_ANTERIOR_A_FECHA: 400, PERIODO_IVA_CERRADO: 409,
  // Importador de ARCA recibidos e imputación (20260927b/c). Los errores POR
  // FILA (TIPO_NO_SOPORTADO, RANGO_DE_NUMEROS, EMISOR_SIN_CUIT…) viajan dentro
  // de la respuesta, no como HTTP; IMPORTACION_CON_ERRORES los lleva en detail.
  SIN_FILAS: 400, DEMASIADAS_FILAS: 400, ARCHIVO_ILEGIBLE: 400,
  FACTURA_SIN_IMPUTAR: 409, FACTURA_YA_IMPUTADA: 409, TRIBUTOS_A_REVISAR: 409,
  // Importada de un mes ya pagado (20260928): no se aprueba.
  FACTURA_A_RECONSTRUIR: 409,
  IMPORTACION_CON_ERRORES: 422,
  // Pagadas en lote con tarjeta / billetera (20260927h)
  FORMA_NO_COINCIDE_CUENTA: 400, FECHA_ANTERIOR_A_FACTURA: 400, FACTURA_SIN_SALDO: 409, FACTURA_YA_APROBADA: 409,
  // Jurisdicción del tributo y configuración de Compras (20260929f)
  JURISDICCION_NO_EXISTE: 400, CONFIG_INVALIDA: 400,
  // Avisos de pago (20260929i)
  EMAIL_INVALIDO: 400, PIE_CON_CBU: 400, MAIL_NO_CONFIGURADO: 409, MAIL_NO_ENVIADO: 502,
  // Deshacer una importación (20260929k)
  IMPORTACION_NO_EXISTE: 404, IMPORTACION_YA_DESHECHA: 409, IMPORTACION_CON_MOVIMIENTOS: 409,
  ASIENTOS_NO_ANULADOS: 500,
  // 500: nunca deberían llegar al front (guards de la base contra escrituras a mano)
  APROBACION_SOLO_RPC: 500, SIN_IMPUTAR_SOLO_IMPORTADOR: 500, IMPUTAR_SOLO_RPC: 500,
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
