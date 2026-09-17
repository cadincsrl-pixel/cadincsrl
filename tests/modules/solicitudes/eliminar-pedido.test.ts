/**
 * `DELETE /api/solicitudes/:id` (20260917j): borrar un pedido son dos ciclos.
 *
 * Lo que importa acá: que el body opcional `{ compras }` llegue a la RPC tal
 * cual (o null si no viene), que un destino inventado sea 400 sin tocar la
 * base, y que los 409 de la RPC vuelvan con su código y su detalle, que es
 * lo que la pantalla usa para preguntar "¿queda en depósito o vuelve al
 * proveedor?" y para listar las compras sin ficha.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-uuid', email: 'u@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso:           (_m: string, _a: string) => async (_c: any, next: any) => next(),
  requirePermisoOr:         (_combos: any) => async (_c: any, next: any) => next(),
  requireTab:               (_m: string, _t: string | string[]) => async (_c: any, next: any) => next(),
  puedeActualizarCatalogo:  async () => true,
  tieneFlag:                async () => true,
}))

// null = alcance "todas": el service no valida la obra del pedido.
vi.mock('../../../src/lib/obras-usuario.js', () => ({
  validarObraDelUsuario:    async () => undefined,
  getObrasDelUsuarioCached: async () => null,
}))

// El guard de cobros lee materiales_a_cuenta_cliente con una cadena
// select→eq→not→limit que termina en un thenable con { data: [] }.
function sinCobros() {
  const obj: any = {
    select: () => obj, eq: () => obj, not: () => obj, limit: () => obj,
    then: (f: any) => Promise.resolve({ data: [], error: null }).then(f),
  }
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_t: string) => ({ rpc: rpcMock, from: () => sinCobros() }),
  supabase: { rpc: rpcMock, from: () => sinCobros() },
}))

import solicitudes from '../../../src/modules/solicitudes/solicitudes.routes.js'

const ok = {
  success: true, solicitud_id: 581, compras: 'a_deposito',
  vueltos_al_estante: 1, compras_a_deposito: 3, compras_devueltas: 0, omitidos_sin_stock: 0, items_revertidos: 4,
}

function del(id: number, body?: unknown) {
  return solicitudes.request(`/${id}`, {
    method: 'DELETE',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  rpcMock.mockReset()
})

describe('DELETE /:id — destino de las compras', () => {
  it('sin body manda p_compras null (pedido sin compras sin enviar)', async () => {
    rpcMock.mockResolvedValue({ data: { ...ok, compras: null }, error: null })
    const res = await del(581)
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('eliminar_solicitud', {
      p_solicitud_id: 581, p_user_id: 'user-uuid', p_compras: null,
    })
  })

  it('con { compras: "a_deposito" } se lo pasa a la RPC y devuelve el resumen', async () => {
    rpcMock.mockResolvedValue({ data: ok, error: null })
    const res = await del(581, { compras: 'a_deposito' })
    expect(res.status).toBe(200)
    expect(rpcMock.mock.calls[0]![1]).toMatchObject({ p_compras: 'a_deposito' })
    expect(await res.json()).toMatchObject({ compras_a_deposito: 3, vueltos_al_estante: 1 })
  })

  it('con { compras: "devuelta_proveedor" } también', async () => {
    rpcMock.mockResolvedValue({ data: { ...ok, compras: 'devuelta_proveedor', compras_a_deposito: 0, compras_devueltas: 3 }, error: null })
    const res = await del(581, { compras: 'devuelta_proveedor' })
    expect(res.status).toBe(200)
    expect(rpcMock.mock.calls[0]![1]).toMatchObject({ p_compras: 'devuelta_proveedor' })
  })

  it('un destino inventado es 400 y no llega a la base', async () => {
    const res = await del(581, { compras: 'la_tiro' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'DESTINO_INVALIDO' })
    expect(rpcMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /:id — lo que la RPC frena', () => {
  it('compras sin enviar y sin destino: 409 con cuántas son, para que la pantalla pregunte', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'ELEGIR_DESTINO_COMPRAS', details: '{"compras_sin_enviar" : 3}', code: 'P0001', hint: null },
    })
    const res = await del(581)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ELEGIR_DESTINO_COMPRAS', detail: { compras_sin_enviar: 3 } })
  })

  it('una compra sin ficha no puede entrar al depósito: 409 con la lista', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'COMPRA_SIN_FICHA', details: '{"renglones" : ["Formica 090 blanco 0.8mm"]}', code: 'P0001', hint: null },
    })
    const res = await del(852, { compras: 'a_deposito' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'COMPRA_SIN_FICHA', detail: { renglones: ['Formica 090 blanco 0.8mm'] } })
  })

  it('lo enviado está en la obra: 409 SOLICITUD_TIENE_ENVIOS', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'SOLICITUD_TIENE_ENVIOS', details: null, code: 'P0001', hint: null } })
    const res = await del(677, { compras: 'devuelta_proveedor' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'SOLICITUD_TIENE_ENVIOS' })
  })

  it('un retiro de proveedor también frena: 409 SOLICITUD_TIENE_RETIROS', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'SOLICITUD_TIENE_RETIROS', details: null, code: 'P0001', hint: null } })
    const res = await del(700)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'SOLICITUD_TIENE_RETIROS' })
  })
})
