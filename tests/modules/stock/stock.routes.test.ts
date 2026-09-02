/**
 * Contrato HTTP de los endpoints de materiales del catálogo.
 * Lo consume el frontend (modal "¿no será este?" del alta de material), así
 * que el shape de la respuesta 409 está fijado acá a propósito.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type FilaLite = { id: number; nombre: string; unidad: string | null; alias: string[] }

const { estado } = vi.hoisted(() => ({
  estado: {
    materiales: [] as FilaLite[],
    ultimoInsert: null as any,
    filtros: [] as Array<[string, unknown]>,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-uuid', email: 'u@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso:   () => async (_c: any, next: any) => next(),
  requirePermisoOr: () => async (_c: any, next: any) => next(),
}))

vi.mock('../../../src/lib/supabase.js', () => {
  function tabla() {
    let modo: 'select' | 'insert' | 'update' = 'select'
    let rango: [number, number] = [0, 999]
    function resolver() {
      if (modo === 'insert') return { data: estado.ultimoInsert, error: null }
      if (modo === 'update') return { data: { id: 1 }, error: null }
      return { data: estado.materiales.slice(rango[0], rango[1] + 1), error: null }
    }
    const obj: any = {
      select: () => obj,
      eq:     (col: string, val: unknown) => { estado.filtros.push([col, val]); return obj },
      order:  () => obj,
      range:  (a: number, b: number) => { rango = [a, b]; return obj },
      insert: (v: any) => { modo = 'insert'; estado.ultimoInsert = v; return obj },
      update: (v: any) => { modo = 'update'; return obj },
      single:      () => Promise.resolve(resolver()),
      maybeSingle: () => Promise.resolve(resolver()),
      then: (f: any) => Promise.resolve(resolver()).then(f),
    }
    return obj
  }
  const cliente = { from: () => tabla(), storage: { from: () => ({}) } }
  return { createSupabaseClient: () => cliente, supabase: cliente }
})

import stock from '../../../src/modules/stock/stock.routes.js'

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  estado.materiales   = []
  estado.ultimoInsert = null
  estado.filtros      = []
})

describe('GET /materiales', () => {
  it('filtra activo=true por defecto', async () => {
    await stock.request('/materiales')
    expect(estado.filtros).toContainEqual(['activo', true])
  })

  it('con ?incluir_inactivos=1 no filtra por activo', async () => {
    await stock.request('/materiales?incluir_inactivos=1')
    expect(estado.filtros).not.toContainEqual(['activo', true])
  })
})

describe('POST /materiales', () => {
  it('devuelve 409 MATERIAL_PARECIDO con los candidatos', async () => {
    estado.materiales = [{ id: 7, nombre: 'Lija al agua N°150', unidad: 'unid', alias: [] }]
    const res  = await stock.request('/materiales', json({ rubro_id: 1, nombre: 'Lija al agua N°180' }))
    const body = await res.json() as any

    expect(res.status).toBe(409)
    expect(body.code).toBe('MATERIAL_PARECIDO')
    expect(typeof body.error).toBe('string')
    expect(body.candidatos).toHaveLength(1)
    expect(body.candidatos[0]).toEqual({
      id: 7, nombre: 'Lija al agua N°150', unidad: 'unid',
      sim: expect.any(Number), por_alias: false,
    })
  })

  it('con forzar:true crea igual (201) y guarda alias normalizados', async () => {
    estado.materiales = [{ id: 7, nombre: 'Lija al agua N°150', unidad: 'unid', alias: [] }]
    const res = await stock.request('/materiales', json({
      rubro_id: 1, nombre: 'Lija al agua N°180', alias: ['Lija 180'], forzar: true,
    }))
    expect(res.status).toBe(201)
    expect(estado.ultimoInsert.alias).toEqual(['lija 180'])
  })
})
