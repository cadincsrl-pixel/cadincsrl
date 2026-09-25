/**
 * Configuración de Compras (20260929f, `pagos_config`): la jurisdicción por
 * defecto del tributo. GET con lectura (sin tab); PATCH con tab
 * configuracion + flag configurar; cache invalidada al guardar. Y el tributo
 * del desglose acepta `jurisdiccion_id`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    rpcs: [] as Array<{ fn: string; args?: unknown }>,
    config: { tributo_jurisdiccion_default_id: 24 } as Fila,
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
vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))

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
    rpc: async (fn: string, args?: unknown) => {
      state.rpcs.push({ fn, args })
      if (state.error) return { data: null, error: state.error }
      if (fn === 'pagos_config_json') return { data: state.config, error: null }
      if (fn === 'pagos_guardar_config') {
        state.config = { ...state.config, ...((args as { p_cambios: Fila }).p_cambios) }
        return { data: state.config, error: null }
      }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { pagosConfigService, configDesdeJson } from '../../../src/modules/pagos/config.service.js'
import { TributoSchema } from '../../../src/modules/pagos/pagos.schema.js'

const perfil = (p: Fila): Fila => ({ rol: 'operador', activo: true, rol_base: null, permisos: { pagos: p } })
const patch = (body: unknown) => pagos.request('/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
  state.config = { tributo_jurisdiccion_default_id: 24 }
  pagosConfigService.olvidarCache()
})

describe('GET /config', () => {
  it('lectura alcanza, cualquier tab', async () => {
    state.profile = perfil({ lectura: true, tabs: ['facturas'] })
    const r = await pagos.request('/config')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ tributos: { jurisdiccion_default_id: 24 } })
  })
  it('cachea; guardar la renueva', async () => {
    await pagosConfigService.obtener()
    await pagosConfigService.obtener()
    expect(state.rpcs.filter((x) => x.fn === 'pagos_config_json')).toHaveLength(1)
    await pagosConfigService.guardar({ tributo_jurisdiccion_default_id: 17 }, 'u-1')
    expect((await pagosConfigService.obtener()).tributos.jurisdiccion_default_id).toBe(17)
  })
  it('configDesdeJson: basura → null', () => {
    expect(configDesdeJson(null)).toEqual({ tributos: { jurisdiccion_default_id: null } })
    expect(configDesdeJson({ tributo_jurisdiccion_default_id: 'x' })).toEqual({ tributos: { jurisdiccion_default_id: null } })
  })
})

describe('PATCH /config', () => {
  it('sin tab o sin flag → 403', async () => {
    state.profile = perfil({ lectura: true, tabs: ['facturas'], configurar: true })
    expect((await patch({ tributo_jurisdiccion_default_id: 17 })).status).toBe(403)
    state.profile = perfil({ lectura: true, tabs: ['configuracion'] })
    expect((await patch({ tributo_jurisdiccion_default_id: 17 })).status).toBe(403)
    expect(state.rpcs.find((x) => x.fn === 'pagos_guardar_config')).toBeUndefined()
  })
  it('con tab + flag llega a la RPC; clave desconocida → 400 CONFIG_INVALIDA', async () => {
    state.profile = perfil({ lectura: true, tabs: ['configuracion'], configurar: true })
    const r = await patch({ tributo_jurisdiccion_default_id: 17 })
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'pagos_guardar_config', args: { p_cambios: { tributo_jurisdiccion_default_id: 17 }, p_user_id: 'u-1' } })
    const r2 = await patch({ plazos_cheque: [0, 30] })
    expect(await r2.json()).toMatchObject({ error: 'CONFIG_INVALIDA', campo: 'plazos_cheque' })
    state.error = { message: 'CONFIG_INVALIDA', details: '{"clave":"tributo_jurisdiccion_default_id","motivo":"jurisdiccion_inexistente_o_inactiva"}' }
    expect((await patch({ tributo_jurisdiccion_default_id: 999 })).status).toBe(400)
  })
})

describe('TributoSchema', () => {
  it('acepta jurisdiccion_id (y el texto viejo sigue valiendo)', () => {
    expect(TributoSchema.parse({ tipo: 'percepcion_iibb', jurisdiccion_id: 24, importe: 10 }).jurisdiccion_id).toBe(24)
    expect(TributoSchema.parse({ tipo: 'percepcion_iibb', jurisdiccion: 'Tucumán', importe: 10 }).jurisdiccion).toBe('Tucumán')
    expect(TributoSchema.safeParse({ tipo: 'percepcion_iibb', jurisdiccion_id: -1, importe: 10 }).success).toBe(false)
  })
})
