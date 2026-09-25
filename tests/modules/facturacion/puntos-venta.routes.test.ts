/**
 * Puntos de venta (tanda 6, 20260929d): guardias, verificación contra ARCA
 * al dar de alta (422 si ARCA dice que no sirve, 409 PV_NO_VERIFICADO si no
 * se pudo preguntar, salvo `forzar`), resolución del talonario del borrador y
 * `/arca/ambiente` con los PV y el certificado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    pvs: [] as Fila[],
    rpcs: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
    error: null as { message: string; details?: string } | null,
    arca: { configurado: true, lista: [] as unknown[], falla: null as Error | null },
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

vi.mock('../../../src/lib/arca/index.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/arca/index.js')>()
  return {
    ...real,
    arcaEstaConfigurado: () => state.arca.configurado,
    arcaConfig: () => ({ ambiente: 'prod', cuit: '33717191949', ptoVta: 4, urls: real.ARCA_URLS.prod }),
    paramPuntosVenta: async () => {
      if (state.arca.falla) throw state.arca.falla
      return state.arca.lista
    },
  }
})

function chain(data: unknown) {
  const obj: any = {}
  let filtros: Array<[string, unknown]> = []
  for (const m of ['select', 'neq', 'in', 'is', 'order', 'range', 'limit']) obj[m] = () => obj
  obj.eq = (k: string, v: unknown) => { filtros.push([k, v]); return obj }
  const res = () => {
    const d = Array.isArray(data) ? data.filter((f: any) => filtros.every(([k, v]) => f[k] === v)) : data
    filtros = []
    return d
  }
  obj.single = () => Promise.resolve({ data: (res() as any[])?.[0] ?? res(), error: null })
  obj.maybeSingle = () => { const d = res(); return Promise.resolve({ data: Array.isArray(d) ? d[0] ?? null : d, error: null }) }
  obj.then = (ok: any, ko: any) => Promise.resolve({ data: res(), error: null }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => chain(t === 'profiles' ? state.profile : t === 'ventas_puntos_venta' ? state.pvs : []),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      if (state.error) return { data: null, error: state.error }
      if (fn === 'ventas_puntos_venta_json') return { data: state.pvs, error: null }
      if (fn === 'ventas_guardar_punto_venta') {
        const p = args?.p as Fila
        return { data: { id: p.id ?? 9, activo: true, por_defecto: false, facturas: 0, ...p }, error: null }
      }
      if (fn === '_ventas_punto_venta_json') return { data: state.pvs.find((x) => x.id === args?.p_id) ?? null, error: null }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'
import { talonario } from '../../../src/modules/facturacion/comun.js'
import { evaluarPvArca, esCaeWebservice, puntosVentaService } from '../../../src/modules/facturacion/puntos-venta.service.js'
import { supabase } from '../../../src/lib/supabase.js'

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { facturacion: p } : {} })
const LECTOR = perfil({ lectura: true, tabs: ['facturas'] })
const CON_TAB_SIN_FLAG = perfil({ lectura: true, tabs: ['configuracion'] })
const CONFIGURADOR = perfil({ lectura: true, tabs: ['configuracion'], configurar: true })

const PV4 = { id: 2, ambiente: 'prod', numero: 4, nombre: 'ERP', activo: true, por_defecto: true, producto_ids: [], facturas: 5 }
const PV5 = { id: 3, ambiente: 'prod', numero: 5, nombre: 'Logística', activo: true, por_defecto: false, producto_ids: [2], facturas: 0 }
const PV6_INACTIVO = { id: 4, ambiente: 'prod', numero: 6, nombre: 'Vieja', activo: false, por_defecto: false, producto_ids: [], facturas: 1 }

const OK_ARCA = { nro: 5, emisionTipo: 'CAE - Ws', bloqueado: false, fchBaja: null }

const enviar = (method: 'POST' | 'PATCH', path: string, body?: unknown) =>
  fact.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
  state.pvs = [PV4, PV5, PV6_INACTIVO]
  state.arca = { configurado: true, lista: [OK_ARCA], falla: null }
  process.env.ARCA_AMBIENTE = 'prod'
  process.env.ARCA_PTO_VTA = '4'
  puntosVentaService.olvidarCache()
})

describe('evaluarPvArca (pura)', () => {
  it('ok / no existe / no es webservice / bloqueado / dado de baja / lista vacía', () => {
    expect(evaluarPvArca(5, [OK_ARCA]).estado).toBe('ok')
    expect(evaluarPvArca(8, [OK_ARCA])).toMatchObject({ estado: 'rechazado', codigo: 'PV_NO_EXISTE_EN_ARCA', disponibles: [5] })
    expect(evaluarPvArca(5, [{ ...OK_ARCA, emisionTipo: 'CAEA - Ws' }])).toMatchObject({ codigo: 'PV_NO_ES_WEBSERVICE' })
    expect(evaluarPvArca(5, [{ ...OK_ARCA, bloqueado: true }])).toMatchObject({ codigo: 'PV_BLOQUEADO' })
    expect(evaluarPvArca(5, [{ ...OK_ARCA, fchBaja: '2026-01-31' }])).toMatchObject({ codigo: 'PV_DADO_DE_BAJA' })
    expect(evaluarPvArca(5, []).estado).toBe('no_verificado')
  })

  it('esCaeWebservice', () => {
    expect(esCaeWebservice('CAE - Ws')).toBe(true)
    expect(esCaeWebservice('CAEA - Ws')).toBe(false)
    expect(esCaeWebservice('Factura en Linea - Monotributo')).toBe(false)
  })
})

describe('GET /puntos-venta', () => {
  it('con lectura alcanza; default = ambiente del proceso', async () => {
    state.profile = LECTOR
    const r = await fact.request('/puntos-venta')
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_puntos_venta_json', args: { p_ambiente: 'prod' } })
    await fact.request('/puntos-venta?ambiente=homo')
    expect(state.rpcs).toContainEqual({ fn: 'ventas_puntos_venta_json', args: { p_ambiente: 'homo' } })
  })
})

describe('POST /puntos-venta', () => {
  it('sin tab / sin flag → 403 y no consulta nada', async () => {
    state.profile = LECTOR
    expect((await enviar('POST', '/puntos-venta', { numero: 5 })).status).toBe(403)
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('POST', '/puntos-venta', { numero: 5 })).status).toBe(403)
    expect(state.rpcs.find((x) => x.fn === 'ventas_guardar_punto_venta')).toBeUndefined()
  })

  it('ARCA lo confirma → 201, ambiente del proceso y datos de ARCA a la RPC', async () => {
    state.profile = CONFIGURADOR
    const r = await enviar('POST', '/puntos-venta', { numero: 5, nombre: 'Logística', producto_ids: [2] })
    expect(r.status).toBe(201)
    expect(state.rpcs).toContainEqual({
      fn: 'ventas_guardar_punto_venta',
      args: {
        p: { numero: 5, nombre: 'Logística', producto_ids: [2], ambiente: 'prod', arca: { emision_tipo: 'CAE - Ws', bloqueado: false, fch_baja: null } },
        p_user_id: 'u-1',
      },
    })
  })

  it('no está en ARCA → 422 PV_NO_EXISTE_EN_ARCA con los disponibles (forzar no lo salva)', async () => {
    state.profile = CONFIGURADOR
    const r = await enviar('POST', '/puntos-venta', { numero: 8, forzar: true })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'PV_NO_EXISTE_EN_ARCA', detail: { disponibles: [5] } })
  })

  it('bloqueado → 422 PV_BLOQUEADO', async () => {
    state.profile = CONFIGURADOR
    state.arca.lista = [{ ...OK_ARCA, bloqueado: true }]
    const r = await enviar('POST', '/puntos-venta', { numero: 5 })
    expect(r.status).toBe(422)
    expect((await r.json() as any).error).toBe('PV_BLOQUEADO')
  })

  it('ARCA no responde o no lista nada → 409 PV_NO_VERIFICADO; con forzar se guarda sin datos de ARCA', async () => {
    state.profile = CONFIGURADOR
    state.arca.falla = new Error('timeout')
    let r = await enviar('POST', '/puntos-venta', { numero: 5 })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'PV_NO_VERIFICADO', detail: { motivo: expect.stringContaining('timeout') } })
    state.arca.falla = null
    state.arca.lista = []
    r = await enviar('POST', '/puntos-venta', { numero: 5 })
    expect((await r.json() as any).error).toBe('PV_NO_VERIFICADO')
    r = await enviar('POST', '/puntos-venta', { numero: 5, forzar: true })
    expect(r.status).toBe(201)
    const llamada = state.rpcs.find((x) => x.fn === 'ventas_guardar_punto_venta')!
    expect(llamada.args).toEqual({ p: { numero: 5, ambiente: 'prod' }, p_user_id: 'u-1' })
  })

  it('ARCA no configurado → PV_NO_VERIFICADO (local sin certificado)', async () => {
    state.profile = CONFIGURADOR
    state.arca.configurado = false
    const r = await enviar('POST', '/puntos-venta', { numero: 5 })
    expect(r.status).toBe(409)
  })

  it('validación → 400 PV_INVALIDO; duplicado de la base → 409', async () => {
    state.profile = CONFIGURADOR
    let r = await enviar('POST', '/puntos-venta', { numero: 0 })
    expect(await r.json()).toMatchObject({ error: 'PV_INVALIDO', campo: 'numero' })
    r = await enviar('POST', '/puntos-venta', { numero: 5, ambiente: 'homo' })
    expect(await r.json()).toMatchObject({ error: 'PV_INVALIDO', campo: 'ambiente' })
    state.error = { message: 'PV_DUPLICADO', details: '{"numero":5}' }
    r = await enviar('POST', '/puntos-venta', { numero: 5 })
    expect(r.status).toBe(409)
  })
})

describe('PATCH /puntos-venta/:id y verificar', () => {
  it('PATCH manda id + cambios; PV_POR_DEFECTO → 409', async () => {
    state.profile = CONFIGURADOR
    const r = await enviar('PATCH', '/puntos-venta/3', { por_defecto: true })
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_punto_venta', args: { p: { por_defecto: true, id: 3 }, p_user_id: 'u-1' } })
    state.error = { message: 'PV_POR_DEFECTO' }
    expect((await enviar('PATCH', '/puntos-venta/2', { activo: false })).status).toBe(409)
  })

  it('verificar guarda lo que dijo ARCA; si ARCA no contesta, devuelve el PV sin tocarlo', async () => {
    state.profile = CONFIGURADOR
    let r = await enviar('POST', '/puntos-venta/3/verificar')
    expect(r.status).toBe(200)
    expect((await r.json() as any).verificacion.estado).toBe('ok')
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_punto_venta', args: { p: { id: 3, arca: { emision_tipo: 'CAE - Ws', bloqueado: false, fch_baja: null } }, p_user_id: 'u-1' } })
    state.rpcs.length = 0
    state.arca.lista = []
    r = await enviar('POST', '/puntos-venta/3/verificar')
    const b = await r.json() as any
    expect(b.verificacion.estado).toBe('no_verificado')
    expect(b.punto_venta.numero).toBe(5)
    expect(state.rpcs.find((x) => x.fn === 'ventas_guardar_punto_venta')).toBeUndefined()
  })
})

describe('talonario del borrador', () => {
  const env = { ARCA_AMBIENTE: 'prod', ARCA_PTO_VTA: '4' }

  it('el pedido si está activo; si no → 409 PTO_VTA_NO_HABILITADO', async () => {
    expect(await talonario(supabase, 5, null, env)).toEqual({ ambiente: 'prod', ptoVta: 5 })
    await expect(talonario(supabase, 6, null, env)).rejects.toMatchObject({ code: 'PTO_VTA_NO_HABILITADO', status: 409 })
    await expect(talonario(supabase, 9, null, env)).rejects.toMatchObject({ code: 'PTO_VTA_NO_HABILITADO' })
  })

  it('sin pedido: el anterior si sigue activo; si no, el por defecto', async () => {
    expect((await talonario(supabase, null, 5, env)).ptoVta).toBe(5)
    expect((await talonario(supabase, null, 6, env)).ptoVta).toBe(4)
    expect((await talonario(supabase, undefined, null, env)).ptoVta).toBe(4)
  })

  it('tabla vacía para el ambiente → ARCA_PTO_VTA (como antes)', async () => {
    state.pvs = []
    expect(await talonario(supabase, null, null, { ARCA_AMBIENTE: 'prod', ARCA_PTO_VTA: '3' })).toEqual({ ambiente: 'prod', ptoVta: 3 })
    await expect(talonario(supabase, 5, null, { ARCA_AMBIENTE: 'prod', ARCA_PTO_VTA: '3' })).rejects.toMatchObject({ code: 'PTO_VTA_NO_HABILITADO' })
  })
})

describe('GET /arca/ambiente', () => {
  it('suma los PV activos, el por defecto como pto_vta y el certificado (sin PEM)', async () => {
    state.profile = LECTOR
    delete process.env.ARCA_CERT_B64
    delete process.env.ARCA_CERT_PATH
    const r = await fact.request('/arca/ambiente')
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b.pto_vta).toBe(4)
    expect(b.puntos_venta).toEqual([
      { numero: 4, nombre: 'ERP', por_defecto: true, producto_ids: [] },
      { numero: 5, nombre: 'Logística', por_defecto: false, producto_ids: [2] },
    ])
    expect(b.certificado).toBeNull()
    expect(b.certificado_error).toBe('no configurado')
  })
})
