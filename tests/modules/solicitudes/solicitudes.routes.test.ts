/**
 * Tests del handler `POST /items/:itemId/despachar` — check condicional
 * del permiso `forzar_despacho` en el body.
 *
 * Mockeamos:
 *  - `authMiddleware` (pasa el user al context).
 *  - `requirePermiso` (deja pasar, permiso base ya asumido).
 *  - `createSupabaseClient` (para el service via RPC).
 *  - `supabase` (service role, para leer profiles.permisos en el handler).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Estado mutable compartido entre test y mock ────────────────
// `vi.hoisted` evita el TDZ (vi.mock se hoistea y leería undefined si no).
const { rpcMock, fromSolicitudesMock, state } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromSolicitudesMock: vi.fn(),
  state: { profile: null as any },
}))

// ── Mock del middleware de auth: inyecta user + accessToken ────
vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-uuid', email: 'u@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

// ── Mock del requirePermiso: siempre deja pasar (base OK) ──────
vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso: (_modulo: string, _accion: string) => async (_c: any, next: any) => next(),
  requirePermisoOr: (_c: any, _n: any) => async (_cc: any, next: any) => next(),
}))

// ── Mock del módulo supabase ──────────────────────────────────
vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_t: string) => ({
    rpc: rpcMock,
    from: fromSolicitudesMock,
  }),
  // `supabase` (service-role): usado por tienePermisoExtra para leer profiles
  supabase: {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: state.profile, error: null }),
        }),
      }),
    }),
  },
}))

// Importamos el app DESPUES de los mocks.
import solicitudes from '../../../src/modules/solicitudes/solicitudes.routes.js'

function chainable(resolved: { data: any; error: any }) {
  const obj: any = {
    select:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    delete:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    order:       vi.fn(() => obj),
    maybeSingle: vi.fn(() => Promise.resolve(resolved)),
    single:      vi.fn(() => Promise.resolve(resolved)),
    then:        (ok: any) => Promise.resolve(resolved).then(ok),
  }
  return obj
}

async function postDespachar(body: any, itemId = 10) {
  const res = await solicitudes.request(`/items/${itemId}/despachar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res
}

beforeEach(() => {
  rpcMock.mockReset()
  fromSolicitudesMock.mockReset()
  state.profile = null
  process.env.USE_RPC_RESOLVER = 'true'
})

afterEach(() => {
  delete process.env.USE_RPC_RESOLVER
})

describe('POST /items/:itemId/despachar — check forzar_sin_stock', () => {
  it('sin forzar_sin_stock llama al service y devuelve 200', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ item_id: 10 }], error: null })
    fromSolicitudesMock.mockReturnValueOnce(chainable({
      data: { id: 10, estado: 'de_deposito', solicitud_compra: { id: 1, obra_cod: 'O-1' } },
      error: null,
    }))

    const res = await postDespachar({ precio_unit: 20 })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('resolver_item_despacho', expect.objectContaining({
      p_forzar_sin_stock: false,
    }))
  })

  it('con forzar_sin_stock=true SIN permiso devuelve 403 SIN_PERMISO_FORZAR y NO llama al service', async () => {
    state.profile = { rol: 'user', permisos: { certificaciones: { creacion: true } } }

    const res = await postDespachar({ precio_unit: 20, forzar_sin_stock: true })
    expect(res.status).toBe(403)
    const body = await res.json() as any
    expect(body).toEqual({ error: 'SIN_PERMISO_FORZAR' })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('con forzar_sin_stock=true CON permiso llama a la RPC con p_forzar_sin_stock=true', async () => {
    state.profile = {
      rol: 'user',
      permisos: { certificaciones: { creacion: true, forzar_despacho: true } },
    }
    rpcMock.mockResolvedValueOnce({ data: [{ item_id: 10 }], error: null })
    fromSolicitudesMock.mockReturnValueOnce(chainable({
      data: { id: 10, estado: 'de_deposito', solicitud_compra: { id: 1, obra_cod: 'O-1' } },
      error: null,
    }))

    const res = await postDespachar({ precio_unit: 20, forzar_sin_stock: true })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('resolver_item_despacho', expect.objectContaining({
      p_forzar_sin_stock: true,
    }))
  })

  it('admin con forzar_sin_stock=true pasa sin tener el flag explícito', async () => {
    state.profile = { rol: 'admin', permisos: null }
    rpcMock.mockResolvedValueOnce({ data: [{ item_id: 10 }], error: null })
    fromSolicitudesMock.mockReturnValueOnce(chainable({
      data: { id: 10, estado: 'de_deposito', solicitud_compra: { id: 1, obra_cod: 'O-1' } },
      error: null,
    }))

    const res = await postDespachar({ precio_unit: 20, forzar_sin_stock: true })
    expect(res.status).toBe(200)
  })
})
