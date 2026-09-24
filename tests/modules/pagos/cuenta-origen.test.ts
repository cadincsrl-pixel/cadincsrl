/**
 * «Sale de la cuenta» (20260926g): de qué cuenta propia (`tesoreria_cuentas`)
 * salió la plata de una OP.
 *
 *   - GET /cuentas-origen: activas, bancos primero, después caja y valores.
 *   - PATCH /ordenes/:id acepta `cuenta_origen_id`: tiene que existir y estar
 *     activa (400 CUENTA_ORIGEN_INVALIDA) y la OP no puede estar anulada (409).
 *     `null` la borra sin validar nada más.
 *   - Los schemas del alta (OP y factura ya pagada) la aceptan opcional.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, state, llamadas } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  llamadas: [] as { tabla: string; metodo: string; args: unknown[] }[],
  state: {
    profile: null as Fila | null,
    orden: { id: 5, estado: 'emitida' } as Fila | null,
    tesoreria: [] as Fila[],
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

function chain(tabla: string, data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'order', 'range', 'limit', 'update', 'insert', 'delete']) {
    obj[m] = (...args: unknown[]) => { llamadas.push({ tabla, metodo: m, args }); return obj }
  }
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: (n: string, a: unknown) => rpcMock(n, a) })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { CreateOrdenSchema, OrdenAlCargarSchema, UpdateOrdenSchema } from '../../../src/modules/pagos/pagos.schema.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const patch = (path: string, body: unknown) => pagos.request(path, { method: 'PATCH', ...json(body) })

const CONTADOR = { rol: 'operador', activo: true, rol_base: null, permisos: { pagos: { lectura: true, registrar_pagos: true, tabs: ['pagos'] } } }
const SOLO_PROV = { rol: 'operador', activo: true, rol_base: null, permisos: { pagos: { lectura: true, tabs: ['proveedores'] } } }

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  llamadas.length = 0
  state.profile = CONTADOR
  state.orden = { id: 5, estado: 'emitida' }
  state.tesoreria = [
    { id: 3, tipo: 'caja', nombre: 'Caja en pesos', banco: '', moneda: 'ARS', activo: true },
    { id: 1, tipo: 'banco', nombre: 'Galicia', banco: 'Galicia', moneda: 'ARS', activo: true },
    { id: 4, tipo: 'valores', nombre: 'Cartera', banco: '', moneda: 'ARS', activo: true },
  ]
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(t, state.profile)
    if (t === 'pagos_ordenes') return chain(t, state.orden)
    if (t === 'tesoreria_cuentas') return chain(t, state.tesoreria)
    return chain(t, [])
  })
})

const updates = () => llamadas.filter((l) => l.tabla === 'pagos_ordenes' && l.metodo === 'update').map((l) => l.args[0] as Fila)

describe('GET /cuentas-origen', () => {
  it('bancos, caja y valores en ese orden', async () => {
    const r = await pagos.request('/cuentas-origen')
    expect(r.status).toBe(200)
    expect((await r.json() as Fila[]).map((c) => c.tipo)).toEqual(['banco', 'caja', 'valores'])
  })

  it('pide la tab de pagos', async () => {
    state.profile = SOLO_PROV
    expect((await pagos.request('/cuentas-origen')).status).toBe(403)
  })
})

describe('PATCH /ordenes/:id con cuenta_origen_id', () => {
  it('cuenta activa → se guarda', async () => {
    state.tesoreria = [{ id: 1, activo: true }]
    expect((await patch('/ordenes/5', { cuenta_origen_id: 1 })).status).toBe(200)
    expect(updates()[0]).toMatchObject({ cuenta_origen_id: 1, updated_by: 'u-1' })
  })

  it('cuenta inexistente o dada de baja → 400 CUENTA_ORIGEN_INVALIDA', async () => {
    state.tesoreria = [{ id: 1, activo: false }]
    const r = await patch('/ordenes/5', { cuenta_origen_id: 1 })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'CUENTA_ORIGEN_INVALIDA' })
    expect(updates()).toHaveLength(0)
  })

  it('OP anulada → 409 ORDEN_ANULADA', async () => {
    state.orden = { id: 5, estado: 'anulada' }
    const r = await patch('/ordenes/5', { cuenta_origen_id: 1 })
    expect(r.status).toBe(409)
    expect((await r.json() as Fila).error).toBe('ORDEN_ANULADA')
  })

  it('null la borra', async () => {
    expect((await patch('/ordenes/5', { cuenta_origen_id: null })).status).toBe(200)
    expect(updates()[0]).toMatchObject({ cuenta_origen_id: null })
    expect(llamadas.some((l) => l.tabla === 'tesoreria_cuentas')).toBe(false)
  })

  it('obs sola no toca la cuenta', async () => {
    expect((await patch('/ordenes/5', { obs: 'x' })).status).toBe(200)
    expect(updates()[0]).not.toHaveProperty('cuenta_origen_id')
  })
})

describe('schemas', () => {
  it('opcional y nullable en los tres', () => {
    const linea = { tipo: 'factura', factura_id: 1, monto: 10 }
    const op = { proveedor_id: 1, fecha: '2026-09-01', forma_pago: 'transferencia', lineas: [linea] }
    expect(CreateOrdenSchema.parse({ ...op, cuenta_origen_id: 3 }).cuenta_origen_id).toBe(3)
    expect(CreateOrdenSchema.parse(op).cuenta_origen_id).toBeUndefined()
    expect(OrdenAlCargarSchema.parse({ fecha: '2026-09-01', forma_pago: 'efectivo', cuenta_origen_id: null }).cuenta_origen_id).toBeNull()
    expect(UpdateOrdenSchema.parse({ cuenta_origen_id: 2 })).toEqual({ cuenta_origen_id: 2 })
    expect(UpdateOrdenSchema.safeParse({ cuenta_origen_id: 0 }).success).toBe(false)
  })
})
