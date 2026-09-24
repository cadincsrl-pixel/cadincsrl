/**
 * Rutas del Libro IVA Digital de Ventas: guardia (lectura + tab finnegans),
 * lectura de ERP (prod autorizadas) + externos, y el .txt ANSI con CRLF.
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
const CONTADOR = perfil({ lectura: true, tabs: ['finnegans'] })
const SIN_TAB = perfil({ lectura: true, tabs: ['facturas', 'cobranzas'] })

const ERP = [{
  id: 17, cbte_tipo: 1, pto_vta: 4, numero: 1, fecha_cbte: '2026-09-23', fch_vto_pago: null,
  rec_doc_tipo: 80, rec_doc_nro: '33702413309', rec_razon_social: 'PEÑA S.A.', moneda: 'PES', cotizacion: '1',
  imp_neto: '1000.00', imp_iva: '210.00', imp_trib: '0', imp_op_ex: '0', imp_tot_conc: '0', imp_total: '1210.00',
  alicuotas: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }],
}]
const EXT = [
  { id: 1, cbte_tipo: 1, pto_vta: 4, numero: 1, fecha: '2026-09-23', rec_doc_tipo: 80, rec_doc_nro: '33702413309', rec_razon_social: 'X',
    neto: '1000', no_gravado: '0', exento: '0', iva: '210', total: '1210', moneda: 'PES', tipo_cambio: '1' },
  { id: 2, cbte_tipo: 60, pto_vta: 10, numero: 156, fecha: '2026-09-11', rec_doc_tipo: 80, rec_doc_nro: '30715675265', rec_razon_social: 'CASILDA',
    neto: '1000', no_gravado: '0', exento: '0', iva: '210', total: '1210', moneda: 'PES', tipo_cambio: '1' },
]

beforeEach(() => {
  fromMock.mockReset()
  filtros.length = 0
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(t, state.profile)
    if (t === 'ventas_facturas') return chain(t, ERP)
    if (t === 'ventas_comprobantes_externos') return chain(t, EXT)
    return chain(t, [])
  })
})

describe('GET /lid-ventas', () => {
  it('el contador (tab finnegans) lo genera: ERP prod autorizadas + externos del mes, dedup y CVLP apagada', async () => {
    state.profile = CONTADOR
    const r = await fact.request('/lid-ventas?periodo=2026-09')
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b.periodo).toBe('2026-09')
    expect(b.resumen.comprobantes).toBe(1)
    expect(b.resumen.excluidos).toBe(1)
    expect(b.archivos.cbte.split('\r\n')[0]).toHaveLength(266)
    expect(filtros).toEqual(expect.arrayContaining([
      ['ventas_facturas', 'eq:ambiente', 'prod'], ['ventas_facturas', 'eq:estado', 'autorizada'],
      ['ventas_facturas', 'gte:fecha_cbte', '2026-09-01'], ['ventas_facturas', 'lte:fecha_cbte', '2026-09-30'],
      ['ventas_comprobantes_externos', 'gte:fecha', '2026-09-01'], ['ventas_comprobantes_externos', 'lte:fecha', '2026-09-30'],
    ]))
  })

  it('incluir_cvlp=1 la suma', async () => {
    state.profile = CONTADOR
    const b = await (await fact.request('/lid-ventas?periodo=2026-09&incluir_cvlp=1')).json() as any
    expect(b.resumen.comprobantes).toBe(2)
  })

  it('sin la tab finnegans: 403; período mal formado: 400', async () => {
    state.profile = SIN_TAB
    expect((await fact.request('/lid-ventas?periodo=2026-09')).status).toBe(403)
    state.profile = CONTADOR
    expect((await fact.request('/lid-ventas?periodo=2026-13')).status).toBe(400)
    expect((await fact.request('/lid-ventas')).status).toBe(400)
  })
})

describe('GET /lid-ventas/descargar', () => {
  it('devuelve el .txt en Windows-1252 con CRLF', async () => {
    state.profile = CONTADOR
    const r = await fact.request('/lid-ventas/descargar?periodo=2026-09&archivo=cbte')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/plain; charset=windows-1252')
    expect(r.headers.get('content-disposition')).toContain('LIBRO_IVA_DIGITAL_VENTAS_CBTE_202609.txt')
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect(bytes.length).toBe(268)
    expect([bytes[266], bytes[267]]).toEqual([0x0d, 0x0a])
    expect(bytes[78]).toBe(0x50) // «P»
    expect(bytes[80]).toBe(0xd1) // «Ñ» en un byte
  })

  it('alícuotas: 62 + CRLF', async () => {
    state.profile = CONTADOR
    const r = await fact.request('/lid-ventas/descargar?periodo=2026-09&archivo=alicuotas')
    expect((await r.arrayBuffer()).byteLength).toBe(64)
  })

  it('archivo inválido: 400', async () => {
    state.profile = CONTADOR
    expect((await fact.request('/lid-ventas/descargar?periodo=2026-09&archivo=otro')).status).toBe(400)
  })
})
