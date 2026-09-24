/**
 * Rutas del Libro IVA Digital de Compras y de la posición de IVA: guardia
 * (lectura + tab impuestos, o la vieja finnegans), filtros de la lectura y el
 * .txt ANSI con CRLF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, state, filtros } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  state: { profile: null as Fila | null },
  filtros: [] as Array<[string, string, unknown]>,
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

function chain(tabla: string, data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'neq', 'in', 'is', 'order', 'range', 'limit']) obj[m] = () => obj
  for (const m of ['eq', 'gte', 'lte']) obj[m] = (col: string, v: unknown) => { filtros.push([tabla, `${m}:${col}`, v]); return obj }
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: async () => ({ data: null, error: null }) })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { facturacion: p } : {} })
const CONTADOR = perfil({ lectura: true, tabs: ['impuestos'] })
const VIEJO = perfil({ lectura: true, tabs: ['finnegans'] })
const SIN_TAB = perfil({ lectura: true, tabs: ['facturas', 'cobranzas'] })

const COMPRAS = [{
  id: 11, tipo_comprobante: 'A', cbte_tipo_arca: 1, numero: '08837-00004557', fecha: '2026-09-18',
  neto: '116495.87', iva: '24464.13', no_gravado: null, exento: null, total: '152609.59',
  estado: 'pagada', paga_cliente: false, desglose_a_revisar: false,
  proveedor: { razon_social: 'Cencosud S.A', cuit: '30590360763' },
  iva_detalle: [{ alicuota_id: 5, base_imp: 116495.87, importe: 24464.13 }],
  tributos: [{ tipo: 'percepcion_iva', importe: 3494.88 }, { tipo: 'percepcion_iibb', importe: 8154.71 }],
}]
const ERP = [{
  id: 17, cbte_tipo: 1, pto_vta: 4, numero: 1, fecha_cbte: '2026-09-23', fch_vto_pago: null,
  rec_doc_tipo: 80, rec_doc_nro: '33702413309', rec_razon_social: 'PEÑA S.A.', moneda: 'PES', cotizacion: '1',
  imp_neto: '100000.00', imp_iva: '21000.00', imp_trib: '0', imp_op_ex: '0', imp_tot_conc: '0', imp_total: '121000.00',
  alicuotas: [{ alicuota_id: 5, base_imp: 100000, importe: 21000 }],
}]
const RETENCIONES = [
  { fecha: '2026-09-05', importe: '1000', cobro: { fecha: '2026-09-05', estado: 'vigente', ambiente: 'prod' } },
  { fecha: null, importe: '500', cobro: { fecha: '2026-08-30', estado: 'vigente', ambiente: 'prod' } }, // otro mes
]

beforeEach(() => {
  fromMock.mockReset()
  filtros.length = 0
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(t, state.profile)
    if (t === 'pagos_facturas') return chain(t, COMPRAS)
    if (t === 'ventas_facturas') return chain(t, ERP)
    if (t === 'ventas_cobro_retenciones') return chain(t, RETENCIONES)
    return chain(t, [])
  })
})

describe('GET /lid-compras', () => {
  it('el contador (tab impuestos) lo genera con las facturas no anuladas del mes', async () => {
    state.profile = CONTADOR
    const r = await fact.request('/lid-compras?periodo=2026-09')
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b.resumen).toMatchObject({ comprobantes: 1, credito_fiscal: 24464.13, perc_iva: 3494.88 })
    expect(b.archivos.cbte.split('\r\n')[0]).toHaveLength(325)
    expect(filtros).toEqual(expect.arrayContaining([
      ['pagos_facturas', 'gte:fecha', '2026-09-01'], ['pagos_facturas', 'lte:fecha', '2026-09-30'],
    ]))
    // Las NC son comprobantes de pagos_facturas: ya no se leen las líneas de OP.
    expect(filtros.some(f => f[0] === 'pagos_orden_lineas')).toBe(false)
  })

  it('la tab vieja finnegans también pasa; sin tab 403; período mal formado 400', async () => {
    state.profile = VIEJO
    expect((await fact.request('/lid-compras?periodo=2026-09')).status).toBe(200)
    state.profile = SIN_TAB
    expect((await fact.request('/lid-compras?periodo=2026-09')).status).toBe(403)
    state.profile = CONTADOR
    expect((await fact.request('/lid-compras?periodo=2026-9')).status).toBe(400)
  })
})

describe('GET /lid-compras/descargar', () => {
  it('CBTE: 325 + CRLF en Windows-1252', async () => {
    state.profile = CONTADOR
    const r = await fact.request('/lid-compras/descargar?periodo=2026-09&archivo=cbte')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-disposition')).toContain('LIBRO_IVA_DIGITAL_COMPRAS_CBTE_202609.txt')
    expect((await r.arrayBuffer()).byteLength).toBe(327)
  })
  it('ALICUOTAS: 84 + CRLF', async () => {
    state.profile = CONTADOR
    expect((await (await fact.request('/lid-compras/descargar?periodo=2026-09&archivo=alicuotas')).arrayBuffer()).byteLength).toBe(86)
  })
})

describe('GET /posicion-iva', () => {
  it('débito de ventas − crédito de compras − percepciones − retenciones del mes', async () => {
    state.profile = CONTADOR
    const r = await fact.request('/posicion-iva?periodo=2026-09')
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b).toMatchObject({
      debito_fiscal: 21000, credito_fiscal: 24464.13, impuesto_determinado: -3464.13,
      saldo_tecnico_a_favor: 3464.13, percepciones_iva: 3494.88, retenciones_iva: 1000,
      a_pagar: 0, libre_disponibilidad: 4494.88,
    })
    expect(filtros).toEqual(expect.arrayContaining([
      ['ventas_cobro_retenciones', 'eq:tipo', 'iva'], ['ventas_cobro_retenciones', 'eq:cobro.estado', 'vigente'],
    ]))
  })
})
