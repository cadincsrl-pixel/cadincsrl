/**
 * Productos de venta (tanda 6, 20260929b): guardias (leer con `lectura`,
 * escribir con tab configuracion + flag configurar), forma de la llamada a la
 * RPC, errores de validación y de la base.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    rpcs: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
    error: null as { message: string; details?: string } | null,
  },
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
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit']) obj[m] = () => obj
  const uno = () => Promise.resolve({ data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej)
  return obj
}

const PRODUCTOS = [
  { id: 1, nombre: 'AVANCE DE OBRA', descripcion: '', concepto_arca: 3, pide_obra: true, pide_periodo: false, activo: true, orden: 10, facturas: 14, mapeado: true },
  { id: 2, nombre: 'TRANSPORTE', descripcion: '', concepto_arca: 2, pide_obra: false, pide_periodo: false, activo: true, orden: 20, facturas: 4, mapeado: true },
]

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => chain(t === 'profiles' ? state.profile : []),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      if (state.error) return { data: null, error: state.error }
      if (fn === 'ventas_productos_json') return { data: PRODUCTOS, error: null }
      if (fn === 'ventas_guardar_producto') {
        const p = args?.p as Fila
        return { data: { id: p.id ?? 3, activo: true, facturas: 0, mapeado: false, ...p }, error: null }
      }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { facturacion: p } : {} })
const LECTOR = perfil({ lectura: true, tabs: ['facturas'] })
const CON_TAB_SIN_FLAG = perfil({ lectura: true, tabs: ['configuracion'] })
const CONFIGURADOR = perfil({ lectura: true, tabs: ['configuracion'], configurar: true })
const ADMIN = perfil(null, 'admin')

const enviar = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  fact.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
})

describe('GET /productos', () => {
  it('con lectura alcanza (sin tab configuracion): lo lee el formulario de la factura', async () => {
    state.profile = LECTOR
    const r = await fact.request('/productos')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(PRODUCTOS)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_productos_json', args: { p_incluir_inactivos: false } })
  })

  it('?incluir_inactivos=1 los pide todos', async () => {
    state.profile = LECTOR
    await fact.request('/productos?incluir_inactivos=1')
    expect(state.rpcs).toContainEqual({ fn: 'ventas_productos_json', args: { p_incluir_inactivos: true } })
  })

  it('sin lectura → 403', async () => {
    state.profile = perfil({ lectura: false })
    expect((await fact.request('/productos')).status).toBe(403)
  })
})

describe('POST /productos', () => {
  const alta = { nombre: 'Alquiler de equipos', concepto_arca: 2, pide_obra: false, pide_periodo: true }

  it('sin tab configuracion → 403; con tab y sin flag → 403', async () => {
    state.profile = LECTOR
    expect((await enviar('POST', '/productos', alta)).status).toBe(403)
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('POST', '/productos', alta)).status).toBe(403)
    expect(state.rpcs.find((x) => x.fn === 'ventas_guardar_producto')).toBeUndefined()
  })

  it('con tab + configurar → 201 y la RPC recibe el body y el usuario', async () => {
    state.profile = CONFIGURADOR
    const r = await enviar('POST', '/productos', alta)
    expect(r.status).toBe(201)
    expect((await r.json() as any).id).toBe(3)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_producto', args: { p: alta, p_user_id: 'u-1' } })
  })

  it('el admin pasa sin tab ni flag', async () => {
    state.profile = ADMIN
    expect((await enviar('POST', '/productos', alta)).status).toBe(201)
  })

  it('validación → 400 PRODUCTO_INVALIDO con el campo', async () => {
    state.profile = CONFIGURADOR
    let r = await enviar('POST', '/productos', { ...alta, concepto_arca: 4 })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'PRODUCTO_INVALIDO', campo: 'concepto_arca' })
    r = await enviar('POST', '/productos', { ...alta, activo: false, raro: 1 })
    expect(await r.json()).toMatchObject({ error: 'PRODUCTO_INVALIDO', campo: 'activo' })
  })

  it('duplicado de la base → 409 PRODUCTO_DUPLICADO con existente_id', async () => {
    state.profile = CONFIGURADOR
    state.error = { message: 'PRODUCTO_DUPLICADO', details: '{"existente_id":2}' }
    const r = await enviar('POST', '/productos', { ...alta, nombre: 'transporte' })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'PRODUCTO_DUPLICADO', detail: { existente_id: 2 } })
  })
})

describe('PATCH /productos/:id', () => {
  it('desactivar manda el id y el cambio', async () => {
    state.profile = CONFIGURADOR
    const r = await enviar('PATCH', '/productos/2', { activo: false })
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_producto', args: { p: { activo: false, id: 2 }, p_user_id: 'u-1' } })
  })

  it('body vacío → 400; último activo → 409; sin flag → 403', async () => {
    state.profile = CONFIGURADOR
    expect((await enviar('PATCH', '/productos/2', {})).status).toBe(400)
    state.error = { message: 'ULTIMO_PRODUCTO_ACTIVO' }
    const r = await enviar('PATCH', '/productos/1', { activo: false })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'ULTIMO_PRODUCTO_ACTIVO' })
    state.error = null
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('PATCH', '/productos/1', { nombre: 'Obra' })).status).toBe(403)
  })
})
