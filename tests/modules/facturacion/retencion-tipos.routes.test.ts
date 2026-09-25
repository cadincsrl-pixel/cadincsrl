/**
 * Tipos de retención sufrida y configuración de Ventas (tanda 6, 20260929g):
 * guardias (GET con lectura; escribir con tab configuracion + configurar), lo
 * que llega a las RPC, los errores de la base y que el cobro acepte un tipo
 * nuevo del catálogo con su jurisdicción.
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
  obj.single = () => Promise.resolve({ data, error: null })
  obj.maybeSingle = () => Promise.resolve({ data, error: null })
  obj.then = (ok: any, ko: any) => Promise.resolve({ data, error: null }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => chain(t === 'profiles' ? state.profile : null),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      if (state.error) return { data: null, error: state.error }
      if (fn === 'ventas_retencion_tipos_json') return { data: [{ clave: 'iibb', corto: 'IIBB', activo: true }], error: null }
      if (fn === 'ventas_guardar_retencion_tipo') return { data: { clave: args?.p_clave ?? 'sellos', ...(args?.p as Fila) }, error: null }
      if (fn === 'ventas_config_json') return { data: { retencion_tipo_default: 'tem' }, error: null }
      if (fn === 'ventas_guardar_config') return { data: args?.p_cambios, error: null }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'
import { RetencionCobroSchema } from '../../../src/modules/facturacion/facturacion.schema.js'
import { ventasConfigDesdeJson } from '../../../src/modules/facturacion/retencion-tipos.service.js'

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { facturacion: p } : {} })
const LECTOR = perfil({ lectura: true, tabs: ['cobranzas'] })
const CON_TAB_SIN_FLAG = perfil({ lectura: true, tabs: ['configuracion'] })
const CONFIGURADOR = perfil({ lectura: true, tabs: ['configuracion'], configurar: true })

const enviar = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  fact.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
})

describe('GET /retencion-tipos y /config', () => {
  it('con lectura alcanza (sin tab)', async () => {
    state.profile = LECTOR
    expect((await fact.request('/retencion-tipos?incluir_inactivos=1')).status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_retencion_tipos_json', args: { p_incluir_inactivos: true } })
    const r = await fact.request('/config')
    expect(await r.json()).toEqual({ retencion_tipo_default: 'tem' })
  })
  it('sin lectura → 403', async () => {
    state.profile = perfil(null)
    expect((await fact.request('/retencion-tipos')).status).toBe(403)
  })
})

describe('POST / PATCH /retencion-tipos', () => {
  const alta = { nombre: 'Impuesto de Sellos', corto: 'Sellos', impuesto: 'otro', pide_jurisdiccion: true, jurisdiccion_default_id: 24 }

  it('sin tab / sin flag → 403 y no llama a la RPC', async () => {
    state.profile = LECTOR
    expect((await enviar('POST', '/retencion-tipos', alta)).status).toBe(403)
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('POST', '/retencion-tipos', alta)).status).toBe(403)
    expect(state.rpcs.find((x) => x.fn === 'ventas_guardar_retencion_tipo')).toBeUndefined()
  })

  it('alta 201 con p_clave null; edición con la clave de la URL', async () => {
    state.profile = CONFIGURADOR
    expect((await enviar('POST', '/retencion-tipos', alta)).status).toBe(201)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_retencion_tipo', args: { p: alta, p_user_id: 'u-1', p_clave: null } })
    expect((await enviar('PATCH', '/retencion-tipos/iibb', { activo: false })).status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_retencion_tipo', args: { p: { activo: false }, p_user_id: 'u-1', p_clave: 'iibb' } })
  })

  it('validación → 400 RETENCION_TIPO_INVALIDA con el campo', async () => {
    state.profile = CONFIGURADOR
    let r = await enviar('POST', '/retencion-tipos', { ...alta, impuesto: 'sellos' })
    expect(await r.json()).toMatchObject({ error: 'RETENCION_TIPO_INVALIDA', campo: 'impuesto' })
    r = await enviar('POST', '/retencion-tipos', { ...alta, clave: 'Sellos Tuc' })
    expect(await r.json()).toMatchObject({ error: 'RETENCION_TIPO_INVALIDA', campo: 'clave' })
    r = await enviar('PATCH', '/retencion-tipos/iibb', { clave: 'otra' })
    expect(await r.json()).toMatchObject({ error: 'RETENCION_TIPO_INVALIDA', campo: 'clave' })
    r = await enviar('PATCH', '/retencion-tipos/IIBB', { activo: true })
    expect(r.status).toBe(400)
  })

  it('reglas de la base → 409', async () => {
    state.profile = CONFIGURADOR
    for (const code of ['IMPUESTO_IVA_RESERVADO', 'RETENCION_TIPO_SISTEMA', 'RETENCION_TIPO_DUPLICADO', 'RETENCION_TIPO_POR_DEFECTO']) {
      state.error = { message: code }
      const r = await enviar('PATCH', '/retencion-tipos/iibb', { impuesto: 'iva' })
      expect(r.status).toBe(409)
      expect(await r.json()).toMatchObject({ error: code })
    }
  })
})

describe('PATCH /config', () => {
  it('guardias, RPC y validación', async () => {
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('PATCH', '/config', { retencion_tipo_default: 'tem' })).status).toBe(403)
    state.profile = CONFIGURADOR
    const r = await enviar('PATCH', '/config', { retencion_tipo_default: 'tem' })
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_guardar_config', args: { p_cambios: { retencion_tipo_default: 'tem' }, p_user_id: 'u-1' } })
    const r2 = await enviar('PATCH', '/config', { leyenda_fce: 'x' })
    expect(await r2.json()).toMatchObject({ error: 'CONFIG_INVALIDA', campo: 'leyenda_fce' })
    state.error = { message: 'CONFIG_INVALIDA', details: '{"clave":"retencion_tipo_default"}' }
    expect((await enviar('PATCH', '/config', { retencion_tipo_default: 'nope' })).status).toBe(400)
  })

  it('ventasConfigDesdeJson: default iibb', () => {
    expect(ventasConfigDesdeJson(null)).toEqual({ retencion_tipo_default: 'iibb' })
    expect(ventasConfigDesdeJson({ retencion_tipo_default: 'tem' })).toEqual({ retencion_tipo_default: 'tem' })
  })
})

describe('RetencionCobroSchema', () => {
  it('acepta un tipo nuevo del catálogo y la jurisdicción por id', () => {
    const r = RetencionCobroSchema.parse({ tipo: 'sellos_tuc', importe: 10, jurisdiccion_id: '24' })
    expect(r).toMatchObject({ tipo: 'sellos_tuc', jurisdiccion_id: 24 })
    expect(RetencionCobroSchema.parse({ tipo: 'iibb', importe: 1, jurisdiccion: 'Tucumán' }).jurisdiccion).toBe('Tucumán')
  })
  it('rechaza claves con forma inválida', () => {
    expect(RetencionCobroSchema.safeParse({ tipo: 'IIBB', importe: 1 }).success).toBe(false)
    expect(RetencionCobroSchema.safeParse({ tipo: 'x', importe: 1 }).success).toBe(false)
    expect(RetencionCobroSchema.safeParse({ tipo: 'iibb', importe: 1, jurisdiccion_id: 0 }).success).toBe(false)
  })
})
