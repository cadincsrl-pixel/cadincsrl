/**
 * «Soltá acá los comprobantes de pagos» en Compras › Pagos (2026-09-25): el
 * saneo de la lectura, la cuenta de tesorería de una transferencia, el
 * proveedor y sus facturas, los avisos de cheque o pago ya registrados, y el
 * alta del pago reconstruido. La IA y el bucket van mockeados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { tablas, ia, rpc, inserts, moves } = vi.hoisted(() => ({
  tablas: {} as Record<string, unknown[]>,
  ia: { res: null as unknown },
  rpc: vi.fn(),
  inserts: [] as unknown[],
  moves: [] as unknown[],
}))

function chain(data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit', 'gte', 'lte', 'ilike']) obj[m] = () => obj
  obj.maybeSingle = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.insert = (rows: unknown) => { inserts.push(rows); return Promise.resolve({ error: null }) }
  obj.then = (ok: any, ko: any) => Promise.resolve({ data, error: null }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: {
    from: (t: string) => chain(tablas[t] ?? []),
    rpc,
    storage: { from: () => ({ download: async () => ({ data: new Blob(['x']), error: null }) }) },
  },
  createSupabaseClient: vi.fn(),
}))
vi.mock('../../../src/modules/pagos/lectura/comprobante-pago-ia.js', () => ({
  leerComprobantePagoConIA: vi.fn(async () => ia.res),
}))
vi.mock('../../../src/modules/pagos/adjuntos.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  BUCKET: 'pagos-docs',
  procesarPendientes: vi.fn(async (a: any[]) => a.map((x) => ({ ...x, hash_sha256: 'h'.repeat(64), size_bytes: 10 }))),
  moverPendientesAOrden: vi.fn(async (id: number, a: unknown[]) => { moves.push({ id, a }) }),
  borrarDelBucket: vi.fn(async () => undefined),
}))
vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))

import {
  comprobantesPagoService, cuentaDeOrigen, documentoPagoDeLectura, proveedorPorPrimeraPalabra,
} from '../../../src/modules/pagos/comprobantes-pago.service.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const CUENTAS = [
  { id: 1, nombre: 'Banco Galicia', banco: 'Galicia', tipo: 'banco' },
  { id: 2, nombre: 'Banco Macro c/c', banco: 'Macro', tipo: 'banco' },
  { id: 12, nombre: 'Banco Galicia USD c/397', banco: 'Galicia', tipo: 'banco' },
  { id: 3, nombre: 'Caja', banco: null, tipo: 'caja' },
]

const lectura = (o: Record<string, unknown> = {}) => ({
  legible: true, tipo_documento: 'recibo', fecha: '2026-09-05', proveedor_nombre: 'PIZARRO REFRIGERACION S.R.L.', proveedor_cuit: '30716871009',
  medios: [{ forma: 'echeq', importe: 487452.42, numero: '3010', banco: 'Galicia', fecha_cobro: '2026-09-19', librador: 'CADINC SRL', librador_cuit: null, es_endoso: false, cuenta_origen: null, entregado_a: null, entregado_a_cuit: null }],
  comprobantes: [{ tipo: 'FAC A', pto_vta: 12, numero: 7511, importe: 487452.42 }],
  recibo_numero: '0001-00006131', total: 487452.42, notas: null, ...o,
})

describe('saneo de la lectura (documentoPagoDeLectura)', () => {
  it('recibo del proveedor: e-cheq propio y la factura que cancela', () => {
    const d = documentoPagoDeLectura(lectura())
    expect(d.tipo_documento).toBe('recibo')
    expect(d.medios[0]).toMatchObject({ forma: 'echeq', numero: '3010', importe: 487452.42, es_propio: true })
    expect(d.comprobantes).toEqual([{ tipo: 'FAC A', pto_vta: 12, numero: 7511, numero_fmt: '00012-00007511', importe: 487452.42 }])
    expect(d.avisos).toEqual([])
  })
  it('endoso = de tercero; total que no cierra avisa; un resumen de cuenta se marca como respaldo', () => {
    const d = documentoPagoDeLectura(lectura({
      medios: [{ forma: 'e-cheq', importe: 100, numero: '0003697', banco: 'Galicia', fecha_cobro: null, librador: 'MAGHREB SA', librador_cuit: null, es_endoso: true, cuenta_origen: null, entregado_a: null, entregado_a_cuit: null }],
      total: 150,
    }))
    expect(d.medios[0]).toMatchObject({ es_propio: false, numero: '0003697' })
    expect(d.avisos.map((a) => a.codigo)).toContain('TOTAL_NO_CIERRA')
    expect(documentoPagoDeLectura(lectura({ tipo_documento: 'resumen_cuenta', total: 1 })).avisos.map((a) => a.codigo)).toEqual(['ES_RESUMEN'])
  })
})

describe('proveedor por el nombre de fantasía (proveedorPorPrimeraPalabra)', () => {
  const PADRON = [
    { id: 116, razon_social: 'PIZARRO REFRIGERACION S.R.L.', cuit: null },
    { id: 2, razon_social: 'NORTE OBRAS SRL', cuit: null },
    { id: 3, razon_social: 'NORTE HIERROS SA', cuit: null },
  ]
  it('una sola coincidencia por la primera palabra; con dos o palabra corta, no adivina', () => {
    expect(proveedorPorPrimeraPalabra('PIZARRO CLIMATIZACION', PADRON)).toMatchObject({ id: 116 })
    expect(proveedorPorPrimeraPalabra('Norte Aberturas', PADRON)).toBeNull()
    expect(proveedorPorPrimeraPalabra('ABC Materiales', PADRON)).toBeNull()
  })
})

describe('cuenta de origen de una transferencia (cuentaDeOrigen)', () => {
  it('por banco (la de pesos), no la de dólares; sin banco, null', () => {
    expect(cuentaDeOrigen('Banco de Galicia CC 4736', CUENTAS)).toBe(1)
    expect(cuentaDeOrigen('MACRO', CUENTAS)).toBe(2)
    expect(cuentaDeOrigen('Banco Nación', CUENTAS)).toBeNull()
    expect(cuentaDeOrigen(null, CUENTAS)).toBeNull()
  })
})

describe('POST /pagos/comprobantes/leer', () => {
  beforeEach(() => {
    for (const k of Object.keys(tablas)) delete tablas[k]
    tablas.pagos_proveedores = [{ id: 116, razon_social: 'PIZARRO REFRIGERACION S.R.L.', cuit: '30716871009' }]
    tablas.tesoreria_cuentas = CUENTAS
  })
  it('reconoce al proveedor, trae sus facturas (primero la nombrada) y avisa si el cheque ya está en una OP', async () => {
    ia.res = { ok: true, modelo: 'm', lectura: lectura() }
    tablas.v_pagos_facturas = [
      { id: 800, proveedor_id: 116, numero: '00012-00007526', fecha: '2026-09-07', total: 154677.16, saldo: 154677.16, estado: 'pendiente', pago_a_reconstruir: true, clase: 'factura' },
      { id: 742, proveedor_id: 116, numero: '00012-00007511', fecha: '2026-09-02', total: 487452.42, saldo: 0, estado: 'pagada', pago_a_reconstruir: false, clase: 'factura' },
      { id: 999, proveedor_id: 116, numero: '00012-00007400', fecha: '2026-07-01', total: 10, saldo: 0, estado: 'pagada', pago_a_reconstruir: false, clase: 'factura' },
    ]
    tablas.pagos_cheques = [{ numero: '3010', monto: 487452.42, pagos_ordenes: { numero: 25, estado: 'emitida' } }]
    const r = await comprobantesPagoService.leer({ storage_path: 'ordenes/pendientes/x.pdf', mime_type: 'application/pdf' })
    expect(r.proveedor).toMatchObject({ id: 116, por: 'cuit' })
    expect(r.facturas.map((f) => f.id)).toEqual([742, 800]) // la nombrada primero; la pagada y no nombrada, afuera
    expect(r.facturas[0]).toMatchObject({ nombrada: true, importe_papel: 487452.42 })
    expect(r.medios[0]!.avisos[0]).toMatchObject({ codigo: 'CHEQUE_YA_REGISTRADO' })
    expect(r.avisos.map((a) => a.codigo)).toContain('FACTURA_YA_PAGADA')
    expect(r.medios[0]!.proveedor_id).toBe(116)
  })
  it('un PDF de endosos a varios proveedores: cada medio con el suyo', async () => {
    tablas.pagos_proveedores = [
      { id: 116, razon_social: 'PIZARRO REFRIGERACION S.R.L.', cuit: '30716871009' },
      { id: 114, razon_social: 'MONTEROS HORMIGON S.A.', cuit: null },
    ]
    ia.res = { ok: true, modelo: 'm', lectura: lectura({ tipo_documento: 'echeq', proveedor_nombre: null, proveedor_cuit: null, comprobantes: [], total: null, medios: [
      { forma: 'echeq', importe: 10, numero: '1', banco: 'Galicia', fecha_cobro: '2026-09-01', librador: 'X SA', librador_cuit: null, es_endoso: true, cuenta_origen: null, entregado_a: 'Pizarro Refrigeración SRL', entregado_a_cuit: null },
      { forma: 'echeq', importe: 20, numero: '2', banco: 'Galicia', fecha_cobro: '2026-09-01', librador: 'X SA', librador_cuit: null, es_endoso: true, cuenta_origen: null, entregado_a: 'MONTEROS HORMIGON', entregado_a_cuit: null },
    ] }) }
    const r = await comprobantesPagoService.leer({ storage_path: 'ordenes/pendientes/x.pdf', mime_type: 'application/pdf' })
    expect(r.medios.map((m) => m.proveedor_id)).toEqual([116, 114])
  })
  it('path fuera de pendientes: 400; ilegible: 422', async () => {
    await expect(comprobantesPagoService.leer({ storage_path: 'facturas/1/x.pdf', mime_type: 'application/pdf' })).rejects.toMatchObject({ status: 400 })
    ia.res = { ok: false, motivo: 'SIN_API_KEY', modelo: null }
    await expect(comprobantesPagoService.leer({ storage_path: 'ordenes/pendientes/x.pdf', mime_type: 'application/pdf' })).rejects.toMatchObject({ status: 422, code: 'COMPROBANTE_ILEGIBLE' })
  })
})

describe('POST /pagos/ordenes/reconstruir', () => {
  beforeEach(() => { rpc.mockReset(); inserts.length = 0; moves.length = 0; tablas.pagos_ordenes = [{ id: 400, numero: 300 }] })
  it('llama a pagos_reconstruir_orden con las líneas y el a cuenta, y adjunta los papeles', async () => {
    rpc.mockResolvedValue({ data: 400, error: null })
    const r = await comprobantesPagoService.reconstruir({
      proveedor_id: 116, fecha: '2026-08-31', forma_pago: 'echeq', monto_pagado: 30000, cuenta_origen_id: 1, referencia: 'E-cheq 2989',
      cheques: [{ numero: '2989', banco: 'Galicia', fecha_cobro: '2026-09-01', monto: 30000, es_propio: true, librador: '' }],
      lineas: [{ factura_id: 333, monto: 26425.52 }], a_cuenta: 3574.48,
      adjuntos: [{ tipo: 'comprobante_pago', storage_path: 'ordenes/pendientes/a.pdf', nombre_archivo: 'a.pdf', mime_type: 'application/pdf' }],
    }, 'u-1')
    expect(rpc).toHaveBeenCalledWith('pagos_reconstruir_orden', expect.objectContaining({
      p_proveedor_id: 116,
      p_lineas: [{ tipo: 'factura', factura_id: 333, monto: 26425.52 }, { tipo: 'a_cuenta', monto: 3574.48 }],
      p_orden: expect.objectContaining({ forma_pago: 'echeq', cheques: [expect.objectContaining({ numero: '2989' })] }),
    }))
    expect(r).toEqual({ orden_id: 400, numero: 300, adjuntos_error: null })
    expect(inserts).toHaveLength(1)
    expect(moves).toHaveLength(1)
  })
  it('si la base rechaza, borra los papeles subidos y devuelve el error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'FACTURA_NO_A_RECONSTRUIR', details: '{"factura_id":1}' } })
    await expect(comprobantesPagoService.reconstruir({
      proveedor_id: 1, fecha: '2026-08-31', forma_pago: 'efectivo', monto_pagado: 10, referencia: 'x y z', lineas: [{ factura_id: 1, monto: 10 }], adjuntos: [],
    }, 'u-1')).rejects.toBeTruthy()
  })
})

describe('auditoría', () => {
  it('leer no es un alta; reconstruir se registra como tal', () => {
    expect(parseRoute('/api/pagos/comprobantes/leer', 'POST')).toMatchObject({ modulo: 'pagos', entidad: 'comprobante de pago', accion: 'leer comprobante' })
    expect(parseRoute('/api/pagos/ordenes/reconstruir', 'POST')).toMatchObject({ modulo: 'pagos', entidad: 'orden de pago', accion: 'registrar pago reconstruido' })
  })
})
