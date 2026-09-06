/**
 * Alcance por obra en stock del cliente (/api/stock-cliente). Un usuario con
 * scope 'asignadas' solo lista, consulta y mueve material de SUS obras; con
 * scope 'todas' (o admin) no se filtra nada. El helper de alcance está
 * testeado aparte (tests/lib/obras-usuario.test.ts); acá se fija que cada
 * ruta lo llame.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'

const { estado } = vi.hoisted(() => ({
  estado: {
    allowed: null as string[] | null,
    obraDeItem: {} as Record<number, string>,
    llamadas: [] as Array<{ fn: string; args: unknown[] }>,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('user', { id: 'u-1' }); c.set('accessToken', 'tok'); await next() },
}))
vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso: () => async (_c: any, next: any) => next(),
  requireTab:     () => async (_c: any, next: any) => next(),
}))
vi.mock('../../../src/lib/obras-usuario.js', () => ({
  getObrasDelUsuarioCached: async () => estado.allowed,
  sinObras: (allowed: string[] | null) => allowed != null && allowed.length === 0,
  validarObraDelUsuario: async (_u: string, obra: string) => {
    if (estado.allowed != null && !estado.allowed.includes(obra)) throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  },
  validarObraDeRegistro: async (_u: string, _m: string, _t: string, id: number) => {
    if (estado.allowed == null) return
    const obra = estado.obraDeItem[id]
    if (!obra) throw new HTTPException(404, { message: 'NO_EXISTE' })
    if (!estado.allowed.includes(obra)) throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  },
}))
vi.mock('../../../src/modules/stock-cliente/stock-cliente.service.js', () => ({
  StockClienteHttpError: class extends Error { status = 400; code = 'X' },
  stockClienteService: {
    list:           async (...args: unknown[]) => { estado.llamadas.push({ fn: 'list', args }); return [{ obra_cod: 'CC-001' }] },
    getMovimientos: async (...args: unknown[]) => { estado.llamadas.push({ fn: 'getMovimientos', args }); return [] },
    entrada:        async (...args: unknown[]) => { estado.llamadas.push({ fn: 'entrada', args }); return { id: 1 } },
    entradaLote:    async (...args: unknown[]) => { estado.llamadas.push({ fn: 'entradaLote', args }); return { items: [] } },
    salida:         async (...args: unknown[]) => { estado.llamadas.push({ fn: 'salida', args }); return { id: 2 } },
  },
}))

import { Hono } from 'hono'
import stockCliente from '../../../src/modules/stock-cliente/stock-cliente.routes.js'

function app() {
  const a = new Hono()
  a.route('/api/stock-cliente', stockCliente)
  a.onError((err, c) => err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500))
  return a
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const entrada = { obra_cod: 'CC-002', descripcion: 'Cemento', unidad: 'bolsa', cantidad: 10 }

describe('scope por obra en stock-cliente', () => {
  beforeEach(() => { estado.allowed = null; estado.obraDeItem = { 7: 'CC-001', 8: 'CC-002' }; estado.llamadas.length = 0 })

  it('scope "todas": el listado no se filtra y las escrituras pasan', async () => {
    const a = app()
    expect((await a.request('/api/stock-cliente')).status).toBe(200)
    expect(estado.llamadas[0]).toMatchObject({ fn: 'list' })
    expect(estado.llamadas[0]!.args[2]).toBeNull()
    expect((await a.request('/api/stock-cliente/entrada', json(entrada))).status).toBe(201)
  })

  it('scope "asignadas": la lista va filtrada y otra obra da 403', async () => {
    estado.allowed = ['CC-001']
    const a = app()
    expect((await a.request('/api/stock-cliente')).status).toBe(200)
    expect(estado.llamadas[0]!.args[2]).toEqual(['CC-001'])
    expect((await a.request('/api/stock-cliente?obra_cod=CC-002')).status).toBe(403)
    const res = await a.request('/api/stock-cliente/entrada', json(entrada))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'OBRA_SIN_ACCESO' })
    expect((await a.request('/api/stock-cliente/entrada-lote', json({ obra_cod: 'CC-002', items: [{ descripcion: 'Cal', unidad: 'bolsa', cantidad: 1 }] }))).status).toBe(403)
    expect(estado.llamadas.filter(l => l.fn !== 'list')).toHaveLength(0)
  })

  it('movimientos y salida validan la obra del ítem', async () => {
    estado.allowed = ['CC-001']
    const a = app()
    expect((await a.request('/api/stock-cliente/items/7/movimientos')).status).toBe(200)
    expect((await a.request('/api/stock-cliente/items/8/movimientos')).status).toBe(403)
    expect((await a.request('/api/stock-cliente/items/99/movimientos')).status).toBe(404)
    expect((await a.request('/api/stock-cliente/salida', json({ item_id: 8, cantidad: 1 }))).status).toBe(403)
    expect((await a.request('/api/stock-cliente/salida', json({ item_id: 7, cantidad: 1 }))).status).toBe(201)
  })

  it('con alcance pero sin obras asignadas el listado es vacío sin consultar', async () => {
    estado.allowed = []
    const res = await app().request('/api/stock-cliente')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(estado.llamadas).toHaveLength(0)
  })
})
