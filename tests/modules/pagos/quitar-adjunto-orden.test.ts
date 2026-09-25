/**
 * Quitar un adjunto de una orden de pago desde la ficha (20260929x).
 *
 * `DELETE /ordenes/:id/adjuntos/:adjId?motivo=…` es un soft delete:
 *   · pide lectura + registrar_pagos + tab de pagos;
 *   · no deja una OP emitida en transferencia/e-cheq sin su prueba
 *     (409 ADJUNTO_REQUERIDO);
 *   · el motivo queda en el obs del adjunto («Quitado: …»);
 *   · en una OP anulada no hay prueba que cuidar: se puede quitar.
 * Y `GET …/adjuntos?borrados=1` trae los quitados marcados `borrado`.
 *
 * Todo con la base mockeada: no se toca ningún adjunto real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    orden: null as Fila | null,
    adjunto: null as Fila | null,
    /** Cuántos adjuntos vigentes QUEDAN de cada tipo (sin contar el que se quita). */
    quedan: {} as Record<string, number>,
    cheques: 0,
    updates: [] as Fila[],
    listado: [] as Fila[],
    filtros: [] as Array<[string, string, unknown]>,
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

/** Cadena de PostgREST que recuerda los filtros y resuelve según la tabla. */
function chain(tabla: string) {
  const f: Record<string, unknown> = {}
  let head = false
  let update: Fila | null = null
  const obj: any = {}
  for (const m of ['order', 'range', 'limit', 'in', 'not', 'or']) obj[m] = () => obj
  obj.select = (_c?: string, o?: { head?: boolean }) => { head = !!o?.head; return obj }
  obj.eq = (k: string, v: unknown) => { f[k] = v; state.filtros.push([tabla, k, v]); return obj }
  obj.neq = (k: string, v: unknown) => { f[`neq_${k}`] = v; return obj }
  obj.is = (k: string, v: unknown) => { f[`is_${k}`] = v; state.filtros.push([tabla, `is_${k}`, v]); return obj }
  obj.update = (u: Fila) => { update = u; return obj }
  const resolver = () => {
    if (tabla === 'profiles') return { data: state.profile }
    if (tabla === 'pagos_ordenes') return { data: state.orden }
    if (tabla === 'pagos_cheques') return { data: null, count: state.cheques }
    if (tabla === 'pagos_ordenes_adjuntos') {
      if (update) { state.updates.push(update); return { data: state.adjunto ? { id: state.adjunto.id } : null } }
      if (head) return { data: null, count: state.quedan[String(f.tipo)] ?? 0 }
      if (f.id != null) return { data: state.adjunto }
      return { data: state.listado }
    }
    return { data: null }
  }
  obj.maybeSingle = () => Promise.resolve({ ...resolver(), error: null })
  obj.single = obj.maybeSingle
  obj.then = (ok: any, ko: any) => Promise.resolve({ ...resolver(), error: null }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'

const perfil = (p: Fila): Fila => ({ rol: 'operador', activo: true, rol_base: null, permisos: { pagos: p } })
const CONTADOR = perfil({ lectura: true, registrar_pagos: true, tabs: ['facturas', 'pagos'] })
const SOLO_LECTURA = perfil({ lectura: true, tabs: ['facturas', 'pagos'] })
const quitar = (motivo?: string) => pagos.request(
  `/ordenes/20/adjuntos/7${motivo != null ? `?motivo=${encodeURIComponent(motivo)}` : ''}`, { method: 'DELETE' })

beforeEach(() => {
  state.profile = CONTADOR
  state.orden = { estado: 'emitida', forma_pago: 'transferencia', monto_pagado: 1000 }
  state.adjunto = { id: 7, tipo: 'comprobante_pago', obs: '' }
  state.quedan = {}
  state.cheques = 0
  state.updates = []
  state.listado = []
  state.filtros = []
})

describe('DELETE /ordenes/:id/adjuntos/:adjId', () => {
  it('sin registrar_pagos → 403 y no toca nada', async () => {
    state.profile = SOLO_LECTURA
    expect((await quitar('otro archivo')).status).toBe(403)
    expect(state.updates).toEqual([])
  })

  it('transferencia emitida con un solo comprobante → 409 ADJUNTO_REQUERIDO', async () => {
    const r = await quitar('era de otra OP')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'ADJUNTO_REQUERIDO' })
    expect(state.updates).toEqual([])
  })

  it('si queda otro comprobante se quita, y el motivo va al obs', async () => {
    state.quedan = { comprobante_pago: 1 }
    state.adjunto = { id: 7, tipo: 'comprobante_pago', obs: 'Cheque N° 3079' }
    const r = await quitar('  era de otra OP  ')
    expect(r.status).toBe(200)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({ updated_by: 'u-1', obs: 'Cheque N° 3079 · Quitado: era de otra OP' })
    expect(state.updates[0]!.deleted_at).toEqual(expect.any(String))
  })

  it('sin motivo no pisa el obs', async () => {
    state.quedan = { comprobante_pago: 1 }
    expect((await quitar()).status).toBe(200)
    expect(state.updates[0]).not.toHaveProperty('obs')
  })

  it('e-cheq: se puede quitar el archivo de un cheque solo si quedan tantos como cheques', async () => {
    state.orden = { estado: 'emitida', forma_pago: 'echeq', monto_pagado: 1000 }
    state.adjunto = { id: 7, tipo: 'cheque', obs: 'Cheque N° 3079' }
    state.cheques = 2
    state.quedan = { cheque: 1 }
    expect((await quitar('duplicado')).status).toBe(409)
    state.quedan = { cheque: 2 }
    expect((await quitar('duplicado')).status).toBe(200)
  })

  it('OP anulada: no hay prueba que cuidar, se puede quitar', async () => {
    state.orden = { estado: 'anulada', forma_pago: 'transferencia', monto_pagado: 1000 }
    expect((await quitar('equivocado')).status).toBe(200)
  })

  it('un recibo del proveedor se quita siempre (no es la prueba del pago)', async () => {
    state.adjunto = { id: 7, tipo: 'recibo_proveedor', obs: null }
    expect((await quitar('no era el recibo')).status).toBe(200)
    expect(state.updates[0]).toMatchObject({ obs: 'Quitado: no era el recibo' })
  })

  it('el motivo se recorta a 200 caracteres', async () => {
    state.quedan = { comprobante_pago: 1 }
    await quitar('x'.repeat(300))
    expect(String(state.updates[0]!.obs)).toBe(`Quitado: ${'x'.repeat(200)}`)
  })
})

describe('GET /ordenes/:id/adjuntos?borrados=1', () => {
  it('con borrados=1 no filtra deleted_at y marca `borrado`; sin él, solo vigentes', async () => {
    state.listado = [{ id: 1, deleted_at: null }, { id: 2, deleted_at: '2026-09-25T10:00:00Z' }]
    const r = await pagos.request('/ordenes/20/adjuntos?borrados=1')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([{ id: 1, deleted_at: null, borrado: false }, { id: 2, deleted_at: '2026-09-25T10:00:00Z', borrado: true }])
    expect(state.filtros.some(([t, k]) => t === 'pagos_ordenes_adjuntos' && k === 'is_deleted_at')).toBe(false)
    state.filtros = []
    await pagos.request('/ordenes/20/adjuntos')
    expect(state.filtros.some(([t, k]) => t === 'pagos_ordenes_adjuntos' && k === 'is_deleted_at')).toBe(true)
  })
})
