/**
 * Alcance por obra en materiales/adicionales certificables (/api/certificaciones).
 * Son precios al cliente de cada obra: un usuario con scope 'asignadas' no
 * lista, crea ni edita los de otra obra.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'

const { estado } = vi.hoisted(() => ({
  estado: { allowed: null as string[] | null, obraDeFila: {} as Record<number, string>, llamadas: [] as string[] },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('user', { id: 'u-1' }); c.set('accessToken', 'tok'); await next() },
}))
vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso: () => async (_c: any, next: any) => next(),
}))
vi.mock('../../../src/lib/obras-usuario.js', () => ({
  getObrasDelUsuarioCached: async () => estado.allowed,
  sinObras: (allowed: string[] | null) => allowed != null && allowed.length === 0,
  validarObraDelUsuario: async (_u: string, obra: string) => {
    if (estado.allowed != null && !estado.allowed.includes(obra)) throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  },
  validarObraDeRegistro: async (_u: string, _m: string, _t: string, id: number) => {
    if (estado.allowed == null) return
    const obra = estado.obraDeFila[id]
    if (!obra) throw new HTTPException(404, { message: 'NO_EXISTE' })
    if (!estado.allowed.includes(obra)) throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  },
}))
vi.mock('../../../src/modules/certificaciones/certificaciones.service.js', () => ({
  certificacionesService: {
    getMateriales:   async (_t: string, _o?: string, allowed?: string[] | null) => { estado.llamadas.push(`getMateriales:${JSON.stringify(allowed ?? null)}`); return [] },
    getAdicionales:  async () => { estado.llamadas.push('getAdicionales'); return [] },
    createMaterial:  async () => { estado.llamadas.push('createMaterial'); return { id: 1 } },
    updateMaterial:  async () => { estado.llamadas.push('updateMaterial'); return { id: 1 } },
    deleteMaterial:  async () => { estado.llamadas.push('deleteMaterial'); return { ok: true } },
    createAdicional: async () => { estado.llamadas.push('createAdicional'); return { id: 1 } },
    updateAdicional: async () => { estado.llamadas.push('updateAdicional'); return { id: 1 } },
    deleteAdicional: async () => { estado.llamadas.push('deleteAdicional'); return { ok: true } },
  },
}))

import { Hono } from 'hono'
import cert from '../../../src/modules/certificaciones/certificaciones.routes.js'

function app() {
  const a = new Hono()
  a.route('/api/certificaciones', cert)
  a.onError((err, c) => err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500))
  return a
}
const req = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const material = { obra_cod: 'CC-002', descripcion: 'Cemento', cantidad: 10, precio_unit: 1000, fecha: '2026-09-06' }

describe('scope por obra en certificaciones', () => {
  beforeEach(() => { estado.allowed = null; estado.obraDeFila = { 5: 'CC-001', 6: 'CC-002' }; estado.llamadas.length = 0 })

  it('scope "todas": lista sin filtro y escribe en cualquier obra', async () => {
    const a = app()
    expect((await a.request('/api/certificaciones/materiales')).status).toBe(200)
    expect(estado.llamadas).toEqual(['getMateriales:null'])
    expect((await a.request('/api/certificaciones/materiales', req('POST', material))).status).toBe(201)
  })

  it('scope "asignadas": lista filtrada, otra obra 403 en GET/POST/PATCH/DELETE', async () => {
    estado.allowed = ['CC-001']
    const a = app()
    expect((await a.request('/api/certificaciones/materiales')).status).toBe(200)
    expect(estado.llamadas).toEqual(['getMateriales:["CC-001"]'])
    expect((await a.request('/api/certificaciones/materiales?obra_cod=CC-002')).status).toBe(403)
    expect((await a.request('/api/certificaciones/materiales', req('POST', material))).status).toBe(403)
    expect((await a.request('/api/certificaciones/materiales/6', req('PATCH', { cantidad: 1 }))).status).toBe(403)
    expect((await a.request('/api/certificaciones/materiales/6', { method: 'DELETE' })).status).toBe(403)
    expect((await a.request('/api/certificaciones/materiales/5', req('PATCH', { cantidad: 1 }))).status).toBe(200)
    expect((await a.request('/api/certificaciones/adicionales/99', { method: 'DELETE' })).status).toBe(404)
    expect(estado.llamadas.filter(l => l.startsWith('create') || l.startsWith('delete'))).toHaveLength(0)
  })
})
