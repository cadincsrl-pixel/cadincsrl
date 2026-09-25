/**
 * Gastos descontados y «Cargar liquidación» (20260930k): guardias, lo que
 * llega a las RPC, la propuesta de POST /cobros/liquidacion/leer (con el
 * texto real de la LIQ 3179) y los errores de la base.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, storage, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  storage: { download: vi.fn(), move: vi.fn(), remove: vi.fn() },
  state: { profile: null as Fila | null, tablas: {} as Record<string, unknown[]> },
}))

vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))
vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))
// La IA no se llama en estos tests: si el texto no alcanza, que falle claro.
vi.mock('../../../src/modules/facturacion/liquidacion-ia.js', () => ({
  leerLiquidacionConIA: vi.fn(async () => ({ ok: false, motivo: 'SIN_API_KEY', modelo: null })),
}))

function chain(data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit', 'gte', 'lte', 'ilike']) obj[m] = () => obj
  const res = () => ({ data, error: null })
  obj.single = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.maybeSingle = obj.single
  obj.then = (ok: any, ko: any) => Promise.resolve(res()).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => fromMock(t),
    rpc: (n: string, a: unknown) => rpcMock(n, a),
    storage: { from: () => storage },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'liquidaciones-casilda')
const TEXTO_3179 = readFileSync(path.join(DIR, 'liq-3179.txt'), 'utf8')

const enviar = (method: 'POST' | 'PATCH', p: string, body: unknown) =>
  fact.request(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const perfil = (p: Fila): Fila => ({ rol: 'operador', activo: true, rol_base: null, permisos: { facturacion: p } })
const COBRADOR = perfil({ lectura: true, tabs: ['cobranzas'], registrar_cobros: true })
const LECTOR = perfil({ lectura: true, tabs: ['cobranzas'] })
const SIN_TAB = perfil({ lectura: true, tabs: ['facturas'], registrar_cobros: true })
const CONFIGURADOR = perfil({ lectura: true, tabs: ['configuracion'], configurar: true })

const CONCEPTOS = [
  { id: 1, nombre: 'Recupero Ley 25413 (impuesto al cheque)', alias: ['recupero ley 25413', 'ley 25413'], activo: true, orden: 10, gastos: 0, mapeado: false },
  { id: 2, nombre: 'Seguro de carga', alias: ['pago seguro de carga'], activo: true, orden: 20, gastos: 0, mapeado: false },
]
const DETALLE = { cobro: { id: 77, numero_fmt: 'RC 0001-00000077', total: 1496791.3, aplicado: 1496791.3 }, medios: [], retenciones: [], gastos: [], imputaciones: [] }

const LEER = { storage_path: 'cobros/pendientes/abc.pdf', nombre_archivo: 'LIQ_3179.pdf', mime: 'application/pdf', texto: TEXTO_3179 }

beforeEach(() => {
  fromMock.mockReset(); rpcMock.mockReset()
  for (const f of Object.values(storage)) f.mockReset()
  storage.download.mockResolvedValue({ data: new Blob([Buffer.from('%PDF-1.4 liq')]), error: null })
  storage.move.mockResolvedValue({ error: null })
  state.tablas = {
    ventas_clientes: [{ id: 48, razon_social: 'CASILDA COMBUSTIBLES S.R.L.', doc_nro: '30715675265' }],
    ventas_cobros: [],
    v_ventas_externos: [{ id: 187, cbte_tipo: 60, tipo: 'FA', pto_vta: 10, numero: 255, fecha: '2026-09-11', total: '1496791.30', saldo: '1496791.30', comprobante: 'CVLP A 00010-00000255' }],
    v_ventas_facturas: [],
    ventas_cobro_medios: [],
    cheques_recibidos: [{ numero_norm: '14575857', importe: '240000.00' }],
  }
  fromMock.mockImplementation((t: string) => (t === 'profiles' ? chain(state.profile) : chain(state.tablas[t] ?? [])))
  rpcMock.mockImplementation(async (n: string) => {
    if (n === 'ventas_cobro_gasto_conceptos_json') return { data: CONCEPTOS, error: null }
    if (n === 'ventas_guardar_cobro_gasto_concepto') return { data: CONCEPTOS[0], error: null }
    if (n === 'ventas_registrar_cobro' || n === '_ventas_cobro_json') return { data: DETALLE, error: null }
    return { data: null, error: null }
  })
})

describe('POST /cobros/liquidacion/leer', () => {
  it('guardias: registrar_cobros + tab cobranzas', async () => {
    state.profile = LECTOR
    expect((await enviar('POST', '/cobros/liquidacion/leer', LEER)).status).toBe(403)
    state.profile = SIN_TAB
    expect((await enviar('POST', '/cobros/liquidacion/leer', LEER)).status).toBe(403)
    expect(storage.download).not.toHaveBeenCalled()
  })

  it('propuesta de la LIQ 3179: cliente por CUIT, CVLP, gastos con concepto, cheques y controles; no crea nada', async () => {
    state.profile = COBRADOR
    const r = await enviar('POST', '/cobros/liquidacion/leer', LEER)
    expect(r.status).toBe(200)
    const p = await r.json() as any
    expect(p.fuente).toBe('texto')
    expect(p.cliente).toMatchObject({ id: 48 })
    expect(p.ya_cargada).toBeNull()
    expect(p.liquidacion).toMatchObject({ numero: '3179', fecha: '2026-09-25', neto: 1484291.3 })
    expect(p.comprobantes).toEqual([expect.objectContaining({ numero_fmt: '00010-00000255', imputar: 1496791.3, avisos: [], destino: expect.objectContaining({ tipo: 'externo', id: 187 }) })])
    expect(p.gastos.map((g: any) => [g.concepto_id, g.importe])).toEqual([[1, 8500], [2, 4000]])
    expect(p.cheques).toHaveLength(6)
    expect(p.cheques[0]).toMatchObject({ numero: '14575857', librador: 'CASILDA COMBUSTIBLES S.R.L.', librador_cuit: '30715675265', avisos: ['EN_CARTERA'] })
    expect(p.cheques[1].avisos).toEqual([])
    expect(p.controles.ok).toBe(true)
    expect(p.total_cobro).toBe(1496791.3)
    expect(p.total_imputar).toBe(1496791.3)
    expect(p.obs_sugerida).toBe('Liquidación Casilda N° 3179')
    expect(p.adjunto).toMatchObject({ storage_path: 'cobros/pendientes/abc.pdf', hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(rpcMock.mock.calls.map((c) => c[0])).not.toContain('ventas_registrar_cobro')
  })

  it('marca la liquidación ya cargada, la CVLP ya cobrada y el cheque que está en otro cobro', async () => {
    state.profile = COBRADOR
    state.tablas.ventas_cobros = [{ id: 90, numero: 12, estado: 'vigente' }]
    state.tablas.v_ventas_cobros = [{ numero_fmt: 'RC 0001-00000012' }]
    state.tablas.v_ventas_externos = [{ ...(state.tablas.v_ventas_externos![0] as Fila), saldo: '0.00' }]
    state.tablas.ventas_cobro_medios = [{ cobro_id: 90, cheque_numero: '14575858', cheque_banco: 'ICBC' }]
    const p = await (await enviar('POST', '/cobros/liquidacion/leer', LEER)).json() as any
    expect(p.ya_cargada).toEqual({ cobro_id: 90, numero_fmt: 'RC 0001-00000012' })
    expect(p.comprobantes[0]).toMatchObject({ imputar: 0, avisos: ['YA_COBRADO'] })
    expect(p.cheques[1]).toMatchObject({ avisos: ['YA_EN_OTRO_COBRO'], cobro_existente_id: 90 })
  })

  it('CUIT que no es cliente → 422 LIQUIDACION_SIN_CLIENTE; texto ilegible sin IA → 422 LIQUIDACION_ILEGIBLE', async () => {
    state.profile = COBRADOR
    state.tablas.ventas_clientes = []
    let r = await enviar('POST', '/cobros/liquidacion/leer', LEER)
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'LIQUIDACION_SIN_CLIENTE', detail: { cuit: '30715675265' } })
    r = await enviar('POST', '/cobros/liquidacion/leer', { ...LEER, texto: 'escaneo sin texto' })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'LIQUIDACION_ILEGIBLE', detail: { motivo: 'SIN_API_KEY' } })
  })

  it('path fuera de cobros/pendientes → 400 PATH_INVALIDO', async () => {
    state.profile = COBRADOR
    const r = await enviar('POST', '/cobros/liquidacion/leer', { ...LEER, storage_path: 'cobros/77/x.pdf' })
    expect(await r.json()).toMatchObject({ error: 'PATH_INVALIDO' })
  })
})

describe('POST /cobros con gastos y número de liquidación', () => {
  const body = {
    cobro: { cliente_id: 48, fecha: '2026-09-25', obs: 'Liquidación Casilda N° 3179', liquidacion_numero: '3179' },
    medios: [{ forma: 'cheque', importe: 1484291.3, cheque_numero: '14575857', cheque_banco: 'ICBC', cheque_librador: 'CASILDA COMBUSTIBLES S.R.L.', cheque_librador_cuit: '30-71567526-5', cheque_fecha_cobro: '2026-11-01' }],
    gastos: [{ concepto_id: 1, importe: 8500, obs: 'Recupero Ley 25413' }, { concepto_id: 2, importe: 4000 }],
    imputaciones: [{ externo_id: 187, importe: 1496791.3 }],
  }

  it('los gastos y el número viajan dentro de p_cobro; el CUIT del librador sin guiones', async () => {
    state.profile = COBRADOR
    expect((await enviar('POST', '/cobros', body)).status).toBe(200)
    const [, args] = rpcMock.mock.calls.find((c) => c[0] === 'ventas_registrar_cobro')!
    expect(args.p_cobro).toMatchObject({
      liquidacion_numero: '3179',
      gastos: [{ concepto_id: 1, importe: 8500, obs: 'Recupero Ley 25413' }, { concepto_id: 2, importe: 4000, obs: '' }],
    })
    expect(args.p_medios[0].cheque_librador_cuit).toBe('30715675265')
    expect(Object.keys(args)).toEqual(['p_cobro', 'p_medios', 'p_retenciones', 'p_imputaciones', 'p_user_id'])
  })

  it('validación de forma: gasto sin concepto, número de liquidación raro, CUIT corto', async () => {
    state.profile = COBRADOR
    let r = await enviar('POST', '/cobros', { ...body, gastos: [{ importe: 5 }] })
    expect(await r.json()).toMatchObject({ error: 'DATOS_INVALIDOS', campo: 'gastos.0.concepto_id' })
    r = await enviar('POST', '/cobros', { ...body, cobro: { ...body.cobro, liquidacion_numero: '#3179' } })
    expect(await r.json()).toMatchObject({ error: 'DATOS_INVALIDOS', campo: 'cobro.liquidacion_numero' })
    r = await enviar('POST', '/cobros', { ...body, medios: [{ ...body.medios[0], cheque_librador_cuit: '123' }] })
    expect(await r.json()).toMatchObject({ error: 'DATOS_INVALIDOS', campo: 'medios.0.cheque_librador_cuit' })
  })

  it('errores de la base: LIQUIDACION_DUPLICADA 409, GASTO_INVALIDO 400, índice único 409', async () => {
    state.profile = COBRADOR
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'LIQUIDACION_DUPLICADA', details: '{"liquidacion_numero":"3179","cobro_id":90}' } }))
    let r = await enviar('POST', '/cobros', body)
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'LIQUIDACION_DUPLICADA', detail: { cobro_id: 90 } })
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'GASTO_INVALIDO', details: '{"indice":1,"campo":"concepto_id"}' } }))
    r = await enviar('POST', '/cobros', body)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'GASTO_INVALIDO', campo: 'concepto_id' })
    rpcMock.mockImplementation(async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "ventas_cobros_liquidacion_uidx"' } }))
    r = await enviar('POST', '/cobros', body)
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'LIQUIDACION_DUPLICADA' })
  })
})

describe('/cobro-gasto-conceptos', () => {
  it('GET con lectura; escribir pide tab configuracion + configurar', async () => {
    state.profile = LECTOR
    expect((await fact.request('/cobro-gasto-conceptos?incluir_inactivos=1')).status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('ventas_cobro_gasto_conceptos_json', { p_incluir_inactivos: true })
    expect((await enviar('POST', '/cobro-gasto-conceptos', { nombre: 'Comisión bancaria' })).status).toBe(403)
    state.profile = CONFIGURADOR
    expect((await enviar('POST', '/cobro-gasto-conceptos', { nombre: 'Comisión bancaria', alias: ['comision banco'] })).status).toBe(201)
    expect(rpcMock).toHaveBeenCalledWith('ventas_guardar_cobro_gasto_concepto', { p: { nombre: 'Comisión bancaria', alias: ['comision banco'] }, p_user_id: 'u-1', p_id: null })
    expect((await enviar('PATCH', '/cobro-gasto-conceptos/2', { activo: false })).status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('ventas_guardar_cobro_gasto_concepto', { p: { activo: false }, p_user_id: 'u-1', p_id: 2 })
  })

  it('validación → 400 GASTO_CONCEPTO_INVALIDO; duplicado de la base → 409', async () => {
    state.profile = CONFIGURADOR
    let r = await enviar('POST', '/cobro-gasto-conceptos', { nombre: 'X' })
    expect(await r.json()).toMatchObject({ error: 'GASTO_CONCEPTO_INVALIDO', campo: 'nombre' })
    r = await enviar('PATCH', '/cobro-gasto-conceptos/2', { color: 'rojo' })
    expect(await r.json()).toMatchObject({ error: 'GASTO_CONCEPTO_INVALIDO', campo: 'color' })
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'GASTO_CONCEPTO_DUPLICADO', details: '{"campo":"alias","existente":2}' } }))
    r = await enviar('POST', '/cobro-gasto-conceptos', { nombre: 'Otro', alias: ['seguro de carga'] })
    expect(r.status).toBe(409)
  })
})

describe('auditoría', () => {
  it.each([
    ['POST', '/api/facturacion/cobros/liquidacion/leer', { modulo: 'facturacion', entidad: 'liquidación del cliente', accion: 'leer comprobante' }],
    ['POST', '/api/facturacion/cobro-gasto-conceptos', { modulo: 'facturacion', entidad: 'concepto de gasto de cobro', accion: 'crear' }],
    ['PATCH', '/api/facturacion/cobro-gasto-conceptos/4', { modulo: 'facturacion', entidad: 'concepto de gasto de cobro', accion: 'actualizar', entidadId: '4' }],
  ])('%s %s', (m, p, esperado) => {
    expect(parseRoute(p, m)).toEqual(esperado)
  })
})
