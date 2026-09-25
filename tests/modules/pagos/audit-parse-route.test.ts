/**
 * parseRoute (src/middleware/audit.ts) con las rutas del módulo Pagos: qué
 * módulo/entidad/acción/id queda en audit_log. Sin las entradas de ENTIDADES
 * para adjuntos, `DELETE /pagos/facturas/12/adjuntos/7` se leía como «eliminar
 * factura de proveedor 7»; sin los VERBOS, «observar» quedaba como id.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))
vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
  createSupabaseClient: () => ({}),
}))

import { parseRoute } from '../../../src/middleware/audit.js'

describe('parseRoute — módulo pagos', () => {
  it.each([
    ['POST',   '/api/pagos/facturas',                        { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'crear' }],
    ['PATCH',  '/api/pagos/facturas/12',                     { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'actualizar', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/12/aprobar',             { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'aprobar', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/aprobar',                { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'aprobar' }],
    ['POST',   '/api/pagos/facturas/12/observar',            { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'observar', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/12/corregida',           { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'marcar corregida', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/12/aplicar-nc',          { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'aplicar nota de crédito', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/12/anular',              { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'anular', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/12/adjuntos/upload-url', { modulo: 'pagos', entidad: 'adjunto de factura', accion: 'subir adjunto', entidadId: '12' }],
    ['POST',   '/api/pagos/facturas/12/adjuntos',            { modulo: 'pagos', entidad: 'adjunto de factura', accion: 'crear', entidadId: '12' }],
    ['DELETE', '/api/pagos/facturas/12/adjuntos/7',          { modulo: 'pagos', entidad: 'adjunto de factura', accion: 'eliminar', entidadId: '7' }],
    ['POST',   '/api/pagos/facturas/upload-lectura',         { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'subir adjunto' }],
    ['POST',   '/api/pagos/facturas/leer',                   { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'leer comprobante' }],
    ['DELETE', '/api/pagos/facturas/lectura-pendiente',      { modulo: 'pagos', entidad: 'factura de proveedor', accion: 'descartar lectura' }],
    ['POST',   '/api/pagos/ordenes',                         { modulo: 'pagos', entidad: 'orden de pago', accion: 'crear' }],
    ['POST',   '/api/pagos/ordenes/upload-comprobante',      { modulo: 'pagos', entidad: 'orden de pago', accion: 'subir adjunto' }],
    ['DELETE', '/api/pagos/ordenes/comprobante-pendiente',   { modulo: 'pagos', entidad: 'orden de pago', accion: 'descartar comprobante' }],
    ['POST',   '/api/pagos/ordenes/3/anular',                { modulo: 'pagos', entidad: 'orden de pago', accion: 'anular', entidadId: '3' }],
    ['PATCH',  '/api/pagos/ordenes/3',                       { modulo: 'pagos', entidad: 'orden de pago', accion: 'actualizar', entidadId: '3' }],
    ['POST',   '/api/pagos/ordenes/3/registrar-finnegans',   { modulo: 'pagos', entidad: 'orden de pago', accion: 'registrar en Finnegans', entidadId: '3' }],
    ['POST',   '/api/pagos/importaciones/13/deshacer',       { modulo: 'pagos', entidad: 'importación ARCA', accion: 'deshacer', entidadId: '13' }],
    ['POST',   '/api/pagos/ordenes/3/deshacer-registro',     { modulo: 'pagos', entidad: 'orden de pago', accion: 'deshacer registro en Finnegans', entidadId: '3' }],
    ['DELETE', '/api/pagos/ordenes/3/adjuntos/9',            { modulo: 'pagos', entidad: 'adjunto de orden de pago', accion: 'eliminar', entidadId: '9' }],
    ['POST',   '/api/pagos/proveedores',                     { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'crear' }],
    ['PATCH',  '/api/pagos/proveedores/7',                   { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'actualizar', entidadId: '7' }],
    ['PATCH',  '/api/pagos/proveedores/7/datos-pago',        { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'cargar datos de pago', entidadId: '7' }],
    ['POST',   '/api/pagos/proveedores/7/baja',              { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'dar de baja', entidadId: '7' }],
    ['POST',   '/api/pagos/proveedores/7/reactivar',         { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'reactivar', entidadId: '7' }],
  ] as const)('%s %s', (method, path, esperado) => {
    const r = parseRoute(path, method)
    expect(r).toEqual(esperado)
  })

  it('los GET no se auditan', () => {
    expect(parseRoute('/api/pagos/facturas', 'GET')).toBeNull()
    expect(parseRoute('/api/pagos/facturas/resumen', 'GET')).toBeNull()
  })

  it('el verbo no queda guardado como id', () => {
    expect(parseRoute('/api/pagos/facturas/12/observar', 'POST')?.entidadId).toBe('12')
    expect(parseRoute('/api/pagos/proveedores/7/reactivar', 'POST')?.entidadId).toBe('7')
  })
})
