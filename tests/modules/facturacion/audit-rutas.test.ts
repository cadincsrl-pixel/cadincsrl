/**
 * parseRoute (src/middleware/audit.ts) con las rutas de Facturación: qué
 * módulo/entidad/acción/id queda en audit_log. Sin los VERBOS nuevos,
 * «emitir» o «volver-a-borrador» quedarían como si fueran el id.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))
vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
  createSupabaseClient: () => ({}),
}))

import { parseRoute, extraerId } from '../../../src/middleware/audit.js'

const F = 'factura de venta'
describe('parseRoute — módulo facturacion', () => {
  it.each([
    ['POST',   '/api/facturacion/facturas',                         { modulo: 'facturacion', entidad: F, accion: 'crear' }],
    ['PATCH',  '/api/facturacion/facturas/12',                      { modulo: 'facturacion', entidad: F, accion: 'actualizar', entidadId: '12' }],
    ['DELETE', '/api/facturacion/facturas/12',                      { modulo: 'facturacion', entidad: F, accion: 'eliminar', entidadId: '12' }],
    ['POST',   '/api/facturacion/facturas/12/emitir',               { modulo: 'facturacion', entidad: F, accion: 'emitir en ARCA', entidadId: '12' }],
    ['POST',   '/api/facturacion/facturas/12/reconciliar',          { modulo: 'facturacion', entidad: F, accion: 'reconciliar con ARCA', entidadId: '12' }],
    ['POST',   '/api/facturacion/facturas/12/descartar',            { modulo: 'facturacion', entidad: F, accion: 'descartar', entidadId: '12' }],
    ['POST',   '/api/facturacion/facturas/12/volver-a-borrador',    { modulo: 'facturacion', entidad: F, accion: 'volver a borrador', entidadId: '12' }],
    ['POST',   '/api/facturacion/facturas/12/registrar-finnegans',  { modulo: 'facturacion', entidad: F, accion: 'registrar en Finnegans', entidadId: '12' }],
    ['POST',   '/api/facturacion/facturas/12/deshacer-registro',    { modulo: 'facturacion', entidad: F, accion: 'deshacer registro en Finnegans', entidadId: '12' }],
    ['POST',   '/api/facturacion/clientes',                         { modulo: 'facturacion', entidad: 'cliente', accion: 'crear' }],
    ['PATCH',  '/api/facturacion/clientes/5',                       { modulo: 'facturacion', entidad: 'cliente', accion: 'actualizar', entidadId: '5' }],
    ['POST',   '/api/facturacion/clientes/5/baja',                  { modulo: 'facturacion', entidad: 'cliente', accion: 'dar de baja', entidadId: '5' }],
    ['POST',   '/api/facturacion/clientes/5/alta',                  { modulo: 'facturacion', entidad: 'cliente', accion: 'dar de alta', entidadId: '5' }],
    ['PUT',    '/api/facturacion/clientes/5/obras',                 { modulo: 'facturacion', entidad: 'obras del cliente', accion: 'actualizar', entidadId: '5' }],
    ['POST',   '/api/facturacion/cuentas',                          { modulo: 'facturacion', entidad: 'cuenta bancaria (FCE)', accion: 'crear' }],
    ['PATCH',  '/api/facturacion/cuentas/2',                        { modulo: 'facturacion', entidad: 'cuenta bancaria (FCE)', accion: 'actualizar', entidadId: '2' }],
    ['POST',   '/api/facturacion/cuentas/2/baja',                   { modulo: 'facturacion', entidad: 'cuenta bancaria (FCE)', accion: 'dar de baja', entidadId: '2' }],
    ['POST',   '/api/facturacion/productos',                        { modulo: 'facturacion', entidad: 'producto de venta', accion: 'crear' }],
    ['PATCH',  '/api/facturacion/productos/3',                      { modulo: 'facturacion', entidad: 'producto de venta', accion: 'actualizar', entidadId: '3' }],
  ])('%s %s', (method, path, esperado) => {
    expect(parseRoute(path, method)).toEqual(esperado)
  })

  it('el POST que crea una factura devuelve el FJ: el id sale de `factura`', () => {
    expect(extraerId({ factura: { id: 33, numero: null }, renglones: [] })).toBe('33')
  })
})
