/**
 * Tests de las dos guardas de `PATCH /api/solicitudes/:id` (15/09).
 *
 * El caso real: Juan Pablo carga su propio pedido, se equivoca en una cantidad
 * y tiene que poder corregirla — sin darle `certificaciones.actualizacion`, que
 * es de TODO el módulo (consumible propio, cobros, proveedores, facturas,
 * fichas de stock).
 *
 * Lo que se verifica acá es la DECISIÓN de las guardas:
 *   requireEditarOFlag    → deja pasar con `actualizacion` O con `editar_pedidos`
 *   requireDuenoDelPedido → con el flag SOLO, el pedido tiene que ser propio
 *
 * La otra mitad de la regla ("siempre que no esté comprado ni enviado") no vive
 * acá: el service filtra por estado='pendiente' al actualizar y al borrar
 * renglones, y eso ya era así desde antes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock, state, updateSpy } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  updateSpy: vi.fn(),
  state: { profile: null as any, pedido: null as any },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'jp-uuid', email: 'jp@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

// Las acciones que NO son PATCH /:id siguen con su guard real; acá no se tocan.
vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso: (_m: string, _a: string) => async (_c: any, next: any) => next(),
  requirePermisoOr: (_m: any) => async (_c: any, next: any) => next(),
  puedeActualizarCatalogo: async (_c: any, next: any) => next(),
}))

vi.mock('../../../src/lib/obras-usuario.js', () => ({
  getObrasDelUsuarioCached: async () => null,
}))

// El service se mockea entero: lo que se prueba es el guard, no el update.
vi.mock('../../../src/modules/solicitudes/solicitudes.service.js', () => {
  class HttpError extends Error {
    constructor(public status: number, public code: string, public detail?: unknown) { super(code) }
  }
  return {
    HttpError,
    solicitudesService: { update: updateSpy },
  }
})

function perfilChain() {
  return {
    select: () => ({
      eq: () => ({
        single:      () => Promise.resolve({ data: state.profile, error: null }),
        maybeSingle: () => Promise.resolve({ data: state.profile, error: null }),
      }),
    }),
  }
}

function pedidoChain() {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: state.pedido, error: null }),
        single:      () => Promise.resolve({ data: state.pedido, error: null }),
      }),
    }),
  }
}

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_t: string) => ({ from: (t: string) => fromMock(t) }),
  supabase: { from: (t: string) => fromMock(t) },
}))

import solicitudes from '../../../src/modules/solicitudes/solicitudes.routes.js'

async function patchPedido(id = 7) {
  return solicitudes.request(`/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 99, descripcion: 'Disco', cantidad: 20, unidad: 'unid' }] }),
  })
}

beforeEach(() => {
  fromMock.mockReset()
  updateSpy.mockReset()
  updateSpy.mockResolvedValue({ id: 7 })
  state.profile = null
  state.pedido = null
  fromMock.mockImplementation((t: string) =>
    t === 'profiles' ? perfilChain() : t === 'solicitud_compra' ? pedidoChain() : pedidoChain())
})

describe('PATCH /api/solicitudes/:id — quién puede editar un pedido', () => {
  it('sin ningún permiso, rebota con 403', async () => {
    state.profile = { rol: 'operador', activo: true, permisos: { certificaciones: { lectura: true, creacion: true } } }
    const res = await patchPedido()
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('con `actualizacion` edita cualquier pedido, aunque sea de otro', async () => {
    state.profile = { rol: 'operador', activo: true, permisos: { certificaciones: { actualizacion: true } } }
    state.pedido  = { created_by: 'otro-uuid' }
    const res = await patchPedido()
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('con `editar_pedidos` edita el pedido PROPIO', async () => {
    state.profile = { rol: 'operador', activo: true, permisos: { certificaciones: { editar_pedidos: true } } }
    state.pedido  = { created_by: 'jp-uuid' }
    const res = await patchPedido()
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('con `editar_pedidos` NO puede editar el pedido de otro', async () => {
    state.profile = { rol: 'operador', activo: true, permisos: { certificaciones: { editar_pedidos: true } } }
    state.pedido  = { created_by: 'otro-uuid' }
    const res = await patchPedido()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'PEDIDO_AJENO' })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('con `editar_pedidos`, un pedido que no existe da 404 y no 403', async () => {
    state.profile = { rol: 'operador', activo: true, permisos: { certificaciones: { editar_pedidos: true } } }
    state.pedido  = null
    const res = await patchPedido()
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('admin pasa derecho, sin mirar el dueño', async () => {
    state.profile = { rol: 'admin', activo: true, permisos: {} }
    state.pedido  = { created_by: 'otro-uuid' }
    const res = await patchPedido()
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('un perfil desactivado no edita nada, aunque tenga el flag', async () => {
    state.profile = { rol: 'operador', activo: false, permisos: { certificaciones: { editar_pedidos: true, actualizacion: true } } }
    state.pedido  = { created_by: 'jp-uuid' }
    const res = await patchPedido()
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
