/**
 * Guardias del módulo Pagos, por ruta (patrón de tests/modules/solicitudes/editar-pedidos.test.ts).
 *
 * Lo que se verifica acá es la DECISIÓN: quién pasa y quién rebota, con la
 * base mockeada. Las RPC se mockean y se inspeccionan sus argumentos.
 *
 *   - Guardias por ruta, no por verbo global: el contador (lectura +
 *     registrar_pagos, sin creacion) paga pero no carga; el aprobador (lectura
 *     + aprobar_facturas) aprueba pero no paga.
 *   - Tres separaciones de funciones, admin exento (decisiones 1 y 2).
 *   - «Ya está pagada» sin tope: compras solo tarjeta/efectivo, admin cualquier forma (decisión 3).
 *   - La NC es un comprobante (20260925a): no es línea de OP, no se paga, se
 *     aplica con /facturas/:id/aplicar-nc (aprobar_facturas O registrar_pagos).
 *   - Anular OP: propia del día con registrar_pagos; anular_pagos cualquiera (decisión 12).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  state: {
    userId: 'u-1',
    profile: null as Fila | null,
    facturas: [] as Fila[],
    ordenes: [] as Fila[],
    imputaciones: [] as Fila[],
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: state.userId, email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

/** Cadena de PostgREST mockeada: cualquier método devuelve la cadena; single/maybeSingle y await resuelven. */
function chain(data: unknown) {
  const obj: any = {}
  const self = () => obj
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'contains', 'order', 'range', 'limit', 'update', 'insert', 'delete']) obj[m] = self
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: (n: string, a: unknown) => rpcMock(n, a), storage: { from: () => ({ remove: async () => ({}), move: async () => ({}) }) } })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { hoyAR } from '../../../src/modules/pagos/pagos.util.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => pagos.request(path, { method: 'POST', ...json(body) })
const patch = (path: string, body: unknown = {}) => pagos.request(path, { method: 'PATCH', ...json(body) })

// El MISMO «hoy» que usa el código, que es el de Argentina y no el de UTC.
//
// Con `new Date().toISOString()` estos 17 tests se ponían en rojo todas las
// noches entre las 21:00 y las 00:00 hora argentina, y volvían solos a verde:
// a esa hora en UTC ya es mañana, así que `fecha: HOY` le llegaba al service
// como una fecha futura y `registrarOrden` la rechazaba con FECHA_FUTURA (400)
// antes de tocar la RPC. Verde 21 horas por día, rojo 3, y el código sano.
const HOY = hoyAR()

const perfil = (permisosPagos: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: permisosPagos ? { pagos: permisosPagos } : {} })
const ADMIN     = perfil(null, 'admin')
const COMPRAS   = perfil({ lectura: true, creacion: true, actualizacion: true, ver_pii: true, tabs: ['facturas', 'proveedores'] })
const APROBADOR = perfil({ lectura: true, aprobar_facturas: true, tabs: ['facturas'] })
const DIEGO     = perfil({ lectura: true, creacion: true, actualizacion: true, aprobar_facturas: true, ver_pii: true })
/** Carga Y registra pagos: el único (con el admin) que puede marcar «ya está pagada» desde 2026-09-23. */
const CARGA_Y_PAGA = perfil({ lectura: true, creacion: true, registrar_pagos: true, ver_pii: true, tabs: ['facturas', 'pagos', 'proveedores'] })
const CONTADOR  = perfil({ lectura: true, registrar_pagos: true, anular_pagos: true, ver_pii: true, tabs: ['facturas', 'pagos', 'proveedores'] })
const CONTADOR_SIN_ANULAR = perfil({ lectura: true, registrar_pagos: true, ver_pii: true, tabs: ['facturas', 'pagos', 'proveedores'] })

const FACTURA_BASE = {
  proveedor_id: 1, tipo_comprobante: 'A', numero: '0001-00000007', fecha: HOY, total: 1_000_000, descripcion: 'Hierro 8 mm',
  concepto_id: 2, imputaciones: [{ obra_cod: 'CC 1', monto: 1_000_000 }],
}

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  state.userId = 'u-1'
  state.profile = null
  state.facturas = []
  state.ordenes = []
  state.imputaciones = []
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile)
    if (t === 'pagos_facturas' || t === 'v_pagos_facturas') return chain(state.facturas)
    if (t === 'pagos_ordenes' || t === 'v_pagos_ordenes') return chain(state.ordenes)
    if (t === 'pagos_imputaciones') return chain(state.imputaciones)
    return chain([])
  })
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'pagos_crear_factura') return { data: { factura: { id: 10, estado: 'pendiente' }, orden: null }, error: null }
    if (name === 'pagos_registrar_orden') return { data: { orden: { id: 20, numero: 1 }, facturas: [] }, error: null }
    if (name === 'pagos_aprobar_factura') return { data: { id: 5, estado: 'aprobada' }, error: null }
    if (name === 'pagos_anular_orden') return { data: { id: 20, estado: 'anulada' }, error: null }
    if (name === 'pagos_observar_factura') return { data: { id: 5, estado: 'observada' }, error: null }
    if (name === 'pagos_editar_factura') return { data: { factura: { id: 5, estado: 'pendiente' }, aprobacion_retirada: true }, error: null }
    return { data: null, error: null }
  })
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as Fila | undefined

// ── Guardias por ruta ───────────────────────────────────────────────────────

describe('guardias por ruta (no por verbo global)', () => {
  it('el contador (sin creacion) no carga facturas pero sí registra pagos', async () => {
    state.profile = CONTADOR
    expect((await post('/facturas', FACTURA_BASE)).status).toBe(403)
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 100 }] })
    expect(res.status).toBe(200)
    expect(llamada('pagos_registrar_orden')).toBeTruthy()
  })

  it('el aprobador (solo aprobar_facturas) aprueba pero no paga ni carga', async () => {
    state.profile = APROBADOR
    state.facturas = [{ id: 5, created_by: 'otro', estado: 'pendiente' }]
    expect((await post('/facturas/5/aprobar')).status).toBe(200)
    const pago = await post('/ordenes', { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 100 }] })
    expect(pago.status).toBe(403)
    expect(await pago.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'registrar_pagos' } })
    expect((await post('/facturas', FACTURA_BASE)).status).toBe(403)
  })

  it('compras no aprueba (sin el flag) aunque tenga creacion y actualizacion', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, created_by: 'otro', estado: 'pendiente' }]
    const res = await post('/facturas/5/aprobar')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'aprobar_facturas' } })
  })

  it('un contador con tabs [pagos] recibe SIN_TAB al cargar una factura pero no al observar desde la ficha', async () => {
    state.profile = perfil({ lectura: true, creacion: true, registrar_pagos: true, tabs: ['pagos'] })
    state.facturas = [{ id: 5, created_by: 'otro', estado: 'aprobada' }]
    const carga = await post('/facturas', FACTURA_BASE)
    expect(carga.status).toBe(403)
    expect((await carga.json()).error).toBe('SIN_TAB')
    expect((await post('/facturas/5/observar', { motivo: 'mal cargada' })).status).toBe(200)
  })

  it('observar exige registrar_pagos o aprobar_facturas (o admin), no alcanza con lectura', async () => {
    state.profile = perfil({ lectura: true })
    state.facturas = [{ id: 5, estado: 'aprobada' }]
    const res = await post('/facturas/5/observar', { motivo: 'mal cargada' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('SIN_PERMISO')
    state.profile = APROBADOR
    expect((await post('/facturas/5/observar', { motivo: 'mal cargada' })).status).toBe(200)
  })

  it('datos-pago exige registrar_pagos + ver_pii', async () => {
    state.profile = perfil({ lectura: true, registrar_pagos: true, ver_pii: false })
    const res = await patch('/proveedores/1/datos-pago', { banco: 'Galicia' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'ver_pii' } })
  })
})

// ── Separación de funciones ────────────────────────────────────────────────

describe('separación de funciones', () => {
  it('no aprobás lo que cargaste: Diego carga y aprueba, pero no la suya (NO_PUEDE_APROBAR_PROPIA)', async () => {
    state.profile = DIEGO
    state.facturas = [{ id: 5, created_by: 'u-1', estado: 'pendiente' }]
    const res = await post('/facturas/5/aprobar')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'NO_PUEDE_APROBAR_PROPIA', detail: { factura_id: 5 } })
    expect(llamada('pagos_aprobar_factura')).toBeUndefined()
  })

  it('«Aprobar N» va a la RPC de lote con los ids únicos y ordenados; las omitidas vuelven tal cual', async () => {
    state.profile = DIEGO
    rpcMock.mockImplementation(async (name: string) => name === 'pagos_aprobar_facturas'
      ? { data: { aprobadas: [6, 7], omitidas: [{ id: 5, code: 'NO_PUEDE_APROBAR_PROPIA', detail: { factura_id: 5 } }] }, error: null }
      : { data: null, error: null })
    const res = await post('/facturas/aprobar', { ids: [7, 5, 6, 7] })
    expect(res.status).toBe(200)
    expect(llamada('pagos_aprobar_facturas')).toEqual({ p_ids: [5, 6, 7], p_user_id: 'u-1' })
    const body = await res.json()
    expect(body.aprobadas).toEqual([6, 7])
    expect(body.omitidas).toEqual([{ id: 5, code: 'NO_PUEDE_APROBAR_PROPIA', detail: { factura_id: 5 } }])
  })

  it('el admin aprueba lo suyo (bypass, decisión 2)', async () => {
    state.profile = ADMIN
    state.facturas = [{ id: 5, created_by: 'u-1', estado: 'pendiente' }]
    expect((await post('/facturas/5/aprobar')).status).toBe(200)
    expect(llamada('pagos_aprobar_factura')).toEqual({ p_factura_id: 5, p_user_id: 'u-1' })
  })

  it('no pagás lo que cargaste ni lo que aprobaste; admin exento', async () => {
    const body = { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 100 }] }
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'u-1', aprobada_por: 'diego', proveedor_id: 1 }]
    let res = await post('/ordenes', body)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'NO_PUEDE_PAGAR_PROPIA', detail: { factura_id: 5 } })

    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'u-1', proveedor_id: 1 }]
    res = await post('/ordenes', body)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'NO_PUEDE_PAGAR_LO_QUE_APROBO', detail: { factura_id: 5 } })
    expect(llamada('pagos_registrar_orden')).toBeUndefined()

    state.profile = ADMIN
    state.facturas = [{ id: 5, created_by: 'u-1', aprobada_por: 'u-1', proveedor_id: 1 }]
    res = await post('/ordenes', body)
    expect(res.status).toBe(200)
    expect(llamada('pagos_registrar_orden')).toBeTruthy()
  })

  it('una factura de otro proveedor en la OP rebota FACTURA_OTRO_PROVEEDOR antes de la RPC', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 2 }]
    const res = await post('/ordenes', { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 100 }] })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('FACTURA_OTRO_PROVEEDOR')
  })
})

// ── «Ya está pagada» al cargar: sólo con registrar_pagos (2026-09-23) ───────

describe('«ya está pagada» al cargar', () => {
  it('compras sin registrar_pagos rebota PAGADA_AL_CARGAR_SIN_PERMISO, aunque sea efectivo', async () => {
    state.profile = COMPRAS
    const res = await post('/facturas', { ...FACTURA_BASE, orden: { fecha: HOY, forma_pago: 'efectivo' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'PAGADA_AL_CARGAR_SIN_PERMISO', detail: { flag: 'registrar_pagos' } })
    expect(llamada('pagos_crear_factura')).toBeUndefined()
  })

  it('compras SIN «ya está pagada» sigue cargando facturas', async () => {
    state.profile = COMPRAS
    expect((await post('/facturas', FACTURA_BASE)).status).toBe(200)
  })

  it('con registrar_pagos: tarjeta por $1.000.000 pasa (sin tope) y la factura nace sin vencimiento', async () => {
    state.profile = CARGA_Y_PAGA
    const res = await post('/facturas', { ...FACTURA_BASE, vence_el: HOY, orden: { fecha: HOY, forma_pago: 'tarjeta', referencia: 'visa' } })
    expect(res.status).toBe(200)
    const args = llamada('pagos_crear_factura')!
    expect((args.p_factura as Fila).vence_el).toBeNull()
    expect((args.p_factura as Fila).numero_norm).toBe('1-7')
    expect((args.p_orden as Fila).monto_pagado).toBe(1_000_000)
    expect((args.p_orden as Fila).monto_nc).toBe(0)
    expect(args.p_user_id).toBe('u-1')
  })

  it('con registrar_pagos o admin, cualquier forma (ya no hay lista de formas)', async () => {
    const orden = {
      fecha: HOY, forma_pago: 'cheque', fecha_cobro: HOY,
      cheques: [{ numero: '00012345', banco: 'Macro', fecha_cobro: HOY, monto: 1_000_000 }],
    }
    state.profile = CARGA_Y_PAGA
    expect((await post('/facturas', { ...FACTURA_BASE, orden })).status).toBe(200)
    state.profile = ADMIN
    expect((await post('/facturas', { ...FACTURA_BASE, orden })).status).toBe(200)
  })

  it('transferencia sin comprobante rebota COMPROBANTE_REQUERIDO (admin incluido)', async () => {
    state.profile = ADMIN
    const res = await post('/facturas', { ...FACTURA_BASE, orden: { fecha: HOY, forma_pago: 'transferencia' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('COMPROBANTE_REQUERIDO')
  })

  it('«la paga el cliente» no se combina con «ya está pagada»', async () => {
    state.profile = CARGA_Y_PAGA
    const res = await post('/facturas', { ...FACTURA_BASE, paga_cliente: true, orden: { fecha: HOY, forma_pago: 'efectivo' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'FACTURA_PAGA_CLIENTE', campo: 'orden' })
  })
})

// ── Validaciones de importes ───────────────────────────────────────────────

describe('importes y fechas de la factura', () => {
  it('fecha futura, vencimiento anterior, desglose que no cuadra e imputaciones que no cuadran', async () => {
    state.profile = COMPRAS
    let res = await post('/facturas', { ...FACTURA_BASE, fecha: '2999-01-01' })
    expect(await res.json()).toMatchObject({ error: 'FECHA_FUTURA', campo: 'fecha' })
    res = await post('/facturas', { ...FACTURA_BASE, vence_el: '2020-01-01' })
    expect(await res.json()).toMatchObject({ error: 'VENCIMIENTO_INVALIDO', campo: 'vence_el' })
    res = await post('/facturas', { ...FACTURA_BASE, neto: 100, iva: 21 })
    expect(await res.json()).toMatchObject({ error: 'DESGLOSE_NO_CUADRA', campo: 'total' })
    res = await post('/facturas', { ...FACTURA_BASE, imputaciones: [{ obra_cod: 'CC 1', monto: 10 }] })
    expect(await res.json()).toMatchObject({ error: 'IMPUTACION_NO_CUADRA', campo: 'imputaciones', detail: { suma: 10, imputable: 1_000_000 } })
  })

  it('las percepciones salen de lo imputable; el desglose solo se exige con neto e iva', async () => {
    state.profile = COMPRAS
    const res = await post('/facturas', { ...FACTURA_BASE, percepciones: 1000, imputaciones: [{ obra_cod: 'CC 1', monto: 999_000 }] })
    expect(res.status).toBe(200)
  })

  it('PATCH sobre pagada: tocar total es FACTURA_CON_PAGOS; reimputar sin motivo es MOTIVO_REQUERIDO; número sí se edita', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pagada', proveedor_id: 1, fecha: HOY, total: 100, percepciones: null, neto: null, iva: null, otros: null, vence_el: null }]
    state.imputaciones = [{ obra_cod: 'CC 1', monto: 100 }]
    let res = await patch('/facturas/5', { total: 200 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'FACTURA_CON_PAGOS', detail: { campos: ['total'] } })
    res = await patch('/facturas/5', { imputaciones: [{ obra_cod: 'CC 2', monto: 100 }] })
    expect(await res.json()).toMatchObject({ error: 'MOTIVO_REQUERIDO', campo: 'motivo' })
    res = await patch('/facturas/5', { numero: '0001-00000008' })
    expect(res.status).toBe(200)
    expect((llamada('pagos_editar_factura')!.p_cambios as Fila)).toEqual({ numero: '0001-00000008', numero_norm: '1-8' })
  })

  it('PATCH de total sobre aprobada con UNA imputación no exige reparto (la RPC lo ajusta) y avisa APROBACION_RETIRADA', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'aprobada', proveedor_id: 1, fecha: HOY, total: 100, percepciones: null, neto: null, iva: null, otros: null, vence_el: null }]
    state.imputaciones = [{ obra_cod: 'CC 1', monto: 100 }]
    const res = await patch('/facturas/5', { total: 200 })
    expect(res.status).toBe(200)
    expect(llamada('pagos_editar_factura')).toEqual({ p_factura_id: 5, p_cambios: { total: 200 }, p_imputaciones: null, p_motivo: null, p_user_id: 'u-1' })
    expect((await res.json()).avisos).toEqual([{ code: 'APROBACION_RETIRADA', factura_ids: [5] }])

    // Con DOS obras y sin reparto nuevo: IMPUTACION_NO_CUADRA antes de la RPC.
    rpcMock.mockClear()
    state.imputaciones = [{ obra_cod: 'CC 1', monto: 60 }, { obra_cod: 'CC 2', monto: 40 }]
    const res2 = await patch('/facturas/5', { total: 200 })
    expect(await res2.json()).toMatchObject({ error: 'IMPUTACION_NO_CUADRA', campo: 'imputaciones', detail: { suma: 100, imputable: 200 } })
    expect(llamada('pagos_editar_factura')).toBeUndefined()
  })

  it('PATCH con clave desconocida (estado) es 400 por el .strict()', async () => {
    state.profile = COMPRAS
    expect((await patch('/facturas/5', { estado: 'aprobada' })).status).toBe(400)
  })
})

// ── Órdenes: la NC ya no es una línea (20260925a) ───────────────────────────

describe('registrar orden', () => {
  it('una línea nota_credito ya no se acepta: 400 del schema, sin RPC', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', {
      proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo',
      lineas: [{ factura_id: 5, monto: 100 }, { tipo: 'nota_credito', factura_id: 5, monto: 30, nc_numero: 'NC 1', nc_fecha: HOY }],
    })
    expect(res.status).toBe(400)
    expect(llamada('pagos_registrar_orden')).toBeUndefined()
  })

  it('una NC elegida como factura a pagar rebota NC_NO_SE_PAGA antes de la RPC', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 6, clase: 'nota_credito', created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 6, monto: 30 }] })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'NC_NO_SE_PAGA', detail: { factura_id: 6 } })
    expect(llamada('pagos_registrar_orden')).toBeUndefined()
  })

  it('la RPC recibe monto_nc 0 y líneas sin datos de NC; a_cuenta suma a lo pagado', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, clase: 'factura', created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', {
      proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo',
      lineas: [{ factura_id: 5, monto: 100 }, { tipo: 'a_cuenta', monto: 50 }],
    })
    expect(res.status).toBe(200)
    const args = llamada('pagos_registrar_orden')!
    expect(args.p_orden).toMatchObject({ forma_pago: 'efectivo', monto_pagado: 150, monto_nc: 0 })
    expect(args.p_lineas).toEqual([{ tipo: 'factura', factura_id: 5, monto: 100 }, { tipo: 'a_cuenta', factura_id: null, monto: 50 }])
  })

  it('con plata: forma obligatoria, cheque exige sus cheques, transferencia exige comprobante', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const base = { proveedor_id: 1, fecha: HOY, lineas: [{ factura_id: 5, monto: 100 }] }
    expect(await (await post('/ordenes', { ...base, forma_pago: null })).json()).toMatchObject({ error: 'FORMA_PAGO_REQUERIDA' })
    expect(await (await post('/ordenes', { ...base, forma_pago: 'cheque' })).json()).toMatchObject({ error: 'CHEQUES_REQUERIDOS' })
    expect(await (await post('/ordenes', { ...base, forma_pago: 'transferencia' })).json()).toMatchObject({ error: 'COMPROBANTE_REQUERIDO', detail: { forma_pago: 'transferencia' } })
    expect(await (await post('/ordenes', { ...base, forma_pago: 'efectivo', fecha: '2999-01-01' })).json()).toMatchObject({ error: 'FECHA_FUTURA' })
    const viejo = [{ numero: '1', fecha_cobro: '2020-01-01', monto: 100 }]
    expect(await (await post('/ordenes', { ...base, forma_pago: 'cheque', cheques: viejo })).json()).toMatchObject({ error: 'FECHA_COBRO_INVALIDA' })
  })

  it('los cheques van uno por fila: suman el pago, llevan librador si son de tercero y viajan a la RPC', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const base = { proveedor_id: 1, fecha: HOY, forma_pago: 'cheque', lineas: [{ factura_id: 5, monto: 900 }] }

    // Si la suma no cierra, falta o sobra un cheque.
    const cortos = [{ numero: '1', fecha_cobro: HOY, monto: 300 }, { numero: '2', fecha_cobro: HOY, monto: 300 }]
    expect(await (await post('/ordenes', { ...base, cheques: cortos })).json()).toMatchObject({ error: 'SUMA_CHEQUES_DISTINTA' })

    // Endosado de un tercero sin librador: no se le puede reclamar a nadie.
    const ajeno = [{ numero: '9', fecha_cobro: HOY, monto: 900, es_propio: false }]
    expect((await post('/ordenes', { ...base, cheques: ajeno })).status).toBe(400)

    // Una forma que no es cheque no lleva cheques.
    expect(await (await post('/ordenes', { ...base, forma_pago: 'efectivo', cheques: [{ numero: '1', fecha_cobro: HOY, monto: 900 }] })).json())
      .toMatchObject({ error: 'CHEQUES_INESPERADOS' })

    // El caso bueno: tres cheques escalonados llegan enteros a la RPC.
    const tres = [
      { numero: '0001', banco: 'Macro', fecha_cobro: HOY, monto: 300 },
      { numero: '0002', banco: 'Macro', fecha_cobro: HOY, monto: 300 },
      { numero: '0003', banco: 'Nacion', fecha_cobro: HOY, monto: 300, es_propio: false, librador: 'Cliente SA' },
    ]
    const ok = await post('/ordenes', { ...base, cheques: tres })
    expect(ok.status).toBe(200)
    const args = llamada('pagos_registrar_orden')!
    const cheques = (args.p_orden as Fila).cheques as Fila[]
    expect(cheques).toHaveLength(3)
    expect(cheques[2]).toMatchObject({ numero: '0003', es_propio: false, librador: 'Cliente SA' })
  })

  it('un path fuera de ordenes/pendientes/ es PATH_INVALIDO', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', {
      proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 100 }],
      adjuntos: [{ tipo: 'comprobante_pago', storage_path: 'facturas/1/x.pdf', nombre_archivo: 'x.pdf', mime_type: 'application/pdf' }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('PATH_INVALIDO')
  })
})

// ── Anular OP ───────────────────────────────────────────────────────────────

describe('anular orden', () => {
  const ahora = () => new Date().toISOString()
  const ayer = () => new Date(Date.now() - 2 * 86400_000).toISOString()

  it('registrar_pagos anula la propia del día; la de ayer o la ajena rebotan ORDEN_NO_ES_TUYA_O_VIEJA', async () => {
    state.profile = CONTADOR_SIN_ANULAR
    state.ordenes = [{ id: 20, estado: 'emitida', created_by: 'u-1', created_at: ahora() }]
    expect((await post('/ordenes/20/anular', { motivo: 'me equivoqué de factura' })).status).toBe(200)
    expect(llamada('pagos_anular_orden')).toEqual({ p_orden_id: 20, p_motivo: 'me equivoqué de factura', p_user_id: 'u-1' })

    state.ordenes = [{ id: 20, estado: 'emitida', created_by: 'u-1', created_at: ayer() }]
    let res = await post('/ordenes/20/anular', { motivo: 'vieja' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('ORDEN_NO_ES_TUYA_O_VIEJA')

    state.ordenes = [{ id: 20, estado: 'emitida', created_by: 'otro', created_at: ahora() }]
    res = await post('/ordenes/20/anular', { motivo: 'ajena' })
    expect(res.status).toBe(403)
  })

  it('con anular_pagos (el contador desde el arranque, decisión 12) anula cualquiera; una anulada es ORDEN_YA_ANULADA', async () => {
    state.profile = CONTADOR
    state.ordenes = [{ id: 20, estado: 'emitida', created_by: 'otro', created_at: ayer() }]
    expect((await post('/ordenes/20/anular', { motivo: 'vieja y ajena' })).status).toBe(200)
    state.ordenes = [{ id: 20, estado: 'anulada', created_by: 'otro', created_at: ayer() }]
    const res = await post('/ordenes/20/anular', { motivo: 'otra vez' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('ORDEN_YA_ANULADA')
  })

  it('motivo obligatorio (min 3)', async () => {
    state.profile = CONTADOR
    expect((await post('/ordenes/20/anular', { motivo: 'no' })).status).toBe(400)
  })
})

// ── Anular factura ──────────────────────────────────────────────────────────

// ── Devolución del proveedor: retirada (20260925c) ──────────────────────────

describe('devolución del proveedor (retirada)', () => {
  it('la ruta /ordenes/:id/devolucion ya no existe (404) y nada llama a la RPC borrada', async () => {
    state.profile = ADMIN
    const res = await post('/ordenes/20/devolucion', { devoluciones: [{ factura_id: 5, monto: 30 }], nc_numero: '1', nc_fecha: HOY, adjuntos: [] })
    expect(res.status).toBe(404)
    expect(llamada('pagos_devolucion_proveedor')).toBeUndefined()
  })
})

// ── Nota de crédito como comprobante (20260925a–d) ──────────────────────────

describe('aplicar crédito de una NC (POST /facturas/:id/aplicar-nc)', () => {
  const BODY = { aplica_a: [{ factura_id: 5, monto: 30.5 }] }
  const CBU = '0170099220000123456788'
  beforeEach(() => {
    rpcMock.mockImplementation(async (name: string) => name === 'pagos_aplicar_nc'
      ? { data: { nc: { id: 7, estado: 'pagada_parcial', proveedor_cbu: CBU }, facturas: [{ id: 5, estado: 'pagada_parcial', proveedor_cbu: CBU }] }, error: null }
      : { data: null, error: null })
  })

  it('sin aprobar_facturas ni registrar_pagos: 403, sin RPC (lectura + tab no alcanzan)', async () => {
    state.profile = COMPRAS
    const res = await post('/facturas/7/aplicar-nc', BODY)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'aprobar_facturas|registrar_pagos' } })
    expect(llamada('pagos_aplicar_nc')).toBeUndefined()
  })

  it.each([
    ['aprobar_facturas', APROBADOR],
    ['registrar_pagos', CONTADOR_SIN_ANULAR],
    ['admin', ADMIN],
  ] as const)('con %s pasa y la RPC recibe centavos y el usuario', async (_n, prof) => {
    state.profile = prof
    const res = await post('/facturas/7/aplicar-nc', BODY)
    expect(res.status).toBe(200)
    expect(llamada('pagos_aplicar_nc')).toEqual({ p_nc_id: 7, p_aplica_a: [{ factura_id: 5, monto: 30.5 }], p_user_id: 'u-1' })
    const b = await res.json() as any
    expect(b.nc.id).toBe(7)
    expect(b.facturas).toHaveLength(1)
  })

  it('sin ver_pii la respuesta enmascara la cuenta del proveedor', async () => {
    state.profile = APROBADOR
    const b = await (await post('/facturas/7/aplicar-nc', BODY)).json() as any
    expect(b.nc.proveedor_cbu).not.toBe(CBU)
    expect(b.facturas[0].proveedor_cbu).not.toBe(CBU)
  })

  it('pide el tab facturas o pagos', async () => {
    state.profile = perfil({ lectura: true, registrar_pagos: true, tabs: ['proveedores'] })
    const res = await post('/facturas/7/aplicar-nc', BODY)
    expect(res.status).toBe(403)
    expect(llamada('pagos_aplicar_nc')).toBeUndefined()
  })

  it('body: vacío, factura repetida o clave extra → 400', async () => {
    state.profile = CONTADOR
    expect((await post('/facturas/7/aplicar-nc', { aplica_a: [] })).status).toBe(400)
    expect((await post('/facturas/7/aplicar-nc', { aplica_a: [{ factura_id: 5, monto: 1 }, { factura_id: 5, monto: 2 }] })).status).toBe(400)
    expect((await post('/facturas/7/aplicar-nc', { ...BODY, nc_id: 7 })).status).toBe(400)
    expect(llamada('pagos_aplicar_nc')).toBeUndefined()
  })

  it('los errores de la RPC salen con su status (NC_SIN_CREDITO 409, NC_SUPERA_TOTAL 400)', async () => {
    state.profile = CONTADOR
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'NC_SIN_CREDITO', details: '{"nc_id":7,"nc_disponible":0}' } }))
    const r1 = await post('/facturas/7/aplicar-nc', BODY)
    expect(r1.status).toBe(409)
    expect(await r1.json()).toEqual({ error: 'NC_SIN_CREDITO', detail: { nc_id: 7, nc_disponible: 0 } })
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'NC_SUPERA_TOTAL', details: '{"nc_id":7,"total":10,"aplicado":30.5}' } }))
    expect((await post('/facturas/7/aplicar-nc', BODY)).status).toBe(400)
  })
})

describe('alta y edición de una NC', () => {
  const NC = {
    ...FACTURA_BASE, clase: 'nota_credito', cbte_tipo_arca: 3, numero: '0001-00000012', total: 300, descripcion: 'Devolución de soga',
    imputaciones: [{ obra_cod: 'CC 1', monto: 300 }],
  }

  it('la RPC recibe clase y aplica_a en centavos; nace sin vencimiento', async () => {
    state.profile = COMPRAS
    const res = await post('/facturas', { ...NC, aplica_a: [{ factura_id: 5, monto: 120.1 }] })
    expect(res.status).toBe(200)
    const pf = llamada('pagos_crear_factura')!.p_factura as Fila
    expect(pf).toMatchObject({ clase: 'nota_credito', cbte_tipo_arca: 3, aplica_a: [{ factura_id: 5, monto: 120.1 }], vence_el: null })
  })

  it('sin aplica_a queda como crédito a favor (aplica_a vacío); una factura manda aplica_a null', async () => {
    state.profile = COMPRAS
    expect((await post('/facturas', NC)).status).toBe(200)
    expect((llamada('pagos_crear_factura')!.p_factura as Fila).aplica_a).toEqual([])
    rpcMock.mockClear()
    expect((await post('/facturas', FACTURA_BASE)).status).toBe(200)
    expect((llamada('pagos_crear_factura')!.p_factura as Fila)).toMatchObject({ clase: 'factura', aplica_a: null })
  })

  it('una NC con «ya está pagada» rebota antes de la RPC; una factura con aplica_a también', async () => {
    state.profile = CARGA_Y_PAGA
    expect((await post('/facturas', { ...NC, orden: { fecha: HOY, forma_pago: 'efectivo' } })).status).toBe(400)
    expect((await post('/facturas', { ...FACTURA_BASE, aplica_a: [{ factura_id: 5, monto: 1 }] })).status).toBe(400)
    expect(llamada('pagos_crear_factura')).toBeUndefined()
  })

  it('PATCH aplica_a: NC aprobada → NC_APLICACION_CONGELADA; factura → CAMPO_NO_EDITABLE; NC pendiente → RPC', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 7, clase: 'nota_credito', estado: 'aprobada', aprobada_at: 'x', proveedor_id: 1, fecha: HOY, total: 300 }]
    const r1 = await patch('/facturas/7', { aplica_a: [{ factura_id: 5, monto: 10 }] })
    expect(r1.status).toBe(409)
    expect((await r1.json()).error).toBe('NC_APLICACION_CONGELADA')

    state.facturas = [{ id: 5, clase: 'factura', estado: 'pendiente', aprobada_at: null, proveedor_id: 1, fecha: HOY, total: 300 }]
    const r2 = await patch('/facturas/5', { aplica_a: [] })
    expect(r2.status).toBe(400)
    expect((await r2.json()).error).toBe('CAMPO_NO_EDITABLE')

    state.facturas = [{ id: 7, clase: 'nota_credito', estado: 'pendiente', aprobada_at: null, proveedor_id: 1, fecha: HOY, total: 300 }]
    const r3 = await patch('/facturas/7', { aplica_a: [{ factura_id: 5, monto: 10.25 }] })
    expect(r3.status).toBe(200)
    expect((llamada('pagos_editar_factura')!.p_cambios as Fila).aplica_a).toEqual([{ factura_id: 5, monto: 10.25 }])

    rpcMock.mockClear()
    const r4 = await patch('/facturas/7', { aplica_a: [{ factura_id: 5, monto: 301 }] })
    expect(await r4.json()).toMatchObject({ error: 'NC_SUPERA_TOTAL', campo: 'aplica_a' })
    expect(llamada('pagos_editar_factura')).toBeUndefined()
  })

  it('anular una NC aplicada («pagada») va a la RPC (la deuda vuelve a la factura)', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 7, clase: 'nota_credito', estado: 'pagada', pagada_al_cargar: false, aprobada_at: 'x', created_by: 'u-1', created_at: new Date().toISOString() }]
    expect((await post('/facturas/7/anular', { motivo: 'mal cargada' })).status).toBe(200)
    expect(llamada('pagos_anular_factura')).toEqual({ p_factura_id: 7, p_motivo: 'mal cargada', p_user_id: 'u-1' })
  })
})

describe('lecturas con NC', () => {
  it('GET /facturas?clase=nota_credito&con_credito=1 filtra por clase y nc_disponible > 0', async () => {
    state.profile = CONTADOR
    const llamadas: [string, unknown[]][] = []
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      const c = chain([])
      for (const m of ['gt', 'eq']) c[m] = (...args: unknown[]) => { llamadas.push([m, args]); return c }
      return c
    })
    expect((await get('/facturas?clase=nota_credito&con_credito=1&proveedor_id=3')).status).toBe(200)
    expect(llamadas).toContainEqual(['eq', ['clase', 'nota_credito']])
    expect(llamadas).toContainEqual(['gt', ['nc_disponible', 0]])
    expect((await get('/facturas?clase=otra')).status).toBe(400)
  })

  it('GET /facturas/resumen filtra la clase igual que la lista (ids, 20260929o)', async () => {
    state.profile = CONTADOR
    rpcMock.mockImplementation(async () => ({ data: [], error: null }))
    const llamadas: unknown[][] = []
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      const c = chain([{ id: 4 }])
      c.eq = (...args: unknown[]) => { llamadas.push(args); return c }
      return c
    })
    await get('/facturas/resumen?grupo=proveedor&clase=factura')
    expect(llamadas).toContainEqual(['clase', 'factura'])
    expect(llamada('pagos_resumen')).toMatchObject({ p_grupo: 'proveedor', p_ids: [4], p_archivadas: true })
    llamadas.length = 0
    await get('/facturas/resumen?grupo=proveedor')
    expect(llamadas.some((a) => a[0] === 'clase')).toBe(false)
  })

  const APLICACIONES = [{ id: 1, nc_id: 7, factura_id: 5, monto: '30.00', created_at: '2026-09-25T12:00:00Z' }]
  const COMPROBANTES = [
    { id: 7, clase: 'nota_credito', tipo_comprobante: 'A', numero: '0001-00000012', fecha: HOY, total: 300, estado: 'pagada_parcial', aprobada_at: 'x', saldo: 0 },
    { id: 5, clase: 'factura', tipo_comprobante: 'A', numero: '0001-00000045', fecha: HOY, total: 1000, estado: 'pagada_parcial', aprobada_at: 'x', saldo: 900 },
  ]

  it('GET /facturas/:id trae `aplicaciones` con los dos lados y si ya bajó la deuda', async () => {
    state.profile = CONTADOR
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      if (t === 'v_pagos_facturas') return chain(COMPROBANTES)
      if (t === 'pagos_nc_aplicaciones') return chain(APLICACIONES)
      return chain([])
    })
    const res = await get('/facturas/7')
    expect(res.status).toBe(200)
    const b = await res.json() as any
    expect(b.aplicaciones).toHaveLength(1)
    expect(b.aplicaciones[0]).toMatchObject({
      id: 1, nc_id: 7, factura_id: 5, monto: 30, vigente: true, aprobada: true,
      nc: { id: 7, numero: '0001-00000012' }, factura: { id: 5, numero: '0001-00000045' },
    })
  })

  it('GET /ordenes/:id cuelga de cada factura las NC vigentes aplicadas, con su PDF', async () => {
    state.profile = CONTADOR
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      if (t === 'v_pagos_ordenes') return chain([{ id: 20, numero: 1, estado: 'emitida' }])
      if (t === 'pagos_orden_lineas') return chain([{ id: 1, tipo: 'factura', factura_id: 5, monto: 700, factura: { id: 5, numero: '0001-00000045' } }])
      if (t === 'v_pagos_facturas') return chain(COMPROBANTES)
      if (t === 'pagos_nc_aplicaciones') return chain(APLICACIONES)
      if (t === 'pagos_facturas_adjuntos') return chain([{ id: 9, factura_id: 7, tipo: 'factura', nombre_archivo: 'nc.pdf' }])
      return chain([])
    })
    const res = await get('/ordenes/20')
    expect(res.status).toBe(200)
    const b = await res.json() as any
    const nc = b.lineas[0].factura.notas_credito
    expect(nc).toHaveLength(1)
    expect(nc[0]).toMatchObject({ nc_id: 7, monto: 30, aprobada: true, nc: { numero: '0001-00000012' } })
    expect(nc[0].adjuntos).toEqual([{ id: 9, factura_id: 7, tipo: 'factura', nombre_archivo: 'nc.pdf' }])
  })
})

describe('anular factura', () => {
  it('una «pagada al cargar» sin revisar: quien la cargó el mismo día sí; otro de compras no; el aprobador sí', async () => {
    const f = { id: 5, estado: 'pagada', pagada_al_cargar: true, aprobada_at: null, created_by: 'u-1', created_at: new Date().toISOString() }
    state.profile = COMPRAS
    state.facturas = [f]
    expect((await post('/facturas/5/anular', { motivo: 'ticket duplicado' })).status).toBe(200)
    expect(llamada('pagos_anular_pagada_al_cargar')).toEqual({ p_factura_id: 5, p_motivo: 'ticket duplicado', p_user_id: 'u-1' })

    rpcMock.mockClear()
    state.facturas = [{ ...f, created_by: 'otro' }]
    expect((await post('/facturas/5/anular', { motivo: 'ticket duplicado' })).status).toBe(403)
    expect(llamada('pagos_anular_pagada_al_cargar')).toBeUndefined()

    state.profile = APROBADOR
    expect((await post('/facturas/5/anular', { motivo: 'rechazada al revisar' })).status).toBe(200)
  })

  it('pendiente propia con actualizacion sí; ajena solo con eliminacion; con pagos es FACTURA_CON_PAGOS', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pendiente', pagada_al_cargar: false, aprobada_at: null, created_by: 'u-1', created_at: new Date().toISOString() }]
    expect((await post('/facturas/5/anular', { motivo: 'mal cargada' })).status).toBe(200)
    expect(llamada('pagos_anular_factura')).toEqual({ p_factura_id: 5, p_motivo: 'mal cargada', p_user_id: 'u-1' })

    state.facturas = [{ id: 5, estado: 'aprobada', pagada_al_cargar: false, aprobada_at: 'x', created_by: 'otro', created_at: new Date().toISOString() }]
    expect((await post('/facturas/5/anular', { motivo: 'ajena' })).status).toBe(403)
    state.profile = ADMIN
    expect((await post('/facturas/5/anular', { motivo: 'ajena' })).status).toBe(200)

    state.facturas = [{ id: 5, estado: 'pagada_parcial', pagada_al_cargar: false, aprobada_at: 'x', created_by: 'u-1', created_at: new Date().toISOString() }]
    const res = await post('/facturas/5/anular', { motivo: 'con pagos' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('FACTURA_CON_PAGOS')
  })
})

// ── Errores de la RPC → HTTP ────────────────────────────────────────────────

describe('errores de la RPC', () => {
  it('FACTURA_NO_APROBADA con detalle JSON llega como 409 { error, detail }', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'FACTURA_NO_APROBADA', details: '{"factura_id":5,"estado":"pendiente"}', code: 'P0001' } }))
    const res = await post('/ordenes', { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 100 }] })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'FACTURA_NO_APROBADA', detail: { factura_id: 5, estado: 'pendiente' } })
  })
})

// ── Desajustes del revisor de integración (2026-09-18) ──────────────────────

const CBU = '0170099220000067797370'
const get = (path: string) => pagos.request(path, { method: 'GET' })

describe('enmascarado de CBU/alias también en las respuestas de las mutaciones', () => {
  const conCuenta = { id: 10, estado: 'pendiente', proveedor_cbu: CBU, proveedor_alias: 'juan.perez' }

  it('POST /facturas sin ver_pii devuelve la cuenta enmascarada; con ver_pii completa', async () => {
    rpcMock.mockImplementation(async (name: string) =>
      name === 'pagos_crear_factura' ? { data: { factura: conCuenta, orden: { id: 20, cbu_destino: CBU, alias_destino: 'juan.perez' } }, error: null } : { data: null, error: null })
    state.profile = perfil({ lectura: true, creacion: true, tabs: ['facturas'] })
    let body = await (await post('/facturas', FACTURA_BASE)).json()
    expect(body.factura.proveedor_cbu).toBe('***7370')
    expect(body.factura.proveedor_alias).toBe('***erez')
    expect(body.orden.cbu_destino).toBe('***7370')

    state.profile = COMPRAS
    body = await (await post('/facturas', FACTURA_BASE)).json()
    expect(body.factura.proveedor_cbu).toBe(CBU)
  })

  it('aprobar / observar / anular devuelven la fila suelta enmascarada; PATCH enmascara `factura`', async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'pagos_editar_factura') return { data: { factura: conCuenta, aprobacion_retirada: false }, error: null }
      return { data: conCuenta, error: null }
    })
    state.profile = perfil({ lectura: true, actualizacion: true, aprobar_facturas: true, registrar_pagos: true, tabs: ['facturas', 'pagos'] })
    state.facturas = [{ id: 10, created_by: 'otro', estado: 'pendiente', total: 1_000_000, pagada_al_cargar: false, aprobada_at: null, created_at: new Date().toISOString() }]
    expect((await (await post('/facturas/10/aprobar')).json()).proveedor_cbu).toBe('***7370')
    expect((await (await post('/facturas/10/observar', { motivo: 'mal cargada' })).json()).proveedor_cbu).toBe('***7370')
    expect((await (await post('/facturas/10/corregida', { comentario: 'listo' })).json()).proveedor_cbu).toBe('***7370')
    expect((await (await patch('/facturas/10', { numero: '0001-00000009' })).json()).factura.proveedor_cbu).toBe('***7370')
    state.profile = ADMIN
    expect((await (await post('/facturas/10/anular', { motivo: 'duplicada' })).json()).proveedor_cbu).toBe(CBU)
  })

  it('POST /ordenes y anular OP enmascaran `orden` y cada elemento de `facturas[]`', async () => {
    rpcMock.mockImplementation(async () => ({
      data: { orden: { id: 20, numero: 1, cbu_destino: CBU, alias_destino: 'juan.perez' }, facturas: [conCuenta] }, error: null,
    }))
    state.profile = CONTADOR_SIN_ANULAR
    state.profile = { ...CONTADOR_SIN_ANULAR, permisos: { pagos: { lectura: true, registrar_pagos: true, tabs: ['pagos'] } } }
    state.facturas = [{ id: 10, created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const body = await (await post('/ordenes', { proveedor_id: 1, fecha: HOY, forma_pago: 'efectivo', lineas: [{ factura_id: 10, monto: 100 }] })).json()
    expect(body.orden.cbu_destino).toBe('***7370')
    expect(body.orden.alias_destino).toBe('***erez')
    expect(body.facturas[0].proveedor_cbu).toBe('***7370')

    state.ordenes = [{ id: 20, estado: 'emitida', created_by: 'u-1', created_at: new Date().toISOString() }]
    const anulada = await (await post('/ordenes/20/anular', { motivo: 'rechazada por el banco' })).json()
    expect(anulada.orden.cbu_destino).toBe('***7370')
    expect(anulada.facturas[0].proveedor_alias).toBe('***erez')
  })
})

describe('GET /facturas/resumen: las anuladas quedan afuera como en la bandeja', () => {
  it('sin filtro de estado saca las anuladas; con anuladas=1 no; con estado explícito lo respeta', async () => {
    state.profile = CONTADOR
    rpcMock.mockImplementation(async () => ({ data: [], error: null }))
    const llamadas: [string, unknown[]][] = []
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      const c = chain([])
      for (const m of ['neq', 'in']) c[m] = (...args: unknown[]) => { llamadas.push([m, args]); return c }
      return c
    })
    expect((await get('/facturas/resumen?grupo=proveedor')).status).toBe(200)
    expect(llamadas).toContainEqual(['neq', ['estado', 'anulada']])
    expect(llamada('pagos_resumen')).toMatchObject({ p_ids: [] })

    llamadas.length = 0
    await get('/facturas/resumen?grupo=proveedor&anuladas=1')
    expect(llamadas.some(([m, a]) => m === 'neq' && a[0] === 'estado')).toBe(false)

    llamadas.length = 0
    await get('/facturas/resumen?grupo=estado&estado=aprobada,anulada')
    expect(llamadas).toContainEqual(['in', ['estado', ['aprobada', 'anulada']]])
  })
})

describe('GET /facturas?vencimiento=7: misma condición que el bucket vence_7 de la RPC', () => {
  it('exige saldo > 0 y estado abierto (no lista pagadas)', async () => {
    state.profile = CONTADOR
    const llamadas: [string, unknown[]][] = []
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      const c = chain([])
      for (const m of ['gt', 'in', 'lte', 'eq', 'not']) {
        c[m] = (...args: unknown[]) => { llamadas.push([m, args]); return c }
      }
      return c
    })
    expect((await get('/facturas?vencimiento=7')).status).toBe(200)
    expect(llamadas).toContainEqual(['gt', ['saldo', 0]])
    expect(llamadas).toContainEqual(['in', ['estado', ['pendiente', 'observada', 'aprobada', 'pagada_parcial']]])
    expect(llamadas).toContainEqual(['eq', ['paga_cliente', false]])
  })
})
