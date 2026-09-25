/**
 * GET/PATCH /api/empresa (tanda 6, 20260929a): forma de la respuesta, el
 * CUIT que no se edita, los errores de la RPC y la caché invalidada al guardar.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { estado } = vi.hoisted(() => ({
  estado: {
    fila: null as Record<string, unknown> | null,
    rpcs: [] as Array<{ fn: string; args?: unknown }>,
    errorGuardar: null as { message: string; details?: string } | null,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('user', { id: 'u-1' }); c.set('accessToken', 'tok'); await next() },
}))
vi.mock('../../../src/middleware/permission.js', () => ({
  requireFlag: () => async (_c: any, next: any) => next(),
  requireTab: () => async (_c: any, next: any) => next(),
}))
vi.mock('../../../src/lib/supabase.js', () => {
  const cli = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      estado.rpcs.push({ fn, args })
      if (fn === 'empresa_guardar') {
        if (estado.errorGuardar) return { data: null, error: estado.errorGuardar }
        estado.fila = { ...estado.fila, ...(args?.p_cambios as object) }
        return { data: estado.fila, error: null }
      }
      return { data: estado.fila, error: null }
    },
  }
  return { supabase: cli, createSupabaseClient: () => cli }
})

import { Hono } from 'hono'
import rutas from '../../../src/modules/empresa/empresa.routes.js'
import { empresaDefault, invalidarEmpresa } from '../../../src/lib/empresa.js'

const app = () => { const a = new Hono(); a.route('/api/empresa', rutas); return a }
const patch = (body: unknown) => app().request('/api/empresa', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('/api/empresa', () => {
  beforeEach(() => {
    invalidarEmpresa()
    estado.fila = { ...empresaDefault() }
    estado.rpcs.length = 0
    estado.errorGuardar = null
  })

  it('GET devuelve los datos con cuit_sistema y cache privado', async () => {
    const r = await app().request('/api/empresa')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('private, max-age=300')
    const j = await r.json() as any
    expect(j.razon_social).toBe('CADINC S.R.L.')
    expect(j.domicilio_factura_1).toBe('Maipú 396 3 – San Miguel de Tucumán')
    expect(j.cuit_sistema).toEqual({ arca_cuit: '33717191949', coincide: true })
  })

  it('PATCH con cuit → 400 CUIT_NO_EDITABLE sin llamar a la RPC', async () => {
    const r = await patch({ cuit: '20111111112' })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'CUIT_NO_EDITABLE' })
    expect(estado.rpcs.find(x => x.fn === 'empresa_guardar')).toBeUndefined()
  })

  it('PATCH con clave desconocida o dato inválido → 400 EMPRESA_INVALIDA con campo', async () => {
    let r = await patch({ foo: 'x' })
    expect(r.status).toBe(400)
    expect((await r.json() as any)).toMatchObject({ error: 'EMPRESA_INVALIDA', campo: 'foo' })
    r = await patch({ email: 'no-es-mail' })
    expect((await r.json() as any)).toMatchObject({ error: 'EMPRESA_INVALIDA', campo: 'email' })
  })

  it('PATCH válido llama a la RPC con el usuario e invalida la caché', async () => {
    await app().request('/api/empresa')                           // llena la caché
    const r = await patch({ telefono: '381 555' })
    expect(r.status).toBe(200)
    expect((await r.json() as any).telefono).toBe('381 555')
    expect(estado.rpcs).toContainEqual({ fn: 'empresa_guardar', args: { p_cambios: { telefono: '381 555' }, p_user_id: 'u-1' } })
    const g = await (await app().request('/api/empresa')).json() as any
    expect(g.telefono).toBe('381 555')
  })

  it('errores de la RPC salen con su status', async () => {
    estado.errorGuardar = { message: 'SIN_PERMISO', details: '{"flag":"configurar"}' }
    let r = await patch({ telefono: '1' })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'SIN_PERMISO', detail: { flag: 'configurar' } })
    estado.errorGuardar = { message: 'EMPRESA_INVALIDA', details: '{"campo":"inicio_actividades"}' }
    r = await patch({ inicio_actividades: '2099-01-01' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'EMPRESA_INVALIDA', campo: 'inicio_actividades' })
  })
})
