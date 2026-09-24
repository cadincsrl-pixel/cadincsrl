/**
 * Cobranzas de Ventas (20260924k…n): auditoría de las rutas nuevas, status de
 * los códigos de la base y normalización de filas del importador de ARCA.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))
vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
  createSupabaseClient: () => ({}),
}))

import { parseRoute, extraerId } from '../../../src/middleware/audit.js'
import { mapRpcError } from '../../../src/modules/facturacion/facturacion.errors.js'
import { normalizarFila, parsearCsv, normImporte, cbteTipoDe } from '../../../src/modules/facturacion/externos.service.js'
import { RegistrarCobroSchema, CompensarSchema } from '../../../src/modules/facturacion/facturacion.schema.js'

const M = 'facturacion'
describe('parseRoute — cobranzas', () => {
  it.each([
    ['POST',   '/api/facturacion/cobros',                            { modulo: M, entidad: 'cobro', accion: 'crear' }],
    ['POST',   '/api/facturacion/cobros/5/imputar',                  { modulo: M, entidad: 'cobro', accion: 'imputar', entidadId: '5' }],
    ['POST',   '/api/facturacion/cobros/5/anular',                   { modulo: M, entidad: 'cobro', accion: 'anular', entidadId: '5' }],
    ['POST',   '/api/facturacion/imputaciones/9/anular',             { modulo: M, entidad: 'imputación', accion: 'anular', entidadId: '9' }],
    ['POST',   '/api/facturacion/compensaciones',                    { modulo: M, entidad: 'imputación', accion: 'crear' }],
    ['POST',   '/api/facturacion/cobros/retenciones/upload-url',     { modulo: M, entidad: 'certificado de retención', accion: 'subir adjunto' }],
    ['POST',   '/api/facturacion/cobros/retenciones/7/adjunto',      { modulo: M, entidad: 'certificado de retención', accion: 'adjuntar certificado', entidadId: '7' }],
    ['POST',   '/api/facturacion/externos',                          { modulo: M, entidad: 'comprobante externo', accion: 'crear' }],
    ['PATCH',  '/api/facturacion/externos/3',                        { modulo: M, entidad: 'comprobante externo', accion: 'actualizar', entidadId: '3' }],
    ['DELETE', '/api/facturacion/externos/3',                        { modulo: M, entidad: 'comprobante externo', accion: 'eliminar', entidadId: '3' }],
    ['POST',   '/api/facturacion/externos/importar',                 { modulo: M, entidad: 'comprobante externo', accion: 'importar' }],
    ['POST',   '/api/facturacion/externos/marcar',                   { modulo: M, entidad: 'comprobante externo', accion: 'marcar saldo' }],
    ['PATCH',  '/api/facturacion/facturas/12/vencimiento',           { modulo: M, entidad: 'factura de venta', accion: 'cambiar vencimiento', entidadId: '12' }],
  ])('%s %s', (method, path, esperado) => {
    expect(parseRoute(path, method)).toEqual(esperado)
  })

  it('el POST /cobros devuelve { cobro, medios, … }: el id sale de `cobro`', () => {
    expect(extraerId({ cobro: { id: 41, numero: 3 }, medios: [], retenciones: [], imputaciones: [] })).toBe('41')
  })
})

describe('mapRpcError — códigos de cobranzas', () => {
  it.each([
    ['SIN_PERMISO_COBROS', 403], ['SIN_PERMISO_ANULAR', 403],
    ['COBRO_NO_EXISTE', 404], ['DESTINO_NO_EXISTE', 404], ['EXTERNO_NO_EXISTE', 404],
    ['MEDIO_INVALIDO', 400], ['RETENCION_INVALIDA', 400], ['FECHA_FUTURA', 400], ['COBRO_TOTAL_CERO', 400],
    ['IMPUTACION_SUPERA_SALDO', 409], ['IMPUTACION_SUPERA_COBRO', 422], ['IMPUTACION_SUPERA_CREDITO', 422],
    ['OTRO_CLIENTE', 422], ['NC_A_SU_FACTURA', 422], ['IMPORTACION_CON_ERRORES', 422],
    ['CHEQUE_DUPLICADO', 409], ['COBRO_YA_ANULADO', 409], ['EXTERNO_CON_IMPUTACIONES', 409],
    ['EXTERNO_DUPLICA_FACTURA_ERP', 409], ['VENCE_ES_EL_DE_LA_FCE', 409],
  ])('%s → %i', (code, status) => {
    expect(mapRpcError({ message: code, code: 'P0001', details: null })).toMatchObject({ code, status })
  })

  it('IMPUTACION_SUPERA_SALDO trae destino y saldo en el detail', () => {
    const e = mapRpcError({ message: 'IMPUTACION_SUPERA_SALDO', code: 'P0001',
      details: '{"destino" : {"factura_id" : 8, "comprobante" : "FA 00003-00000005"}, "saldo" : 100.00, "importe" : 150.00}' })
    expect(e.detail).toEqual({ destino: { factura_id: 8, comprobante: 'FA 00003-00000005' }, saldo: 100, importe: 150 })
  })
})

describe('importador de ARCA — normalizarFila', () => {
  it('fila del Excel «Mis Comprobantes — Emitidos» tal cual', () => {
    const f = normalizarFila({
      'Fecha': '01/07/2026', 'Tipo': '1 - Factura A', 'Punto de Venta': 2, 'Número Desde': 1158, 'Número Hasta': null,
      'Tipo Doc. Comprador': 'CUIT', 'Nro. Doc. Comprador': 30716052121, 'Denominación Comprador': 'TRANSPORTE GLOBAL S.A.S.',
      'Tipo Cambio': 1, 'Moneda': '$', 'Neto Gravado': 1006950, 'No Gravado': 0, 'Exento': 0, 'IVA': 211459.5, 'Total': 1218409.5,
    })
    expect(f).toEqual({
      fecha: '2026-07-01', cbte_tipo: '1 - Factura A', pto_vta: '2', numero: '1158', rec_doc_tipo: 'CUIT',
      rec_doc_nro: '30716052121', rec_razon_social: 'TRANSPORTE GLOBAL S.A.S.', tipo_cambio: 1, moneda: 'PES',
      neto: 1006950, no_gravado: 0, exento: 0, iva: 211459.5, total: 1218409.5,
    })
  })

  it('fecha como número de serie de Excel', () => {
    expect(normalizarFila({ Fecha: 46204 }).fecha).toBe('2026-07-01')
  })

  it('claves de la RPC pasan sin cambios', () => {
    expect(normalizarFila({ cbte_tipo: 3, pto_vta: '2', numero: '144', fecha: '2026-07-01', total: '5984250', saldo: '' }))
      .toEqual({ cbte_tipo: 3, pto_vta: '2', numero: '144', fecha: '2026-07-01', total: 5984250, saldo: null })
  })

  it.each([
    ['1.218.409,50', 1218409.5], ['1218409.50', 1218409.5], ['$ 1.234', 1234], ['1,5', 1.5], ['1,234,567.89', 1234567.89],
  ])('importe %s → %d', (txt, n) => expect(normImporte(txt)).toBe(n))

  it('CSV con fila de título, punto y coma y comillas', () => {
    const csv = 'Comprobantes de Ventas - CUIT 33717191949\nFecha;Tipo;Punto de Venta;Número Desde;Denominación Comprador;Total\n'
      + '01/07/2026;1 - Factura A;2;1158;"GLOBAL; S.A.S.";"1.218.409,50"\n'
    const filas = parsearCsv(csv).map(normalizarFila)
    expect(filas).toEqual([{ fecha: '2026-07-01', cbte_tipo: '1 - Factura A', pto_vta: '2', numero: '1158', rec_razon_social: 'GLOBAL; S.A.S.', total: 1218409.5 }])
  })

  it('tipo + letra → código de ARCA', () => {
    expect([cbteTipoDe('FC', 'A'), cbteTipoDe('NC', 'B'), cbteTipoDe('ND', 'A')]).toEqual([1, 8, 2])
  })
})

describe('schemas de cobranzas', () => {
  it('la imputación exige factura_id o externo_id, no los dos', () => {
    const base = { cobro: { cliente_id: 2 }, medios: [{ forma: 'efectivo', importe: 10 }] }
    expect(RegistrarCobroSchema.safeParse({ ...base, imputaciones: [{ factura_id: 1, importe: 5 }] }).success).toBe(true)
    expect(RegistrarCobroSchema.safeParse({ ...base, imputaciones: [{ factura_id: 1, externo_id: 2, importe: 5 }] }).success).toBe(false)
    expect(RegistrarCobroSchema.safeParse({ ...base, imputaciones: [{ importe: 5 }] }).success).toBe(false)
  })

  it('la compensación exige una sola NC de origen', () => {
    expect(CompensarSchema.safeParse({ nc: { factura_id: 5 }, items: [{ factura_id: 6, importe: 1 }] }).success).toBe(true)
    expect(CompensarSchema.safeParse({ nc: {}, items: [{ factura_id: 6, importe: 1 }] }).success).toBe(false)
  })
})
