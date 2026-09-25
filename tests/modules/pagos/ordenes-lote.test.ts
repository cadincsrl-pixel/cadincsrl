/**
 * «Pagar en lote» (20260929t): POST /ordenes/lote arma N órdenes de pago, una
 * por proveedor, en UNA transacción (`pagos_emitir_ordenes_lote`).
 *
 *   - Mismas guardias que POST /ordenes (registrar_pagos + tab).
 *   - Cada orden pasa por las mismas validaciones que la OP suelta; el error
 *     de un bloque sale con el código de siempre + { indice, proveedor_id } y
 *     no llega a la RPC (nada creado).
 *   - Si rebota la RPC (todo o nada en la base), el detalle también trae el
 *     índice y los archivos NO se borran: el reintento los reusa.
 *   - Camino feliz: la RPC recibe cada orden con la fecha y la cuenta del lote,
 *     y los adjuntos se mueven a la carpeta de cada OP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, removeMock, moveMock, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  removeMock: vi.fn(),
  moveMock: vi.fn(),
  state: {
    userId: 'u-1',
    profile: null as Fila | null,
    facturas: [] as Fila[],
    /** Contenido de cada archivo del bucket (por defecto, uno distinto por path). */
    contenidos: {} as Record<string, string>,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: state.userId, email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

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
  const storage = {
    from: () => ({
      remove: async (p: string[]) => { removeMock(p); return {} },
      move: async (a: string, b: string) => { moveMock(a, b); return {} },
      download: async (path: string) => ({ data: new Blob([state.contenidos[path] ?? `contenido de ${path}`]), error: null }),
    }),
  }
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: (n: string, a: unknown) => rpcMock(n, a), storage })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { hoyAR } from '../../../src/modules/pagos/pagos.util.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const HOY = hoyAR()
const post = (path: string, body: unknown) =>
  pagos.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const perfil = (permisosPagos: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, permisos: permisosPagos ? { pagos: permisosPagos } : {} })
const ADMIN     = perfil(null, 'admin')
const CONTADOR  = perfil({ lectura: true, registrar_pagos: true, ver_pii: true, tabs: ['facturas', 'pagos', 'proveedores'] })
const APROBADOR = perfil({ lectura: true, aprobar_facturas: true, tabs: ['facturas'] })
const SIN_TAB   = perfil({ lectura: true, registrar_pagos: true, tabs: ['proveedores'] })

const COMPROBANTE = (n: string) => ({ tipo: 'comprobante_pago', storage_path: `ordenes/pendientes/${n}.pdf`, nombre_archivo: `${n}.pdf`, mime_type: 'application/pdf' })

/** Dos bloques: transferencia a VOLTAJE (prov 1) y cheque a San Juan (prov 2). */
const LOTE = {
  fecha: HOY,
  cuenta_origen_id: 7,
  ordenes: [
    { proveedor_id: 1, forma_pago: 'transferencia', lineas: [{ factura_id: 5, monto: 100 }], adjuntos: [COMPROBANTE('a')] },
    {
      proveedor_id: 2, forma_pago: 'cheque', lineas: [{ factura_id: 6, monto: 300 }],
      cheques: [{ numero: '111', banco: 'Galicia', fecha_cobro: HOY, monto: 300, foto_path: 'ordenes/pendientes/ch.jpg' }],
    },
  ],
}

beforeEach(() => {
  fromMock.mockReset(); rpcMock.mockReset(); removeMock.mockReset(); moveMock.mockReset()
  state.userId = 'u-1'
  state.profile = CONTADOR
  state.contenidos = {}
  state.facturas = [
    { id: 5, clase: 'factura', created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 },
    { id: 6, clase: 'factura', created_by: 'otro', aprobada_por: 'diego', proveedor_id: 2 },
  ]
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile)
    if (t === 'pagos_facturas') return chain(state.facturas)
    return chain([])
  })
  rpcMock.mockImplementation(async (name: string) => name === 'pagos_emitir_ordenes_lote'
    ? { data: { ordenes: [
        { indice: 0, proveedor_id: 1, orden: { id: 20, numero: 245, cbu_destino: '2850590940090418135201' }, facturas: [] },
        { indice: 1, proveedor_id: 2, orden: { id: 21, numero: 246, cbu_destino: null }, facturas: [] },
      ] }, error: null }
    : { data: null, error: null })
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as Fila | undefined

describe('POST /ordenes/lote — guardias', () => {
  it('sin registrar_pagos: 403 SIN_PERMISO y no llama a la RPC', async () => {
    state.profile = APROBADOR
    const res = await post('/ordenes/lote', LOTE)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'registrar_pagos' } })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('sin el tab facturas/pagos: 403 SIN_TAB', async () => {
    state.profile = SIN_TAB
    const res = await post('/ordenes/lote', LOTE)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('SIN_TAB')
  })

  it('más de 30 órdenes, proveedor repetido o factura repetida: 400 del schema', async () => {
    const muchas = Array.from({ length: 31 }, (_, i) => ({ proveedor_id: i + 1, forma_pago: 'efectivo', lineas: [{ factura_id: i + 100, monto: 1 }] }))
    expect((await post('/ordenes/lote', { fecha: HOY, ordenes: muchas })).status).toBe(400)
    const repetido = { fecha: HOY, ordenes: [LOTE.ordenes[0], { ...LOTE.ordenes[0], lineas: [{ factura_id: 9, monto: 1 }] }] }
    expect((await post('/ordenes/lote', repetido)).status).toBe(400)
    const facturaDosVeces = { fecha: HOY, ordenes: [LOTE.ordenes[0], { proveedor_id: 2, forma_pago: 'efectivo', lineas: [{ factura_id: 5, monto: 1 }] }] }
    expect((await post('/ordenes/lote', facturaDosVeces)).status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('una orden con otra fecha que la del lote: 400', async () => {
    const res = await post('/ordenes/lote', { ...LOTE, ordenes: [{ ...LOTE.ordenes[0], fecha: '2026-01-01' }] })
    expect(res.status).toBe(400)
  })
})

describe('POST /ordenes/lote — un bloque inválido, nada creado', () => {
  it('separación de funciones en el 2º bloque: 403 con indice y proveedor_id, sin RPC', async () => {
    state.facturas[1]!.aprobada_por = 'u-1'
    const res = await post('/ordenes/lote', LOTE)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'NO_PUEDE_PAGAR_LO_QUE_APROBO', detail: { factura_id: 6, indice: 1, proveedor_id: 2 } })
    expect(llamada('pagos_emitir_ordenes_lote')).toBeUndefined()
  })

  it('el admin saltea la separación de funciones', async () => {
    state.profile = ADMIN
    state.facturas[1]!.aprobada_por = 'u-1'
    expect((await post('/ordenes/lote', LOTE)).status).toBe(200)
  })

  it('cheques que no suman en el 2º bloque: 400 SUMA_CHEQUES_DISTINTA con indice', async () => {
    const lote = { ...LOTE, ordenes: [LOTE.ordenes[0], { ...LOTE.ordenes[1], cheques: [{ numero: '111', fecha_cobro: HOY, monto: 200 }] }] }
    const res = await post('/ordenes/lote', lote)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'SUMA_CHEQUES_DISTINTA', detail: { campo: 'cheques', indice: 1, proveedor_id: 2 } })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('transferencia sin comprobante en el 1º: 400 COMPROBANTE_REQUERIDO con indice 0', async () => {
    const lote = { ...LOTE, ordenes: [{ ...LOTE.ordenes[0], adjuntos: [] }, LOTE.ordenes[1]] }
    const res = await post('/ordenes/lote', lote)
    expect(await res.json()).toMatchObject({ error: 'COMPROBANTE_REQUERIDO', detail: { indice: 0, proveedor_id: 1 } })
  })

  it('la RPC rebota (todo o nada): el código de siempre con indice, y los archivos quedan para reintentar', async () => {
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: 'MONTO_SUPERA_SALDO', details: JSON.stringify({ factura_id: 6, saldo_pagable: 250, monto: 300, indice: 1, proveedor_id: 2 }) },
    }))
    const res = await post('/ordenes/lote', LOTE)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'MONTO_SUPERA_SALDO', detail: { factura_id: 6, saldo_pagable: 250, monto: 300, indice: 1, proveedor_id: 2 } })
    expect(removeMock).not.toHaveBeenCalled()
    expect(moveMock).not.toHaveBeenCalled()
  })
})

describe('POST /ordenes/lote — camino feliz', () => {
  it('una sola RPC con cada orden armada como la OP suelta, la fecha y cuenta del lote', async () => {
    const res = await post('/ordenes/lote', LOTE)
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledTimes(1)
    const args = llamada('pagos_emitir_ordenes_lote')!
    expect(args.p_user_id).toBe('u-1')
    const ordenes = args.p_ordenes as { orden: Fila; lineas: Fila[]; adjuntos: Fila[] }[]
    expect(ordenes).toHaveLength(2)
    expect(ordenes[0]!.orden).toMatchObject({ proveedor_id: 1, fecha: HOY, forma_pago: 'transferencia', monto_pagado: 100, cuenta_origen_id: 7, cheques: [] })
    expect(ordenes[0]!.lineas).toEqual([{ tipo: 'factura', factura_id: 5, monto: 100 }])
    expect(ordenes[0]!.adjuntos[0]).toMatchObject({ tipo: 'comprobante_pago', storage_path: 'ordenes/pendientes/a.pdf' })
    expect(ordenes[1]!.orden).toMatchObject({ proveedor_id: 2, forma_pago: 'cheque', monto_pagado: 300 })
    // La foto viaja como adjunto y, en el cheque, sólo su path (la RPC mira que cada echeq traiga archivo).
    expect((ordenes[1]!.orden.cheques as Fila[])[0]).toMatchObject({ numero: '111', foto_path: 'ordenes/pendientes/ch.jpg' })
    expect(ordenes[1]!.adjuntos[0]).toMatchObject({ tipo: 'cheque', storage_path: 'ordenes/pendientes/ch.jpg' })

    // Cada archivo va a la carpeta de SU orden.
    expect(moveMock).toHaveBeenCalledWith('ordenes/pendientes/a.pdf', 'ordenes/20/a.pdf')
    expect(moveMock).toHaveBeenCalledWith('ordenes/pendientes/ch.jpg', 'ordenes/21/ch.jpg')

    const body = await res.json()
    expect(body.ordenes.map((o: Fila) => [o.indice, o.proveedor_id, (o.orden as Fila).numero])).toEqual([[0, 1, 245], [1, 2, 246]])
  })

  it('la cuenta de una orden (aunque sea null) pisa la del lote', async () => {
    await post('/ordenes/lote', { ...LOTE, ordenes: [{ ...LOTE.ordenes[0], cuenta_origen_id: null }, LOTE.ordenes[1]] })
    const ordenes = llamada('pagos_emitir_ordenes_lote')!.p_ordenes as { orden: Fila }[]
    expect(ordenes[0]!.orden.cuenta_origen_id).toBeNull()
    expect(ordenes[1]!.orden.cuenta_origen_id).toBe(7)
  })

  it('sin ver_pii la cuenta destino sale enmascarada', async () => {
    state.profile = perfil({ lectura: true, registrar_pagos: true, tabs: ['facturas', 'pagos'] })
    const body = await (await post('/ordenes/lote', LOTE)).json()
    expect(body.ordenes[0].orden.cbu_destino).not.toBe('2850590940090418135201')
  })
})

/**
 * 25/09 (OP-0247/0248): el e-cheq de Cencosud quedó también como comprobante
 * en la OP de Gimenez. Fue el archivo elegido en el bloque equivocado (dos
 * subidas distintas del mismo PDF), no un cruce del código: cada bloque tiene
 * que terminar SOLO en su OP, y el mismo archivo en dos bloques se frena.
 */
describe('POST /ordenes/lote — cada archivo en SU orden', () => {
  const ECHEQ = (prov: number, factura: number, numero: string, foto: string, extra: Fila = {}) => ({
    proveedor_id: prov, forma_pago: 'echeq', lineas: [{ factura_id: factura, monto: 100 }],
    cheques: [{ numero, banco: 'Galicia', fecha_cobro: HOY, monto: 100, foto_path: `ordenes/pendientes/${foto}.pdf` }],
    ...extra,
  })
  const tresBloques = (ordenes: Fila[]) => {
    state.facturas = [5, 6, 7].map((id, i) => ({ id, clase: 'factura', created_by: 'otro', aprobada_por: 'diego', proveedor_id: i + 1 }))
    rpcMock.mockImplementation(async () => ({ data: { ordenes: ordenes.map((o, i) => ({ indice: i, proveedor_id: o.proveedor_id, orden: { id: 30 + i, numero: 300 + i }, facturas: [] })) }, error: null }))
    return { fecha: HOY, ordenes }
  }

  it('archivos distintos: cada bloque viaja con los suyos y se mueve a la carpeta de su OP', async () => {
    const lote = tresBloques([ECHEQ(1, 5, '3076', 'cencosud'), ECHEQ(2, 6, '3077', 'gimenez'), ECHEQ(3, 7, '3079', 'sanjuan')])
    const res = await post('/ordenes/lote', lote)
    expect(res.status).toBe(200)
    const ordenes = llamada('pagos_emitir_ordenes_lote')!.p_ordenes as { orden: Fila; adjuntos: Fila[] }[]
    expect(ordenes.map((o) => o.adjuntos.map((a) => [a.tipo, a.storage_path, a.obs]))).toEqual([
      [['cheque', 'ordenes/pendientes/cencosud.pdf', 'Cheque N° 3076']],
      [['cheque', 'ordenes/pendientes/gimenez.pdf', 'Cheque N° 3077']],
      [['cheque', 'ordenes/pendientes/sanjuan.pdf', 'Cheque N° 3079']],
    ])
    expect(moveMock.mock.calls).toEqual([
      ['ordenes/pendientes/cencosud.pdf', 'ordenes/30/cencosud.pdf'],
      ['ordenes/pendientes/gimenez.pdf', 'ordenes/31/gimenez.pdf'],
      ['ordenes/pendientes/sanjuan.pdf', 'ordenes/32/sanjuan.pdf'],
    ])
  })

  it('el mismo PDF subido en dos bloques (el caso real): 400 ARCHIVO_EN_VARIOS_BLOQUES nombrando los bloques, sin RPC ni borrar nada', async () => {
    // Cencosud: su e-cheq + el mismo PDF como comprobante (otra subida).
    // Gimenez: su e-cheq + OTRA subida del PDF de Cencosud como comprobante.
    state.contenidos = {
      'ordenes/pendientes/cencosud.pdf': 'echeq 3076',
      'ordenes/pendientes/cencosud-comp.pdf': 'echeq 3076',
      'ordenes/pendientes/gimenez.pdf': 'echeq 3077',
      'ordenes/pendientes/gimenez-comp.pdf': 'echeq 3076',
    }
    const comp = (n: string) => ({ ...COMPROBANTE(n), nombre_archivo: 'Cheque3076_CENCOSUD SA_30590360763.pdf' })
    const lote = tresBloques([
      ECHEQ(1, 5, '3076', 'cencosud', { adjuntos: [comp('cencosud-comp')] }),
      ECHEQ(2, 6, '3077', 'gimenez', { adjuntos: [comp('gimenez-comp')] }),
      ECHEQ(3, 7, '3079', 'sanjuan'),
    ])
    const res = await post('/ordenes/lote', lote)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'ARCHIVO_EN_VARIOS_BLOQUES',
      campo: 'adjuntos',
      detail: {
        campo: 'adjuntos', indices: [0, 1], proveedor_ids: [1, 2],
        nombre_archivo: 'Cheque3076_CENCOSUD SA_30590360763.pdf', tipos: ['comprobante_pago'],
        indice: 1, proveedor_id: 2,
      },
    })
    expect(rpcMock).not.toHaveBeenCalled()
    // Nada se borra: la persona saca el archivo equivocado y reintenta con el resto.
    expect(removeMock).not.toHaveBeenCalled()
    expect(moveMock).not.toHaveBeenCalled()
  })

  it('transferencia masiva del Galicia: el mismo comprobante en bloques que son TODOS transferencia pasa, en cada OP', async () => {
    state.contenidos = { 'ordenes/pendientes/galicia-1.pdf': 'masiva', 'ordenes/pendientes/galicia-2.pdf': 'masiva' }
    const transf = (prov: number, factura: number, n: string) => ({
      proveedor_id: prov, forma_pago: 'transferencia', lineas: [{ factura_id: factura, monto: 100 }], adjuntos: [COMPROBANTE(n)],
    })
    const lote = tresBloques([transf(1, 5, 'galicia-1'), transf(2, 6, 'galicia-2')])
    const res = await post('/ordenes/lote', lote)
    expect(res.status).toBe(200)
    const ordenes = llamada('pagos_emitir_ordenes_lote')!.p_ordenes as { adjuntos: Fila[] }[]
    expect(ordenes.map((o) => o.adjuntos.map((a) => a.storage_path))).toEqual([['ordenes/pendientes/galicia-1.pdf'], ['ordenes/pendientes/galicia-2.pdf']])
    expect(moveMock.mock.calls).toEqual([
      ['ordenes/pendientes/galicia-1.pdf', 'ordenes/30/galicia-1.pdf'],
      ['ordenes/pendientes/galicia-2.pdf', 'ordenes/31/galicia-2.pdf'],
    ])
  })

  it('el comprobante compartido con un bloque que NO es transferencia se frena', async () => {
    state.contenidos = { 'ordenes/pendientes/galicia-1.pdf': 'masiva', 'ordenes/pendientes/galicia-2.pdf': 'masiva' }
    const lote = tresBloques([
      { proveedor_id: 1, forma_pago: 'transferencia', lineas: [{ factura_id: 5, monto: 100 }], adjuntos: [COMPROBANTE('galicia-1')] },
      { proveedor_id: 2, forma_pago: 'efectivo', lineas: [{ factura_id: 6, monto: 100 }], adjuntos: [COMPROBANTE('galicia-2')] },
    ])
    const res = await post('/ordenes/lote', lote)
    expect(await res.json()).toMatchObject({ error: 'ARCHIVO_EN_VARIOS_BLOQUES', detail: { indices: [0, 1], proveedor_ids: [1, 2] } })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('un comprobante de transferencia que es el archivo de un cheque de otro bloque se frena', async () => {
    state.contenidos = { 'ordenes/pendientes/galicia-1.pdf': 'echeq 3077', 'ordenes/pendientes/gimenez.pdf': 'echeq 3077' }
    const lote = tresBloques([
      { proveedor_id: 1, forma_pago: 'transferencia', lineas: [{ factura_id: 5, monto: 100 }], adjuntos: [COMPROBANTE('galicia-1')] },
      ECHEQ(2, 6, '3077', 'gimenez'),
    ])
    const res = await post('/ordenes/lote', lote)
    expect(await res.json()).toMatchObject({ error: 'ARCHIVO_EN_VARIOS_BLOQUES', detail: { indices: [0, 1], tipos: ['comprobante_pago', 'cheque'] } })
  })

  it('la foto de un cheque repetida en otro bloque también se frena', async () => {
    state.contenidos = { 'ordenes/pendientes/cencosud.pdf': 'echeq 3076', 'ordenes/pendientes/otra.pdf': 'echeq 3076' }
    const lote = tresBloques([ECHEQ(1, 5, '3076', 'cencosud'), ECHEQ(2, 6, '3077', 'gimenez'), ECHEQ(3, 7, '3079', 'otra')])
    const res = await post('/ordenes/lote', lote)
    expect(await res.json()).toMatchObject({ error: 'ARCHIVO_EN_VARIOS_BLOQUES', detail: { indices: [0, 2], proveedor_ids: [1, 3], tipos: ['cheque'] } })
  })

  it('el mismo archivo dos veces en UN bloque se unifica en su OP, y la copia se borra recién después de registrar', async () => {
    state.contenidos = { 'ordenes/pendientes/cencosud.pdf': 'echeq 3076', 'ordenes/pendientes/cencosud-comp.pdf': 'echeq 3076' }
    const lote = tresBloques([
      ECHEQ(1, 5, '3076', 'cencosud', { adjuntos: [COMPROBANTE('cencosud-comp')] }),
      ECHEQ(2, 6, '3077', 'gimenez'),
      ECHEQ(3, 7, '3079', 'sanjuan'),
    ])
    expect((await post('/ordenes/lote', lote)).status).toBe(200)
    const ordenes = llamada('pagos_emitir_ordenes_lote')!.p_ordenes as { orden: Fila; adjuntos: Fila[] }[]
    expect(ordenes[0]!.adjuntos).toHaveLength(1)
    expect(ordenes[0]!.adjuntos[0]).toMatchObject({ storage_path: 'ordenes/pendientes/cencosud-comp.pdf', obs: 'Cheque N° 3076' })
    // El e-cheq apunta al archivo que quedó.
    expect((ordenes[0]!.orden.cheques as Fila[])[0]!.foto_path).toBe('ordenes/pendientes/cencosud-comp.pdf')
    expect(ordenes[1]!.adjuntos.map((a) => a.storage_path)).toEqual(['ordenes/pendientes/gimenez.pdf'])
    expect(removeMock).toHaveBeenCalledWith(['ordenes/pendientes/cencosud.pdf'])
    expect(rpcMock.mock.invocationCallOrder[0]!).toBeLessThan(removeMock.mock.invocationCallOrder[0]!)
  })

  it('si la RPC rebota, tampoco se borra la copia unificada (el reintento manda los mismos paths)', async () => {
    state.contenidos = { 'ordenes/pendientes/cencosud.pdf': 'echeq 3076', 'ordenes/pendientes/cencosud-comp.pdf': 'echeq 3076' }
    const lote = tresBloques([ECHEQ(1, 5, '3076', 'cencosud', { adjuntos: [COMPROBANTE('cencosud-comp')] }), ECHEQ(2, 6, '3077', 'gimenez')])
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'MONTO_SUPERA_SALDO', details: JSON.stringify({ indice: 1 }) } }))
    expect((await post('/ordenes/lote', lote)).status).toBe(409)
    expect(removeMock).not.toHaveBeenCalled()
  })
})

describe('auditoría', () => {
  it('POST /api/pagos/ordenes/lote queda como «orden de pago · cargar en lote»', () => {
    expect(parseRoute('/api/pagos/ordenes/lote', 'POST')).toEqual({ modulo: 'pagos', entidad: 'orden de pago', accion: 'cargar en lote' })
  })
})
