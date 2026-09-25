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
import { pagosConfigService, baseDesdeJson, resolverEmailContador, cambiosParaDb, PagosConfigPatchSchema, nombreRemitenteEfectivo, responderAEfectivo } from '../../../src/modules/pagos/config.service.js'
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
    const j = await r.json()
    // Lo que ya leía el alta de la factura sigue igual.
    expect(j.tributos).toEqual({ jurisdiccion_default_id: 24 })
    // Sin plazos en la base → los de hoy.
    expect(j.cheques).toEqual({ plazos: [0, 7, 15, 30, 45, 60, 90] })
    expect(j.aviso).toMatchObject({ contador_email: null, responder_a: null, nombre_remitente: null, pie_texto: null })
    expect(j.aviso.smtp).toHaveProperty('configurado')
  })
  it('cachea; guardar la renueva', async () => {
    await pagosConfigService.obtener()
    await pagosConfigService.obtener()
    expect(state.rpcs.filter((x) => x.fn === 'pagos_config_json')).toHaveLength(1)
    await pagosConfigService.guardar({ tributo_jurisdiccion_default_id: 17 }, 'u-1')
    expect((await pagosConfigService.obtener()).tributos.jurisdiccion_default_id).toBe(17)
  })
  it('baseDesdeJson: basura → null / plazos por defecto', () => {
    const b = baseDesdeJson(null)
    expect(b.tributo_jurisdiccion_default_id).toBeNull()
    expect(b.plazos_cheque).toEqual([0, 7, 15, 30, 45, 60, 90])
    expect(baseDesdeJson({ tributo_jurisdiccion_default_id: 'x', plazos_cheque: 'x' }).tributo_jurisdiccion_default_id).toBeNull()
    // Ordenados, sin repetir, sin fuera de rango.
    expect(baseDesdeJson({ plazos_cheque: [30, 0, 30, 400, -1] }).plazos_cheque).toEqual([0, 30])
    expect(baseDesdeJson({ aviso_contador_email: '  ' }).aviso_contador_email).toBeNull()
  })
  it('GET devuelve los avisos y plazos guardados', async () => {
    state.profile = perfil({ lectura: true, tabs: ['facturas'] })
    state.config = { tributo_jurisdiccion_default_id: 24, aviso_contador_email: 'estudio@contable.com.ar',
      aviso_nombre_remitente: 'CADINC Pagos', aviso_pie_texto: 'Consultas: pagos@cadinc.com.ar', plazos_cheque: [0, 30, 60] }
    const j = await (await pagos.request('/config')).json()
    expect(j.aviso).toMatchObject({ contador_email: 'estudio@contable.com.ar', contador_email_efectivo: 'estudio@contable.com.ar',
      contador_fuente: 'config', nombre_remitente: 'CADINC Pagos', pie_texto: 'Consultas: pagos@cadinc.com.ar' })
    expect(j.cheques.plazos).toEqual([0, 30, 60])
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
    const r2 = await patch({ clave_inventada: 1 })
    expect(await r2.json()).toMatchObject({ error: 'CONFIG_INVALIDA', campo: 'clave_inventada' })
    state.error = { message: 'CONFIG_INVALIDA', details: '{"clave":"tributo_jurisdiccion_default_id","motivo":"jurisdiccion_inexistente_o_inactiva"}' }
    expect((await patch({ tributo_jurisdiccion_default_id: 999 })).status).toBe(400)
  })
})

describe('PATCH /config — avisos y plazos (20260929i)', () => {
  beforeEach(() => { state.profile = perfil({ lectura: true, tabs: ['configuracion'], configurar: true }) })
  it('traduce los nombres de la API a las claves de la base', async () => {
    const r = await patch({ contador_email: ' Estudio@Contable.com.ar ', responder_a: '', nombre_remitente: 'CADINC Pagos',
      pie_texto: 'Consultas al 381-4123456', plazos_cheque: [0, 30] })
    expect(r.status).toBe(200)
    expect(state.rpcs.find((x) => x.fn === 'pagos_guardar_config')?.args).toEqual({ p_user_id: 'u-1', p_cambios: {
      aviso_contador_email: 'estudio@contable.com.ar', aviso_responder_a: null, aviso_nombre_remitente: 'CADINC Pagos',
      aviso_pie_texto: 'Consultas al 381-4123456', plazos_cheque: [0, 30] } })
  })
  it('email malo → 400 EMAIL_INVALIDO, sin llegar a la RPC', async () => {
    const r = await patch({ contador_email: 'contador@' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'EMAIL_INVALIDO', campo: 'contador_email' })
    expect(state.rpcs.find((x) => x.fn === 'pagos_guardar_config')).toBeUndefined()
  })
  it('pie con CBU o alias → 400 PIE_CON_CBU', async () => {
    for (const pie of ['Transferir a 0070399520000003055000', 'CBU 0070 3995 2000 0003 0550 00', 'Alias: norte.distrib']) {
      const r = await patch({ pie_texto: pie })
      expect(await r.json()).toMatchObject({ error: 'PIE_CON_CBU', campo: 'pie_texto' })
    }
  })
  it('nombre con <> y plazos inválidos → CONFIG_INVALIDA', async () => {
    expect(await (await patch({ nombre_remitente: 'CADINC <x>' })).json()).toMatchObject({ error: 'CONFIG_INVALIDA', campo: 'nombre_remitente' })
    for (const plazos of [[], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], [0, 366], [-1], [7.5], [30, 30]]) {
      expect(await (await patch({ plazos_cheque: plazos })).json()).toMatchObject({ error: 'CONFIG_INVALIDA' })
    }
  })
  it('el error de la base (motivo) vuelve con el código de la pantalla y la clave de la API', async () => {
    state.error = { message: 'CONFIG_INVALIDA', details: '{"clave":"aviso_pie_texto","motivo":"pie_con_cbu"}' }
    const r = await patch({ pie_texto: 'hola' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'PIE_CON_CBU', campo: 'pie_texto', detail: { clave: 'pie_texto' } })
  })
  it('cambiosParaDb omite lo no mandado', () => {
    expect(cambiosParaDb(PagosConfigPatchSchema.parse({ plazos_cheque: [15] }))).toEqual({ plazos_cheque: [15] })
  })
})

describe('probar-mail', () => {
  it('mismo guard que PATCH', async () => {
    state.profile = perfil({ lectura: true, tabs: ['configuracion'] })
    const r = await pagos.request('/config/probar-mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ para: 'a@b.com' }) })
    expect(r.status).toBe(403)
  })
})

describe('resolverEmailContador: pantalla → env → perfil', () => {
  it('orden y fuente', async () => {
    const perfilFn = vi.fn(async () => 'perfil@x.com')
    expect(await resolverEmailContador('conf@x.com', { env: 'env@x.com', delPerfil: perfilFn })).toEqual({ email: 'conf@x.com', fuente: 'config' })
    expect(await resolverEmailContador(null, { env: 'env@x.com', delPerfil: perfilFn })).toEqual({ email: 'env@x.com', fuente: 'env' })
    expect(perfilFn).not.toHaveBeenCalled()
    expect(await resolverEmailContador('', { env: '', delPerfil: perfilFn })).toEqual({ email: 'perfil@x.com', fuente: 'perfil' })
    expect(await resolverEmailContador(null, { env: 'malo', delPerfil: async () => null })).toEqual({ email: null, fuente: null })
    expect(await resolverEmailContador(null, { env: '', delPerfil: async () => { throw new Error('auth caído') } })).toEqual({ email: null, fuente: null })
  })
  it('responder a y nombre del remitente caen al env / nombre de fantasía', () => {
    expect(responderAEfectivo('a@x.com', 'env@x.com')).toBe('a@x.com')
    expect(responderAEfectivo(null, 'env@x.com')).toBe('env@x.com')
    expect(responderAEfectivo(null, '')).toBeNull()
    expect(nombreRemitenteEfectivo('CADINC Pagos', 'CADINC')).toBe('CADINC Pagos')
    expect(nombreRemitenteEfectivo('  ', 'CADINC')).toBe('CADINC')
  })
})

describe('TributoSchema', () => {
  it('acepta jurisdiccion_id (y el texto viejo sigue valiendo)', () => {
    expect(TributoSchema.parse({ tipo: 'percepcion_iibb', jurisdiccion_id: 24, importe: 10 }).jurisdiccion_id).toBe(24)
    expect(TributoSchema.parse({ tipo: 'percepcion_iibb', jurisdiccion: 'Tucumán', importe: 10 }).jurisdiccion).toBe('Tucumán')
    expect(TributoSchema.safeParse({ tipo: 'percepcion_iibb', jurisdiccion_id: -1, importe: 10 }).success).toBe(false)
  })
})
