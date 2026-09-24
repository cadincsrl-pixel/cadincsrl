/**
 * Mapeo de errores de Contabilidad: códigos de las RPC (20260926a…f) → status,
 * el `campo` de las líneas (`lineas.<indice>.<campo>`), unique_violation y la
 * traducción de los issues de zod.
 */
import { describe, it, expect } from 'vitest'

import {
  ContabilidadHttpError, mapRpcError, cuerpoError, campoDe, STATUS_POR_CODIGO, errorDeZod,
} from '../../../src/modules/contabilidad/contabilidad.errors.js'

describe('mapRpcError', () => {
  it.each([
    ['ASIENTO_NO_EXISTE', 404], ['CUENTA_NO_EXISTE', 404], ['PERIODO_NO_EXISTE', 404],
    ['SIN_PERMISO_ASIENTOS', 403], ['SIN_PERMISO_PLAN', 403], ['SIN_PERMISO_CERRAR', 403],
    ['FECHA_SIN_PERIODO', 400], ['CUENTA_NO_IMPUTABLE', 400], ['AUXILIAR_REQUERIDO', 400], ['RANGO_EXCEDE_EJERCICIO', 400],
    ['ASIENTO_DESBALANCEADO', 422], ['ASIENTO_TOTAL_CERO', 422], ['IMPORTACION_CON_ERRORES', 422],
    ['PERIODO_CERRADO', 409], ['HAY_BORRADORES', 409], ['PERIODO_POSTERIOR_CERRADO', 409], ['ASIENTO_YA_REVERTIDO', 409],
    ['CUENTA_CON_MOVIMIENTOS', 409], ['CUENTA_EN_USO', 409], ['APERTURA_DUPLICADA', 409],
    ['ASIENTO_SOLO_RPC', 500], ['NUMERO_SOLO_AL_CERRAR', 500],
  ])('%s → %i', (code, status) => {
    const e = mapRpcError({ message: code, code: 'P0001' })
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
  })

  it('parsea el detail JSON', () => {
    const e = mapRpcError({ message: 'ASIENTO_DESBALANCEADO', details: '{"asiento_id":3,"debe":10,"haber":9,"diferencia":1}' })
    expect(e.detail).toEqual({ asiento_id: 3, debe: 10, haber: 9, diferencia: 1 })
  })

  it('el error del trigger diferido llega con el mensaje del COMMIT y se mapea igual', () => {
    expect(mapRpcError({ message: 'ASIENTO_DESBALANCEADO', code: 'P0001' }).status).toBe(422)
  })

  it('unique_violation → unicoComo o DUPLICADO', () => {
    expect(mapRpcError({ code: '23505', message: 'duplicate key' }, { unicoComo: 'CODIGO_DUPLICADO' })).toMatchObject({ status: 409, code: 'CODIGO_DUPLICADO' })
    expect(mapRpcError({ code: '23505', message: 'duplicate key' }).code).toBe('DUPLICADO')
  })

  it('desconocido → 500 DB_ERROR', () => {
    expect(mapRpcError({ message: 'connection reset', code: '08006' })).toMatchObject({ status: 500, code: 'DB_ERROR' })
    expect(mapRpcError({ message: 'CODIGO_QUE_NO_EXISTE' }).code).toBe('DB_ERROR')
  })

  it('todos los códigos tienen un status HTTP válido', () => {
    for (const s of Object.values(STATUS_POR_CODIGO)) expect([400, 403, 404, 409, 422, 500]).toContain(s)
  })
})

describe('campo del cuerpo', () => {
  it('detail.indice → lineas.<indice>.<campo>', () => {
    expect(campoDe({ indice: 2, campo: 'cuenta_id' })).toBe('lineas.2.cuenta_id')
    expect(campoDe({ indice: 0 })).toBe('lineas.0')
    expect(campoDe({ campo: 'motivo' })).toBe('motivo')
    expect(campoDe('texto')).toBeUndefined()
  })

  it('cuerpoError', () => {
    const e = mapRpcError({ message: 'AUXILIAR_REQUERIDO', details: '{"indice":1,"campo":"aux_id"}' })
    expect(cuerpoError(e)).toEqual({ error: 'AUXILIAR_REQUERIDO', campo: 'lineas.1.aux_id', detail: { indice: 1, campo: 'aux_id' } })
    expect(cuerpoError(new ContabilidadHttpError(404, 'ASIENTO_NO_EXISTE'))).toEqual({ error: 'ASIENTO_NO_EXISTE' })
  })
})

describe('errorDeZod', () => {
  it('mensaje-código conocido → ese error y su status, con params en el detail', () => {
    expect(errorDeZod({ path: ['lineas'], message: 'ASIENTO_DESBALANCEADO', params: { debe: 10, haber: 9, diferencia: 1 } })).toEqual({
      status: 422, body: { error: 'ASIENTO_DESBALANCEADO', campo: 'lineas', detail: { campo: 'lineas', debe: 10, haber: 9, diferencia: 1 } },
    })
    expect(errorDeZod({ path: ['lineas', 1, 'haber'], message: 'LINEA_IMPORTE_INVALIDO' })).toMatchObject({
      status: 400, body: { error: 'LINEA_IMPORTE_INVALIDO', campo: 'lineas.1.haber' },
    })
  })

  it('mensaje común → DATOS_INVALIDOS', () => {
    expect(errorDeZod({ path: ['fecha'], message: 'fecha YYYY-MM-DD' })).toEqual({
      status: 400, body: { error: 'DATOS_INVALIDOS', campo: 'fecha', detail: { campo: 'fecha', mensaje: 'fecha YYYY-MM-DD' } },
    })
  })
})
