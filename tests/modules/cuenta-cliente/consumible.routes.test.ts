/**
 * `POST /api/cuenta-cliente/consumible` (20260917n): marcar consumibles propios
 * lo habilita `cargar_precios` O el flag nuevo `marcar_consumibles`, que es
 * sólo esa capacidad (sin valuar la cuenta ni certificar). Sin ninguno de los
 * dos, 403 y la base no se toca.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock, validarObraMock, state } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  validarObraMock: vi.fn(),
  state: { flags: new Set<string>() },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'diego-uuid', email: 'd@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso:   (_m: string, _a: string) => async (_c: any, next: any) => next(),
  requirePermisoOr: (_combos: any) => async (_c: any, next: any) => next(),
  requireTab:       (_m: string, _t: string | string[]) => async (_c: any, next: any) => next(),
  tieneFlag:        async (_u: string, _m: string, flag: string) => state.flags.has(flag),
}))

vi.mock('../../../src/lib/obras-usuario.js', () => ({
  validarObraDelUsuario:    validarObraMock,
  getObrasDelUsuarioCached: async () => null,
}))

function neutro() {
  const obj: any = {
    select: () => obj, eq: () => obj, in: () => obj, not: () => obj, order: () => obj, limit: () => obj,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (f: any) => Promise.resolve({ data: [], error: null }).then(f),
  }
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_t: string) => ({ rpc: rpcMock, from: () => neutro() }),
  supabase: { rpc: rpcMock, from: () => neutro() },
}))

import cuentaCliente from '../../../src/modules/cuenta-cliente/cuenta-cliente.routes.js'

const body = { obra_cod: 'CC-018', item_ids: [4061, 4062], marcar: true, motivo: 'discos de corte' }

function post() {
  return cuentaCliente.request('/consumible', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  rpcMock.mockReset()
  validarObraMock.mockReset()
  validarObraMock.mockResolvedValue(undefined)
  state.flags.clear()
  rpcMock.mockResolvedValue({ data: { obra_cod: 'CC-018', marcados: 2, marcar: true, plata: 1234 }, error: null })
})

describe('POST /consumible — quién puede marcar', () => {
  it('con marcar_consumibles solo (Diego): pasa y llama a la RPC', async () => {
    state.flags.add('marcar_consumibles')
    const res = await post()
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('marcar_consumible_propio', {
      p_obra_cod: 'CC-018', p_item_ids: [4061, 4062], p_marcar: true, p_motivo: 'discos de corte', p_user_id: 'diego-uuid',
    })
    expect(await res.json()).toMatchObject({ marcados: 2 })
  })

  it('con cargar_precios solo (el dueño): sigue pasando', async () => {
    state.flags.add('cargar_precios')
    const res = await post()
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('sin ninguno de los dos: 403 SIN_PERMISO_MARCAR_CONSUMIBLES y la base no se toca', async () => {
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'SIN_PERMISO_MARCAR_CONSUMIBLES' })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('el alcance por obra se valida antes del flag', async () => {
    state.flags.add('marcar_consumibles')
    await post()
    expect(validarObraMock).toHaveBeenCalledWith('diego-uuid', 'CC-018', 'certificaciones')
  })
})
