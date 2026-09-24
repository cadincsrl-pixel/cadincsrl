/**
 * Completar el desglose de una factura ya cargada (20260924v): cómo se mide
 * la propuesta de la lectura contra la factura guardada, el schema del POST y
 * el mapeo de los errores nuevos de la RPC.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/lib/supabase.js', () => ({ supabase: {}, createSupabaseClient: () => ({}) }))
vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))

import { evaluarDesglose } from '../../../src/modules/pagos/desglose.service.js'
import { CompletarDesgloseSchema, LeerAdjuntoSchema, ListFacturasQuerySchema } from '../../../src/modules/pagos/pagos.schema.js'
import { mapRpcError } from '../../../src/modules/pagos/pagos.errors.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const base = { no_gravado: null, exento: null, neto: null, cae: '76384512345678', cae_vto: '2026-10-01', cbte_tipo_arca: 1 }

describe('evaluarDesglose', () => {
  it('A con 21 % que cierra exacto y sin percepciones: completable', () => {
    const r = evaluarDesglose({ ...base, total: 24995, iva: [{ alicuota_id: 5, base_imp: 20657.02, importe: 4337.98 }], tributos: [] },
      { total: '24995.00', percepciones: null, tipo_comprobante: 'A' })
    expect(r.completable).toBe(true)
    expect(r.cierre).toMatchObject({ total_igual: true, cuadra_con_total: true, percepciones_iguales: true, sin_iva: false })
    expect(r.desglose.neto).toBeNull()          // con alícuotas lo deriva la base
    expect(r.desglose.cae).toBe('76384512345678')
  })

  it('el papel dice otro total (la #9: 24.994,52 vs 24.995): NO completable', () => {
    const r = evaluarDesglose({ ...base, total: 24994.52, iva: [{ alicuota_id: 5, base_imp: 20656.63, importe: 4337.89 }], tributos: [] },
      { total: 24995, percepciones: null, tipo_comprobante: 'A' })
    expect(r.cierre.total_igual).toBe(false)
    expect(r.cierre.cuadra_con_total).toBe(false)
    expect(r.completable).toBe(false)
  })

  it('percepciones en el papel y 0 en la factura: NO completable (cambiaría lo imputado)', () => {
    const r = evaluarDesglose({ ...base, total: 1250,
      iva: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }],
      tributos: [{ tipo: 'percepcion_iibb', jurisdiccion: 'Tucumán', descripcion: 'IIBB', alicuota: 4, base_imp: 1000, importe: 40 }] },
      { total: 1250, percepciones: 0, tipo_comprobante: 'A' })
    expect(r.cierre.cuadra_con_total).toBe(true)
    expect(r.cierre.percepciones_papel).toBe(40)
    expect(r.cierre.percepciones_iguales).toBe(false)
    expect(r.completable).toBe(false)
  })

  it('percepciones iguales a las cargadas e impuestos internos: completable', () => {
    const r = evaluarDesglose({ ...base, total: 1260,
      iva: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }],
      tributos: [
        { tipo: 'percepcion_iva', jurisdiccion: null, descripcion: '', alicuota: 3, base_imp: 1000, importe: 30 },
        { tipo: 'impuestos_internos', jurisdiccion: null, descripcion: '', alicuota: null, base_imp: null, importe: 20 },
      ] },
      { total: 1260, percepciones: '30.00', tipo_comprobante: 'A' })
    expect(r.completable).toBe(true)
  })

  it('A sin alícuotas ni exento: sin_iva, NO completable', () => {
    const r = evaluarDesglose({ ...base, total: 100, iva: [], tributos: [] }, { total: 100, percepciones: null, tipo_comprobante: 'A' })
    expect(r.cierre.sin_iva).toBe(true)
    expect(r.completable).toBe(false)
  })

  it('C sin alícuotas: neto = total, completable', () => {
    const r = evaluarDesglose({ ...base, total: 5000, iva: [], tributos: [] }, { total: 5000, percepciones: null, tipo_comprobante: 'C' })
    expect(r.desglose.neto).toBe(5000)
    expect(r.completable).toBe(true)
  })

  it('dos alícuotas con redondeo de centavos dentro de la tolerancia', () => {
    const r = evaluarDesglose({ ...base, total: 331.51,
      iva: [{ alicuota_id: 5, base_imp: 100, importe: 21 }, { alicuota_id: 4, base_imp: 190.5, importe: 20.0025 }], tributos: [] },
      { total: 331.51, percepciones: null, tipo_comprobante: 'A' })
    expect(r.cierre.cuadra_con_total).toBe(true)
  })
})

describe('CompletarDesgloseSchema', () => {
  it('exige iva_detalle y tributos (vacíos valen)', () => {
    expect(CompletarDesgloseSchema.safeParse({ tributos: [] }).success).toBe(false)
    expect(CompletarDesgloseSchema.safeParse({ iva_detalle: [], tributos: [] }).success).toBe(true)
  })
  it('rechaza claves desconocidas (no se cuela el total)', () => {
    expect(CompletarDesgloseSchema.safeParse({ iva_detalle: [], tributos: [], total: 10 }).success).toBe(false)
  })
  it('rechaza alícuota repetida y CAE mal formado', () => {
    const iva = [{ alicuota_id: 5, base_imp: 1, importe: 0.21 }, { alicuota_id: 5, base_imp: 2, importe: 0.42 }]
    expect(CompletarDesgloseSchema.safeParse({ iva_detalle: iva, tributos: [] }).success).toBe(false)
    expect(CompletarDesgloseSchema.safeParse({ iva_detalle: [], tributos: [], cae: '123' }).success).toBe(false)
  })
  it('leer-adjunto: todo opcional', () => {
    expect(LeerAdjuntoSchema.safeParse({}).success).toBe(true)
    expect(LeerAdjuntoSchema.safeParse({ qr_texto: 'https://www.afip.gob.ar/fe/qr/?p=x' }).success).toBe(true)
  })
  it('la bandeja acepta el filtro sin_desglose', () => {
    expect(ListFacturasQuerySchema.parse({ sin_desglose: '1' }).sin_desglose).toBe('1')
  })
})

describe('errores de la RPC', () => {
  it.each([
    ['DESGLOSE_CAMBIA_PERCEPCIONES', 409],
    ['DESGLOSE_NO_CUADRA', 400],
    ['DESGLOSE_SIN_IVA', 400],
    ['DESGLOSE_INVALIDO', 400],
    ['DESGLOSE_REQUERIDO', 400],
    ['CAE_INVALIDO', 400],
    ['FACTURA_CON_PAGOS', 409],
  ])('%s → %i', (code, status) => {
    const e = mapRpcError({ message: code, details: '{"actuales":0,"nuevas":40}' })
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
    expect(e.detail).toEqual({ actuales: 0, nuevas: 40 })
  })
})

describe('parseRoute — desglose', () => {
  it('POST /facturas/:id/desglose y /leer-adjunto', () => {
    expect(parseRoute('/api/pagos/facturas/12/desglose', 'POST'))
      .toEqual({ modulo: 'pagos', entidad: 'factura de proveedor', accion: 'completar desglose', entidadId: '12' })
    expect(parseRoute('/api/pagos/facturas/12/leer-adjunto', 'POST'))
      .toEqual({ modulo: 'pagos', entidad: 'factura de proveedor', accion: 'leer comprobante', entidadId: '12' })
  })
})
