/**
 * Guardias de permisos (src/middleware/permission.ts). Fija que un perfil
 * desactivado no pasa NINGUNA guardia aunque su JWT siga vivo, que el admin
 * bypasea solo si está activo, y los defaults de requireFlag/tieneFlag.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

type Perfil = { rol: string; rol_base: string | null; permisos: Record<string, Record<string, unknown>> | null; activo: boolean }
const { estado } = vi.hoisted(() => ({ estado: { perfil: null as Perfil | null } }))

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: estado.perfil, error: null }) }) }) }),
  },
  createSupabaseClient: () => ({}),
}))

import { requirePermiso, requirePermisoOr, requireFlag, tieneFlag, esCapataz } from '../../src/middleware/permission.js'

type Vars = { Variables: { user: { id: string } } }
function crearApp() {
  const app = new Hono<Vars>()
  app.use('*', async (c, next) => { c.set('user', { id: 'u-1' }); await next() })
  app.get('/permiso', requirePermiso('tarja', 'lectura'), (c) => c.json({ ok: true }))
  app.get('/permiso-or', requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]), (c) => c.json({ ok: true }))
  app.get('/flag', requireFlag('tarja', 'ver_pii'), (c) => c.json({ ok: true }))
  app.get('/flag-default-true', requireFlag('tarja', 'ver_costos', true, true), (c) => c.json({ ok: true }))
  app.onError((err, c) => err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: 'boom' }, 500))
  return app
}

const operador = (permisos: Perfil['permisos'], activo = true): Perfil => ({ rol: 'operador', rol_base: null, permisos, activo })

describe('perfil desactivado', () => {
  beforeEach(() => { estado.perfil = null })

  it('no pasa requirePermiso aunque tenga el permiso', async () => {
    estado.perfil = operador({ tarja: { lectura: true } }, false)
    const res = await crearApp().request('/permiso')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Usuario inactivo' })
  })

  it('no pasa requirePermisoOr ni requireFlag', async () => {
    estado.perfil = operador({ tarja: { lectura: true, ver_pii: true } }, false)
    const app = crearApp()
    expect((await app.request('/permiso-or')).status).toBe(403)
    expect((await app.request('/flag')).status).toBe(403)
  })

  it('un admin desactivado tampoco bypasea', async () => {
    estado.perfil = { rol: 'admin', rol_base: null, permisos: null, activo: false }
    expect((await crearApp().request('/permiso')).status).toBe(403)
  })

  it('tieneFlag y esCapataz devuelven false', async () => {
    estado.perfil = { rol: 'operador', rol_base: 'capataz', permisos: { tarja: { ver_pii: true } }, activo: false }
    expect(await tieneFlag('u-1', 'tarja', 'ver_pii')).toBe(false)
    expect(await esCapataz('u-1')).toBe(false)
  })
})

describe('perfil activo', () => {
  it('operador con permiso pasa; sin permiso 403 con el detalle', async () => {
    const app = crearApp()
    estado.perfil = operador({ tarja: { lectura: true } })
    expect((await app.request('/permiso')).status).toBe(200)
    estado.perfil = operador({ tarja: { lectura: false } })
    const res = await app.request('/permiso')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sin permiso para lectura en módulo tarja' })
  })

  it('admin bypasea todo', async () => {
    estado.perfil = { rol: 'admin', rol_base: null, permisos: null, activo: true }
    const app = crearApp()
    expect((await app.request('/permiso')).status).toBe(200)
    expect((await app.request('/flag')).status).toBe(200)
  })

  it('requirePermisoOr alcanza con uno de los combos', async () => {
    estado.perfil = operador({ tarja: { lectura: true } })
    expect((await crearApp().request('/permiso-or')).status).toBe(200)
  })

  it('requireFlag: sin el flag usa el default (false salvo que se pida true)', async () => {
    estado.perfil = operador({ tarja: { lectura: true } })
    const app = crearApp()
    expect((await app.request('/flag')).status).toBe(403)
    expect((await app.request('/flag-default-true')).status).toBe(200)
    expect(await tieneFlag('u-1', 'tarja', 'ver_pii')).toBe(false)
    expect(await tieneFlag('u-1', 'tarja', 'ver_costos', true)).toBe(true)
  })

  it('esCapataz solo para rol_base capataz no admin', async () => {
    estado.perfil = { rol: 'operador', rol_base: 'capataz', permisos: null, activo: true }
    expect(await esCapataz('u-1')).toBe(true)
    estado.perfil = { rol: 'admin', rol_base: 'capataz', permisos: null, activo: true }
    expect(await esCapataz('u-1')).toBe(false)
  })
})
