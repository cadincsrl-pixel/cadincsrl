/**
 * Deshacer una importación de «Mis Comprobantes» (20260929k): guardias (vista
 * previa con lectura + tab facturas + importar_comprobantes; aplicar además
 * con pagos.eliminacion), el motivo (400 antes de llamar a la RPC), lo que le
 * llega a la RPC y los errores de la base (409 con los bloqueos).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    rpcs: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
    error: null as { message: string; details?: string } | null,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))
vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))

function chain(data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit']) obj[m] = () => obj
  obj.single = () => Promise.resolve({ data, error: null })
  obj.maybeSingle = () => Promise.resolve({ data, error: null })
  obj.then = (ok: any, ko: any) => Promise.resolve({ data, error: null }).then(ok, ko)
  return obj
}

const RES = (aplicado: boolean) => ({
  importacion: { id: 13, archivo: 'agosto.xlsx', created_at: '2026-09-24T22:55:30Z', historica: true, filas: 348 },
  total: 348, a_anular: 348, ya_anuladas: 0, asientos_a_anular: 192, bloqueos: [], puede: true, aplicado,
})

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => chain(t === 'profiles' ? state.profile : null),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      if (state.error) return { data: null, error: state.error }
      if (fn === 'pagos_deshacer_importacion') return { data: RES(Boolean(args?.p_aplicar)), error: null }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'

const perfil = (p: Fila): Fila => ({ rol: 'operador', activo: true, rol_base: null, permisos: { pagos: p } })
const VISTA = perfil({ lectura: true, tabs: ['facturas'], importar_comprobantes: true })
const APLICA = perfil({ lectura: true, eliminacion: true, tabs: ['facturas'], importar_comprobantes: true })
const post = (path: string, body: unknown) =>
  pagos.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const llamadas = () => state.rpcs.filter((x) => x.fn === 'pagos_deshacer_importacion')

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
})

describe('GET /importaciones/:id/deshacer (vista previa)', () => {
  it('sin el flag o sin la tab → 403 y no llama a la RPC', async () => {
    state.profile = perfil({ lectura: true, tabs: ['facturas'] })
    expect((await pagos.request('/importaciones/13/deshacer')).status).toBe(403)
    state.profile = perfil({ lectura: true, tabs: ['pagos'], importar_comprobantes: true })
    expect((await pagos.request('/importaciones/13/deshacer')).status).toBe(403)
    expect(llamadas()).toHaveLength(0)
  })

  it('con lectura + tab + flag → la RPC en modo vista previa', async () => {
    state.profile = VISTA
    const r = await pagos.request('/importaciones/13/deshacer')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ a_anular: 348, asientos_a_anular: 192, aplicado: false })
    expect(llamadas()).toEqual([{ fn: 'pagos_deshacer_importacion', args: { p_importacion_id: 13, p_motivo: null, p_user_id: 'u-1', p_aplicar: false } }])
  })

  it('id inválido → 400; importación inexistente → 404', async () => {
    state.profile = VISTA
    expect((await pagos.request('/importaciones/abc/deshacer')).status).toBe(400)
    state.error = { message: 'IMPORTACION_NO_EXISTE', details: '{"importacion_id":99}' }
    expect((await pagos.request('/importaciones/99/deshacer')).status).toBe(404)
  })
})

describe('POST /importaciones/:id/deshacer', () => {
  it('sin eliminacion → 403 (la vista previa sola no alcanza)', async () => {
    state.profile = VISTA
    expect((await post('/importaciones/13/deshacer', { motivo: 'Archivo equivocado' })).status).toBe(403)
    expect(llamadas()).toHaveLength(0)
  })

  it('sin el flag → 403 aunque tenga eliminacion', async () => {
    state.profile = perfil({ lectura: true, eliminacion: true, tabs: ['facturas'] })
    expect((await post('/importaciones/13/deshacer', { motivo: 'Archivo equivocado' })).status).toBe(403)
  })

  it('motivo corto o ausente → 400 MOTIVO_REQUERIDO sin llamar a la RPC', async () => {
    state.profile = APLICA
    for (const body of [{}, { motivo: '  a  ' }, { motivo: 'x'.repeat(501) }]) {
      const r = await post('/importaciones/13/deshacer', body)
      expect(r.status).toBe(400)
      expect(await r.json()).toMatchObject({ error: 'MOTIVO_REQUERIDO', campo: 'motivo' })
    }
    expect(llamadas()).toHaveLength(0)
  })

  it('aplica con el motivo normalizado', async () => {
    state.profile = APLICA
    const r = await post('/importaciones/13/deshacer', { motivo: '  Archivo   equivocado ' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ aplicado: true, a_anular: 348 })
    expect(llamadas()).toEqual([{ fn: 'pagos_deshacer_importacion', args: { p_importacion_id: 13, p_motivo: 'Archivo equivocado', p_user_id: 'u-1', p_aplicar: true } }])
  })

  it('con movimientos → 409 con los bloqueos en el detalle', async () => {
    state.profile = APLICA
    const bloqueos = [{ factura_id: 723, numero: '00012-00400067', tipo_comprobante: 'A', proveedor: 'ABC S.A.', motivo: 'imputada' }]
    state.error = { message: 'IMPORTACION_CON_MOVIMIENTOS', details: JSON.stringify({ importacion_id: 13, bloqueos }) }
    const r = await post('/importaciones/13/deshacer', { motivo: 'Archivo equivocado' })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'IMPORTACION_CON_MOVIMIENTOS', detail: { bloqueos } })
  })

  it('ya deshecha → 409; motivo rechazado por la base → 400; sin permiso en la base → 403', async () => {
    state.profile = APLICA
    for (const [code, status] of [['IMPORTACION_YA_DESHECHA', 409], ['MOTIVO_REQUERIDO', 400], ['SIN_PERMISO', 403]] as const) {
      state.error = { message: code }
      const r = await post('/importaciones/13/deshacer', { motivo: 'Archivo equivocado' })
      expect(r.status).toBe(status)
      expect(await r.json()).toMatchObject({ error: code })
    }
  })
})
