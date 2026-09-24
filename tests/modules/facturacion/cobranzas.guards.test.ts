/**
 * Guardias de las rutas de Cobranzas de Ventas (patrón de pagos.guards.test.ts):
 * quién pasa y quién rebota, con la base mockeada, y qué le llega a la RPC.
 *
 *   - Mariana: tabs cobranzas/deudores/saldos_iniciales + registrar_cobros + anular_cobros.
 *   - Alina/Diego: cobranzas y deudores SOLO lectura (sin flags).
 *   - Ambiente 'prod' por defecto; `?ambiente=homo` para pruebas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  state: { profile: null as Fila | null },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

function chain(data: unknown) {
  const obj: any = {}
  const self = () => obj
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'order', 'range', 'limit', 'update', 'insert', 'delete']) obj[m] = self
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => fromMock(t),
    rpc: (n: string, a: unknown) => rpcMock(n, a),
    storage: { from: () => ({ remove: async () => ({}), move: async () => ({}) }) },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => fact.request(path, { method: 'POST', ...json(body) })
const get = (path: string) => fact.request(path)

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { facturacion: p } : {} })
const MARIANA = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['facturas', 'clientes', 'finnegans', 'cobranzas', 'deudores', 'saldos_iniciales'], registrar_cobros: true, anular_cobros: true })
const ALINA   = perfil({ lectura: true, tabs: ['facturas', 'clientes', 'cobranzas', 'deudores'] })
const SOLO_FACTURAS = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['facturas'], registrar_cobros: true })

const DETALLE = { cobro: { id: 7, numero_fmt: 'RC 0001-00000007', total: 100, aplicado: 0, busq: 'x' }, medios: [], retenciones: [], imputaciones: [] }
const COBRO = { cobro: { cliente_id: 2 }, medios: [{ forma: 'efectivo', importe: 100 }] }

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  state.profile = null
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile)
    if (t === 'ventas_clientes') return chain({ id: 2, razon_social: 'X', doc_nro: '1', activo: true, plazo_pago_dias: 30 })
    return chain([])
  })
  rpcMock.mockImplementation((name: string) => {
    if (['ventas_registrar_cobro', 'ventas_imputar', 'ventas_anular_cobro', '_ventas_cobro_json'].includes(name)) return chain(DETALLE)
    return chain([])
  })
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as Fila | undefined

describe('cobros', () => {
  it('Mariana registra: la RPC recibe ambiente prod por defecto y su user id', async () => {
    state.profile = MARIANA
    const r = await post('/cobros', COBRO)
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.cobro.id).toBe(7)
    expect(body.cobro.busq).toBeUndefined()
    expect(llamada('ventas_registrar_cobro')).toMatchObject({ p_cobro: { cliente_id: 2, ambiente: 'prod' }, p_user_id: 'u-1', p_imputaciones: [] })
  })

  it('?ambiente=homo llega a la RPC', async () => {
    state.profile = MARIANA
    expect((await fact.request('/cobros?ambiente=homo', { method: 'POST', ...json(COBRO) })).status).toBe(200)
    expect(llamada('ventas_registrar_cobro')).toMatchObject({ p_cobro: { ambiente: 'homo' } })
  })

  it('Alina (sin registrar_cobros) lee pero no registra, no imputa ni anula', async () => {
    state.profile = ALINA
    expect((await get('/cobros')).status).toBe(200)
    expect((await get('/cobros/7')).status).toBe(200)
    expect((await post('/cobros', COBRO)).status).toBe(403)
    expect((await post('/cobros/7/imputar', { items: [{ factura_id: 1, importe: 1 }] })).status).toBe(403)
    expect((await post('/cobros/7/anular', { motivo: 'x' })).status).toBe(403)
    expect((await post('/compensaciones', { nc: { factura_id: 5 }, items: [{ factura_id: 1, importe: 1 }] })).status).toBe(403)
    expect(rpcMock.mock.calls.filter((c) => c[0] !== '_ventas_cobro_json')).toHaveLength(0)
  })

  it('con el flag pero sin la tab cobranzas no registra', async () => {
    state.profile = SOLO_FACTURAS
    const r = await post('/cobros', COBRO)
    expect(r.status).toBe(403)
    expect((await r.json() as any).error).toBe('SIN_TAB')
  })

  it('imputar y anular pasan a la RPC con su origen', async () => {
    state.profile = MARIANA
    expect((await post('/cobros/7/imputar', { items: [{ externo_id: 3, importe: 10 }] })).status).toBe(200)
    expect(llamada('ventas_imputar')).toMatchObject({ p_origen: { cobro_id: 7 }, p_items: [{ externo_id: 3, importe: 10 }] })
    expect((await post('/cobros/7/anular', { motivo: 'cargado dos veces' })).status).toBe(200)
    expect(llamada('ventas_anular_cobro')).toMatchObject({ p_id: 7, p_motivo: 'cargado dos veces' })
  })

  it('anular sin motivo → 400 DATOS_INVALIDOS', async () => {
    state.profile = MARIANA
    const r = await post('/cobros/7/anular', {})
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('DATOS_INVALIDOS')
  })

  it('compensación con NC externa', async () => {
    state.profile = MARIANA
    expect((await post('/compensaciones', { nc: { externo_id: 9 }, items: [{ factura_id: 1, importe: 5 }] })).status).toBe(200)
    expect(llamada('ventas_imputar')).toMatchObject({ p_origen: { nc_externo_id: 9 } })
  })

  it('error de la RPC → status del código', async () => {
    state.profile = MARIANA
    rpcMock.mockResolvedValue({ data: null, error: { message: 'IMPUTACION_SUPERA_SALDO', code: 'P0001', details: '{"saldo": 5}' } })
    const r = await post('/cobros/7/imputar', { items: [{ factura_id: 1, importe: 10 }] })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'IMPUTACION_SUPERA_SALDO', detail: { saldo: 5 } })
  })
})

describe('deudores, pendientes y saldos iniciales', () => {
  it('Alina ve deudores y estado de cuenta, no saldos iniciales', async () => {
    state.profile = ALINA
    expect((await get('/deudores')).status).toBe(200)
    expect(llamada('ventas_deudores_al')).toMatchObject({ p_ambiente: 'prod', p_al: null })
    expect((await get('/clientes/2/estado-cuenta?desde=2026-09-01')).status).toBe(200)
    expect((await get('/clientes/2/pendientes')).status).toBe(200)
    expect(llamada('ventas_saldos_al')).toMatchObject({ p_cliente_id: 2, p_ambiente: 'prod' })
    expect((await get('/externos')).status).toBe(403)
    expect((await post('/externos/importar', { filas: [{ cbte_tipo: 1 }] })).status).toBe(403)
  })

  it('importar: vista previa por defecto (p_confirmar=false) con las filas normalizadas', async () => {
    state.profile = MARIANA
    const r = await post('/externos/importar', { filas: [{ Fecha: '01/07/2026', Tipo: '1 - Factura A', 'Punto de Venta': 2, 'Número Desde': 1158, Total: 10, Moneda: '$' }] })
    expect(r.status).toBe(200)
    expect(llamada('ventas_importar_externos')).toMatchObject({
      p_confirmar: false, p_origen: 'portal',
      p_filas: [{ fecha: '2026-07-01', cbte_tipo: '1 - Factura A', pto_vta: '2', numero: '1158', total: 10, moneda: 'PES' }],
    })
  })

  it('marcar cobradas pide actualizacion + tab saldos_iniciales', async () => {
    state.profile = MARIANA
    expect((await post('/externos/marcar', { ids: [1, 2], accion: 'cobrada', fecha: '2026-09-01' })).status).toBe(200)
    expect(llamada('ventas_externos_marcar')).toMatchObject({ p_ids: [1, 2], p_accion: 'cobrada', p_fecha: '2026-09-01' })
    state.profile = ALINA
    expect((await post('/externos/marcar', { ids: [1], accion: 'cobrada' })).status).toBe(403)
  })

  it('vencimiento: actualizacion; null vuelve al automático', async () => {
    state.profile = MARIANA
    const r = await fact.request('/facturas/4/vencimiento', { method: 'PATCH', ...json({ vence_el: null }) })
    expect(r.status).toBe(200)
    expect(llamada('ventas_cambiar_vencimiento')).toMatchObject({ p_factura_id: 4, p_vence_el: null, p_user_id: 'u-1' })
    state.profile = ALINA
    expect((await fact.request('/facturas/4/vencimiento', { method: 'PATCH', ...json({ vence_el: '2026-12-01' }) })).status).toBe(403)
  })

  it('certificado: upload-url exige registrar_cobros y devuelve un path en retenciones/pendientes/', async () => {
    state.profile = ALINA
    expect((await post('/cobros/retenciones/upload-url', { nombre_archivo: 'a.pdf', mime_type: 'application/pdf', size_bytes: 10 })).status).toBe(403)
  })
})
