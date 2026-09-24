/**
 * Concepto de la factura y lista de conceptos de compra (20260925i–n).
 *
 *   - El alta exige `concepto_id` (400 CONCEPTO_REQUERIDO, antes de la RPC) y
 *     lo manda en `p_factura`.
 *   - El concepto se edita SIEMPRE: en una pagada pasa (no es congelado) y no
 *     retira la aprobación. No se puede dejar en null.
 *   - Filtro `concepto_id` en el listado; el resumen no lo acepta.
 *   - `GET/POST/PATCH /conceptos`: lectura + cualquier tab para leer,
 *     `actualizacion` para escribir, sin DELETE, nunca el último activo, y el
 *     nombre repetido es 409 CONCEPTO_DUPLICADO.
 *   - Lectura IA: el concepto sugerido sólo vale si es uno de los ofrecidos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, state, llamadas } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  llamadas: [] as { tabla: string; metodo: string; args: unknown[] }[],
  state: {
    userId: 'u-1',
    profile: null as Record<string, unknown> | null,
    facturas: [] as Record<string, unknown>[],
    conceptos: [] as Record<string, unknown>[],
    otrosActivos: 1,
    errorEscritura: null as { code: string; message: string } | null,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: state.userId, email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

/** Cadena de PostgREST que anota cada llamada (tabla, método, argumentos). */
function chain(tabla: string, data: unknown, extra: { count?: number | null; error?: unknown } = {}) {
  const obj: any = {}
  let escribe = false
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'contains', 'order', 'range', 'limit', 'update', 'insert', 'delete']) {
    obj[m] = (...args: unknown[]) => {
      llamadas.push({ tabla, metodo: m, args })
      if (m === 'insert' || m === 'update') escribe = true
      return obj
    }
  }
  const error = () => (escribe && state.errorEscritura) ? state.errorEscritura : (extra.error ?? null)
  const uno = () => Promise.resolve({ data: error() ? null : (Array.isArray(data) ? (data[0] ?? null) : data), error: error() })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: error(), count: extra.count ?? (Array.isArray(data) ? data.length : null) }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: (n: string, a: unknown) => rpcMock(n, a), storage: { from: () => ({ remove: async () => ({}), move: async () => ({}) }) } })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { hoyAR } from '../../../src/modules/pagos/pagos.util.js'
import { FacturasResumenQuerySchema, UpdateFacturaSchema } from '../../../src/modules/pagos/pagos.schema.js'
import { conceptoSugerido, camposEditados } from '../../../src/modules/pagos/lectura.service.js'
import { instruccionConcepto, LecturaIASchema, type LecturaIA } from '../../../src/modules/pagos/lectura/ia.js'
import { parseRoute } from '../../../src/middleware/audit.js'

vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const get = (path: string) => pagos.request(path)
const post = (path: string, body: unknown = {}) => pagos.request(path, { method: 'POST', ...json(body) })
const patch = (path: string, body: unknown = {}) => pagos.request(path, { method: 'PATCH', ...json(body) })
const del = (path: string) => pagos.request(path, { method: 'DELETE' })

const HOY = hoyAR()
const perfil = (permisosPagos: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: permisosPagos ? { pagos: permisosPagos } : {} })
const COMPRAS   = perfil({ lectura: true, creacion: true, actualizacion: true, ver_pii: true, tabs: ['facturas', 'proveedores'] })
const CONTADOR  = perfil({ lectura: true, registrar_pagos: true, ver_pii: true, tabs: ['pagos'] })
const SOLO_PROV = perfil({ lectura: true, actualizacion: true, tabs: ['proveedores'] })
const SIN_LECTURA = perfil({ lectura: false, tabs: ['facturas'] })

const FACTURA = {
  proveedor_id: 1, tipo_comprobante: 'A', numero: '0001-00000007', fecha: HOY, total: 1000, descripcion: 'Gasoil',
  concepto_id: 1, imputaciones: [{ obra_cod: 'CC 1', monto: 1000 }],
}
const CONCEPTOS = [
  { id: 1, nombre: 'Combustible', orden: 1, activo: true },
  { id: 2, nombre: 'Materiales de obra', orden: 2, activo: true },
]

const rpc = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as Fila | undefined
const de = (tabla: string, metodo: string) => llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo).map((l) => l.args)

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  llamadas.length = 0
  state.userId = 'u-1'
  state.profile = COMPRAS
  state.facturas = []
  state.conceptos = CONCEPTOS
  state.otrosActivos = 1
  state.errorEscritura = null
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(t, state.profile)
    if (t === 'pagos_facturas' || t === 'v_pagos_facturas') return chain(t, state.facturas)
    if (t === 'pagos_conceptos') return chain(t, state.conceptos, { count: state.otrosActivos })
    return chain(t, [])
  })
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'pagos_crear_factura') return { data: { factura: { id: 10, estado: 'pendiente' }, orden: null }, error: null }
    if (name === 'pagos_editar_factura') return { data: { factura: { id: 5, estado: 'pagada' } }, error: null }
    return { data: null, error: null }
  })
})

// ── Concepto en la factura ──────────────────────────────────────────────────

describe('concepto en el alta', () => {
  it('sin concepto_id: 400 con CONCEPTO_REQUERIDO en el campo, y nada llega a la RPC', async () => {
    const { concepto_id: _, ...sinConcepto } = FACTURA
    const res = await post('/facturas', sinConcepto)
    expect(res.status).toBe(400)
    // El zValidator devuelve el ZodError con los issues serializados en
    // `message` (es lo que parsea `pagos.errores.ts` del frontend).
    const body = await res.json() as { error: { message: string } }
    expect(JSON.parse(body.error.message)).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['concepto_id'], message: 'CONCEPTO_REQUERIDO' })]))
    expect(rpc('pagos_crear_factura')).toBeUndefined()
  })

  it('concepto_id null, 0 o texto también es 400', async () => {
    for (const concepto_id of [null, 0, 'combustible', 1.5]) {
      expect((await post('/facturas', { ...FACTURA, concepto_id })).status).toBe(400)
    }
    expect(rpc('pagos_crear_factura')).toBeUndefined()
  })

  it('con concepto: viaja en p_factura (la RPC valida que exista y esté activo)', async () => {
    const res = await post('/facturas', FACTURA)
    expect(res.status).toBe(200)
    expect((rpc('pagos_crear_factura')!.p_factura as Fila).concepto_id).toBe(1)
  })

  it('CONCEPTO_INVALIDO de la RPC sale 400 con el campo', async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'CONCEPTO_INVALIDO', details: '{"campo":"concepto_id","concepto_id":99}' } }))
    const res = await post('/facturas', { ...FACTURA, concepto_id: 99 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'CONCEPTO_INVALIDO', campo: 'concepto_id', detail: { campo: 'concepto_id', concepto_id: 99 } })
  })
})

describe('concepto en la edición', () => {
  it('en una PAGADA el concepto pasa (no es congelado) y no retira la aprobación', async () => {
    state.facturas = [{ id: 5, estado: 'pagada', clase: 'factura', proveedor_id: 1, fecha: HOY, total: 1000, percepciones: null, neto: null, iva: null, otros: null, vence_el: null, aprobada_at: '2026-09-20' }]
    const res = await patch('/facturas/5', { concepto_id: 3 })
    expect(res.status).toBe(200)
    expect(rpc('pagos_editar_factura')).toEqual({ p_factura_id: 5, p_cambios: { concepto_id: 3 }, p_imputaciones: null, p_motivo: null, p_user_id: 'u-1' })
    expect((await res.json()).avisos).toEqual([])
  })

  it('no se puede vaciar: concepto_id null es 400 del schema', async () => {
    expect(UpdateFacturaSchema.safeParse({ concepto_id: null }).success).toBe(false)
    expect((await patch('/facturas/5', { concepto_id: null })).status).toBe(400)
    expect(rpc('pagos_editar_factura')).toBeUndefined()
  })
})

describe('filtro por concepto', () => {
  it('GET /facturas?concepto_id=2 filtra la vista por concepto_id', async () => {
    const res = await get('/facturas?concepto_id=2')
    expect(res.status).toBe(200)
    expect(de('v_pagos_facturas', 'eq')).toContainEqual(['concepto_id', 2])
  })

  it('el export respeta el mismo filtro', async () => {
    expect((await get('/facturas/export?concepto_id=2')).status).toBe(200)
    expect(de('v_pagos_facturas', 'eq')).toContainEqual(['concepto_id', 2])
  })

  it('el resumen agrupa por concepto pero no lo filtra (pagos_resumen no tiene el filtro)', () => {
    const r = FacturasResumenQuerySchema.parse({ grupo: 'concepto', concepto_id: '2' })
    expect(r.grupo).toBe('concepto')
    expect('concepto_id' in r).toBe(false)
  })
})

// ── Lista de conceptos ──────────────────────────────────────────────────────

describe('GET /conceptos', () => {
  it('con lectura y cualquier tab de pagos; por defecto sólo los activos', async () => {
    for (const p of [COMPRAS, CONTADOR, SOLO_PROV]) {
      state.profile = p
      llamadas.length = 0
      const res = await get('/conceptos')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(CONCEPTOS)
      expect(de('pagos_conceptos', 'eq')).toContainEqual(['activo', true])
    }
  })

  it('?incluir_inactivos=1 no filtra por activo', async () => {
    await get('/conceptos?incluir_inactivos=1')
    expect(de('pagos_conceptos', 'eq')).not.toContainEqual(['activo', true])
  })

  it('sin lectura: 403', async () => {
    state.profile = SIN_LECTURA
    expect((await get('/conceptos')).status).toBe(403)
  })
})

describe('POST / PATCH /conceptos', () => {
  it('sin pagos.actualizacion: 403 (el contador lee pero no edita la lista)', async () => {
    state.profile = CONTADOR
    expect((await post('/conceptos', { nombre: 'Viáticos' })).status).toBe(403)
    expect((await patch('/conceptos/1', { nombre: 'Nafta' })).status).toBe(403)
    expect(de('pagos_conceptos', 'insert')).toEqual([])
    expect(de('pagos_conceptos', 'update')).toEqual([])
  })

  it('alta: manda nombre, orden y quién; sin nombre_norm (lo arma el trigger)', async () => {
    const res = await post('/conceptos', { nombre: 'Viáticos', orden: 13 })
    expect(res.status).toBe(200)
    expect(de('pagos_conceptos', 'insert')).toEqual([[{ nombre: 'Viáticos', orden: 13, activo: true, created_by: 'u-1', updated_by: 'u-1' }]])
  })

  it('claves extra (nombre_norm, id) son 400 por el .strict()', async () => {
    expect((await post('/conceptos', { nombre: 'Viáticos', nombre_norm: 'viaticos' })).status).toBe(400)
    expect((await patch('/conceptos/1', { id: 9 })).status).toBe(400)
    expect((await patch('/conceptos/1', {})).status).toBe(400)
  })

  it('nombre repetido (unique_violation) → 409 CONCEPTO_DUPLICADO', async () => {
    state.errorEscritura = { code: '23505', message: 'duplicate key value violates unique constraint "pagos_conceptos_nombre_norm_key"' }
    const res = await post('/conceptos', { nombre: 'combustible' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'CONCEPTO_DUPLICADO', campo: 'nombre' })
    const res2 = await patch('/conceptos/2', { nombre: 'Combustible' })
    expect(res2.status).toBe(409)
  })

  it('renombrar, reordenar y dar de baja van en un solo update', async () => {
    const res = await patch('/conceptos/2', { nombre: 'Materiales', orden: 5, activo: false })
    expect(res.status).toBe(200)
    expect(de('pagos_conceptos', 'update')).toEqual([[{ updated_by: 'u-1', nombre: 'Materiales', orden: 5, activo: false }]])
  })

  it('no se da de baja el último activo: 409 CONCEPTO_ULTIMO_ACTIVO, sin update', async () => {
    state.otrosActivos = 0
    const res = await patch('/conceptos/1', { activo: false })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'CONCEPTO_ULTIMO_ACTIVO', campo: 'activo' })
    expect(de('pagos_conceptos', 'update')).toEqual([])
  })

  it('un concepto que no existe es 404', async () => {
    state.conceptos = []
    expect((await patch('/conceptos/77', { nombre: 'Otro nombre' })).status).toBe(404)
  })

  it('no hay DELETE', async () => {
    expect((await del('/conceptos/1')).status).toBe(404)
  })

  it('auditoría: queda como «concepto de compra»', () => {
    expect(parseRoute('/api/pagos/conceptos', 'POST')).toEqual({ modulo: 'pagos', entidad: 'concepto de compra', accion: 'crear' })
    expect(parseRoute('/api/pagos/conceptos/4', 'PATCH')).toEqual({ modulo: 'pagos', entidad: 'concepto de compra', accion: 'actualizar', entidadId: '4' })
  })
})

// ── Lectura IA ──────────────────────────────────────────────────────────────

describe('concepto sugerido por la lectura', () => {
  const lectura = (concepto_id: number | null) => ({ ok: true as const, modelo: 'm', lectura: { concepto_id } as LecturaIA })

  it('sólo vale un id de los ofrecidos; si no, null', () => {
    const ofrecidos = [{ id: 1, nombre: 'Combustible' }, { id: 2, nombre: 'Materiales de obra' }]
    expect(conceptoSugerido(lectura(1), ofrecidos)).toEqual({ id: 1, nombre: 'Combustible' })
    expect(conceptoSugerido(lectura(99), ofrecidos)).toBeNull()
    expect(conceptoSugerido(lectura(null), ofrecidos)).toBeNull()
    expect(conceptoSugerido({ ok: false, motivo: 'SIN_API_KEY', modelo: null }, ofrecidos)).toBeNull()
  })

  it('el prompt lista los conceptos por id; sin lista pide null', () => {
    const txt = instruccionConcepto([{ id: 1, nombre: 'Combustible' }, { id: 7, nombre: 'Servicios' }])
    expect(txt).toContain('1 = Combustible')
    expect(txt).toContain('7 = Servicios')
    expect(instruccionConcepto([])).toContain('concepto_id: null')
  })

  it('las claves del structured output son ASCII (una ñ rompe la llamada)', () => {
    const claves = Object.keys(LecturaIASchema.shape)
    expect(claves).toContain('concepto_id')
    for (const k of claves) expect(k).toMatch(/^[a-z_]+$/)
  })

  it('camposEditados marca concepto_id si la persona cambió el sugerido', () => {
    const p = { concepto_id_sugerido: 1, iva: [], tributos: [] } as never
    const base = { numero: '', fecha: '', total: 0, tipo_comprobante: 'A' }
    expect(camposEditados(p, { ...base, concepto_id: 2 })).toContain('concepto_id')
    expect(camposEditados(p, { ...base, concepto_id: 1 })).not.toContain('concepto_id')
  })
})
