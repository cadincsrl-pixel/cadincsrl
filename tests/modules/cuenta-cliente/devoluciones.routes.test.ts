/**
 * `GET /api/cuenta-cliente/devoluciones?obra_cod=…` (20260914ai): la lista de
 * todo lo que volvió al depósito desde una obra, para la sección Devoluciones
 * de la cuenta corriente.
 *
 * Lo que importa acá: que exija la obra, que valide el alcance del usuario
 * ANTES de leer, y que pegue a la RPC correcta con la obra pedida.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock, validarObraMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  validarObraMock: vi.fn(),
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-uuid', email: 'u@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso:   (_m: string, _a: string) => async (_c: any, next: any) => next(),
  requirePermisoOr: (_combos: any) => async (_c: any, next: any) => next(),
  requireTab:       (_m: string, _t: string | string[]) => async (_c: any, next: any) => next(),
  tieneFlag:        async () => true,
}))

vi.mock('../../../src/lib/obras-usuario.js', () => ({
  validarObraDelUsuario:   validarObraMock,
  getObrasDelUsuarioCached: async () => null,
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_t: string) => ({ rpc: rpcMock }),
  supabase: { rpc: rpcMock, from: () => ({}) },
}))

import cuentaCliente from '../../../src/modules/cuenta-cliente/cuenta-cliente.routes.js'

const fila = {
  id: 16500, fecha: '2026-09-14T22:03:48Z', item_id: 2637, solicitud_id: 538,
  descripcion: 'Alambrón', unidad: 'kg', cantidad: 50, cantidad_antes: 50, cantidad_despues: 0,
  precio_unit: 3300, monto: 165000, efecto: 'descontado', nota_credito_id: null, nota_anulada: false,
  motivo: 'compraron material y nos devuelven', user_id: 'user-uuid', usuario: 'Franco Leiro', item_estado: 'enviado',
}

beforeEach(() => {
  rpcMock.mockReset()
  validarObraMock.mockReset()
  validarObraMock.mockResolvedValue(undefined)
})

describe('GET /devoluciones', () => {
  it('sin obra_cod responde 400 y no toca la base', async () => {
    const res = await cuentaCliente.request('/devoluciones')
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
    expect(validarObraMock).not.toHaveBeenCalled()
  })

  it('valida el alcance del usuario sobre la obra y devuelve lo que dice la RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: [fila], error: null })
    const res = await cuentaCliente.request('/devoluciones?obra_cod=CC-013')
    expect(res.status).toBe(200)
    expect(validarObraMock).toHaveBeenCalledWith('user-uuid', 'CC-013', 'certificaciones')
    expect(rpcMock).toHaveBeenCalledWith('cuenta_corriente_devoluciones_detalle', { p_obra_cod: 'CC-013' })
    expect(await res.json()).toEqual([fila])
  })

  it('si el usuario no alcanza la obra, el error del scope corta antes de leer', async () => {
    validarObraMock.mockRejectedValueOnce(new Error('OBRA_FUERA_DE_ALCANCE'))
    const res = await cuentaCliente.request('/devoluciones?obra_cod=CC-999')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('sin devoluciones devuelve lista vacía, no null', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null })
    const res = await cuentaCliente.request('/devoluciones?obra_cod=CC-013')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
