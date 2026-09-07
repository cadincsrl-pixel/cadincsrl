// GET /api/prestamos: la lectura de préstamos pasa por el backend, paginada,
// con filtros por legajos y semana. Antes el front leía la tabla directo.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { estado } = vi.hoisted(() => ({
  estado: {
    ops: [] as Array<{ metodo: string; args: unknown[] }>,
    filas: [] as Array<Record<string, unknown>>,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('user', { id: 'u-1' }); c.set('accessToken', 'tok'); await next() },
}))
vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso: () => async (_c: any, next: any) => next(),
  requireTab:     () => async (_c: any, next: any) => next(),
}))
vi.mock('../../../src/lib/supabase.js', () => {
  const builder = () => {
    let desde = 0, hasta = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'order', 'in', 'eq', 'gte', 'lte']) {
      b[m] = (...args: unknown[]) => { estado.ops.push({ metodo: m, args }); return b }
    }
    b.range = (d: number, h: number) => { desde = d; hasta = h; return b }
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: estado.filas.slice(desde, hasta + 1), error: null }).then(res)
    return b
  }
  return { supabase: { from: () => builder() }, createSupabaseClient: () => ({ from: () => builder() }) }
})

import { Hono } from 'hono'
import prestamos from '../../../src/modules/prestamos/prestamos.routes.js'

const app = new Hono().route('/api/prestamos', prestamos)

beforeEach(() => { estado.ops.length = 0; estado.filas = [{ id: 2, leg: '001' }, { id: 1, leg: '002' }] })

describe('GET /api/prestamos', () => {
  it('sin filtros devuelve todo, ordenado por created_at e id descendentes', async () => {
    const res = await app.request('/api/prestamos')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(2)
    expect(estado.ops.filter(o => o.metodo === 'order').map(o => o.args)).toEqual([
      ['created_at', { ascending: false }], ['id', { ascending: false }],
    ])
    expect(estado.ops.some(o => o.metodo === 'in')).toBe(false)
  })

  it('legs y sem_key se traducen a filtros', async () => {
    await app.request('/api/prestamos?legs=001,%20002&sem_key=2026-09-04')
    expect(estado.ops.find(o => o.metodo === 'in')?.args).toEqual(['leg', ['001', '002']])
    expect(estado.ops.find(o => o.metodo === 'eq')?.args).toEqual(['sem_key', '2026-09-04'])
  })

  it('rango de semanas', async () => {
    await app.request('/api/prestamos?desde=2026-08-01&hasta=2026-08-28')
    expect(estado.ops.find(o => o.metodo === 'gte')?.args).toEqual(['sem_key', '2026-08-01'])
    expect(estado.ops.find(o => o.metodo === 'lte')?.args).toEqual(['sem_key', '2026-08-28'])
  })

  it('legs vacío = ningún legajo → [] sin consultar', async () => {
    const res = await app.request('/api/prestamos?legs=')
    expect(await res.json()).toEqual([])
    expect(estado.ops).toHaveLength(0)
  })

  it('pagina de a 1000 hasta agotar', async () => {
    estado.filas = Array.from({ length: 1500 }, (_, i) => ({ id: i, leg: '001' }))
    const res = await app.request('/api/prestamos')
    expect(await res.json()).toHaveLength(1500)
  })
})
