// Mapeo de errores de Facturación: códigos de las RPC (20260924a/c) → status,
// unique_violation de clientes → 409 CLIENTE_DUPLICADO, fallas de ARCA → 503
// y la forma del cuerpo que lee el frontend (`body.error`).
import { describe, it, expect } from 'vitest'
import {
  FacturacionHttpError, mapRpcError, errorArca, cuerpoError, STATUS_POR_CODIGO,
} from '../../../src/modules/facturacion/facturacion.errors.js'
import { ArcaError } from '../../../src/lib/arca/index.js'

describe('mapRpcError', () => {
  it.each([
    ['FACTURA_NO_EXISTE', 404],
    ['CLIENTE_NO_EXISTE', 404],
    ['LETRA_INCOMPATIBLE', 400],
    ['CENTRO_COSTO_REQUERIDO', 400],
    ['FECHA_FUERA_DE_RANGO', 400],
    ['RENGLON_INVALIDO', 400],
    ['FORZAR_SOLO_ADMIN', 403],
    ['SIN_PERMISO_EMITIR', 403],
    ['SIN_PERMISO_REGISTRAR', 403],
    ['EMISION_EN_CURSO', 409],
    ['NC_SUPERA_FACTURA', 409],
    ['FACTURA_NO_EDITABLE', 409],
    ['NUMERO_DESFASADO', 409],
    ['NUMERO_FINNEGANS_DUPLICADO', 409],
    ['YA_REGISTRADA', 409],
    ['NO_REGISTRADA', 409],
    ['FACTURA_NO_BORRABLE', 409],
    ['VENTAS_SOLO_RPC', 500],
  ])('%s → %i', (code, status) => {
    const e = mapRpcError({ message: code, code: 'P0001', details: null })
    expect(e).toBeInstanceOf(FacturacionHttpError)
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
  })

  it('parsea el detail JSON de la RPC', () => {
    const e = mapRpcError({
      message: 'EMISION_EN_CURSO', code: 'P0001',
      details: '{"factura_id" : 5, "bloqueada_por" : 3, "ambiente" : "homo"}',
    })
    expect(e.status).toBe(409)
    expect(e.detail).toEqual({ factura_id: 5, bloqueada_por: 3, ambiente: 'homo' })
  })

  it('detail que no es JSON queda como texto', () => {
    expect(mapRpcError({ message: 'TOTAL_CERO', details: 'algo' }).detail).toBe('algo')
  })

  it('unique_violation → CLIENTE_DUPLICADO cuando lo pide clientes; si no, DUPLICADO', () => {
    const err = { message: 'duplicate key value violates unique constraint "ventas_clientes_doc_uidx"', code: '23505' }
    expect(mapRpcError(err, { unicoComo: 'CLIENTE_DUPLICADO' })).toMatchObject({ status: 409, code: 'CLIENTE_DUPLICADO' })
    expect(mapRpcError(err)).toMatchObject({ status: 409, code: 'DUPLICADO' })
  })

  it('error desconocido de la base → 500 DB_ERROR', () => {
    const e = mapRpcError({ message: 'connection reset', code: '08006' })
    expect(e).toMatchObject({ status: 500, code: 'DB_ERROR' })
  })

  it('todos los códigos que lanzan las RPC tienen status', () => {
    // Los `raise exception` de 20260924a/c.
    const deLaBase = [
      'FACTURA_AUTORIZADA_INMUTABLE', 'FACTURA_NO_BORRABLE', 'VENTAS_SOLO_RPC', 'FACTURA_NACE_BORRADOR', 'FACTURA_NO_EDITABLE',
      'SOLO_AGREGAR', 'LETRA_INCOMPATIBLE', 'FECHA_FUERA_DE_RANGO', 'FECHA_ANTERIOR_AL_ULTIMO', 'NC_SIN_FACTURA',
      'NC_FACTURA_NO_EXISTE', 'NC_FACTURA_NO_AUTORIZADA', 'NC_TIPO_NO_COINCIDE', 'AMBIENTE_NO_COINCIDE', 'NC_OTRO_CLIENTE',
      'NC_SUPERA_FACTURA', 'FORZAR_SOLO_ADMIN', 'USUARIO_REQUERIDO', 'AMBIENTE_INVALIDO', 'PTO_VTA_INVALIDO', 'TIPO_INVALIDO',
      'FACTURA_NO_EXISTE', 'CLIENTE_REQUERIDO', 'CLIENTE_NO_EXISTE', 'CLIENTE_INACTIVO', 'PRODUCTO_INVALIDO',
      'CENTRO_COSTO_REQUERIDO', 'CENTRO_COSTO_INVALIDO', 'OBRA_NO_EXISTE', 'CONCEPTO_INVALIDO', 'SIN_RENGLONES',
      'RENGLON_INVALIDO', 'TOTAL_CERO', 'ASOCIADA_SOLO_NC', 'EMISION_EN_CURSO', 'FACTURA_NO_EMITIBLE', 'SIN_PERMISO_EMITIR',
      'FACTURA_NO_EMITIENDO', 'NUMERO_INVALIDO', 'NUMERO_DESFASADO', 'RESULTADO_INVALIDO', 'NUMERO_REQUERIDO',
      'NUMERO_NO_COINCIDE', 'CAE_INVALIDO', 'CAE_VTO_REQUERIDO', 'NUMERO_DUPLICADO', 'FACTURA_NO_REVERTIBLE',
      'FACTURA_NO_DESCARTABLE', 'SIN_PERMISO_REGISTRAR', 'NUMERO_FINNEGANS_REQUERIDO', 'FACTURA_NO_AUTORIZADA',
      'YA_REGISTRADA', 'NUMERO_FINNEGANS_DUPLICADO', 'NO_REGISTRADA', 'SERVICIO_REQUERIDO', 'SEGUNDOS_INVALIDOS', 'TA_INVALIDO',
      // 20260924d
      'CF_REQUIERE_IDENTIFICACION',
    ]
    const faltan = deLaBase.filter((c) => STATUS_POR_CODIGO[c] === undefined)
    expect(faltan).toEqual([])
  })
})

describe('errorArca', () => {
  const arca = (codigo: string, quizasLlego = false) =>
    new ArcaError({ tipo: 'transporte', codigo, mensaje: `m ${codigo}`, quizasLlego })

  it('sin conexión / timeout / fault → 503 ARCA_NO_DISPONIBLE con el código de ARCA', () => {
    expect(errorArca(arca('ARCA_SIN_CONEXION'))).toMatchObject({ status: 503, code: 'ARCA_NO_DISPONIBLE', detail: { arca_codigo: 'ARCA_SIN_CONEXION' } })
    expect(errorArca(arca('ARCA_SOAP_FAULT'))).toMatchObject({ status: 503, code: 'ARCA_NO_DISPONIBLE' })
    expect(errorArca(arca('ARCA_TA_EN_RENOVACION'))).toMatchObject({ status: 503, code: 'ARCA_NO_DISPONIBLE' })
  })
  it('config y TA perdido conservan su código', () => {
    expect(errorArca(arca('ARCA_NO_CONFIGURADO'))).toMatchObject({ status: 503, code: 'ARCA_NO_CONFIGURADO' })
    expect(errorArca(arca('ARCA_TA_PERDIDO'), { hasta: 'x' })).toMatchObject({ status: 503, code: 'ARCA_TA_PERDIDO', detail: { hasta: 'x' } })
  })
  it('un FacturacionHttpError pasa tal cual; otra cosa es 503', () => {
    const f = new FacturacionHttpError(409, 'EMISION_EN_CURSO')
    expect(errorArca(f)).toBe(f)
    expect(errorArca(new Error('x'))).toMatchObject({ status: 503, code: 'ARCA_NO_DISPONIBLE' })
  })
})

describe('cuerpoError', () => {
  it('422 ARCA_RECHAZO lleva detail y la factura al lado', () => {
    const e = new FacturacionHttpError(422, 'ARCA_RECHAZO', { errores: [], observaciones: [{ code: 10016, msg: 'x' }] }, { factura: { factura: { id: 1 } } })
    expect(cuerpoError(e)).toEqual({
      error: 'ARCA_RECHAZO',
      detail: { errores: [], observaciones: [{ code: 10016, msg: 'x' }] },
      factura: { factura: { id: 1 } },
    })
  })
  it('campo sale arriba para el modal', () => {
    expect(cuerpoError(new FacturacionHttpError(400, 'CUIT_INVALIDO', { campo: 'doc_nro' })))
      .toEqual({ error: 'CUIT_INVALIDO', campo: 'doc_nro', detail: { campo: 'doc_nro' } })
  })
})
