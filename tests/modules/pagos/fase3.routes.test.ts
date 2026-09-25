/**
 * Compras, fase 3 (20260927a/b/c/h), con la base mockeada:
 *   - período IVA: sugerido, validación contra la fecha en alta y edición, filtros;
 *   - importador de ARCA recibidos: flag `importar_comprobantes`, filas o CSV
 *     crudo, errores de lectura (todo o nada), `fila_archivo`;
 *   - imputar una / en lote y lo que se frena antes de la RPC;
 *   - aprobar o repartir una sin imputar → 409 FACTURA_SIN_IMPUTAR;
 *   - pagadas en lote con tarjeta / billetera (creación o admin);
 *   - auditoría de las rutas nuevas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, state, filtros } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  filtros: [] as [string, string, unknown][],
  state: { userId: 'u-1', profile: null as Fila | null, facturas: [] as Fila[] },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: state.userId, email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

function chain(tabla: string, data: unknown) {
  const obj: any = {}
  const self = () => obj
  for (const m of ['select', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'contains', 'order', 'range', 'limit', 'update', 'insert', 'delete']) obj[m] = self
  obj.eq = (col: string, v: unknown) => { filtros.push([tabla, col, v]); return obj }
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
import { parseRoute } from '../../../src/middleware/audit.js'
import { ListFacturasQuerySchema, FacturasResumenQuerySchema, CreateFacturaSchema, UpdateFacturaSchema } from '../../../src/modules/pagos/pagos.schema.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => pagos.request(path, { method: 'POST', ...json(body) })
const patch = (path: string, body: unknown = {}) => pagos.request(path, { method: 'PATCH', ...json(body) })
const HOY = hoyAR()

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { pagos: p } : {} })
const ADMIN = perfil(null, 'admin')
const COMPRAS = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['facturas', 'proveedores'] })
const IMPORTADOR = perfil({ lectura: true, creacion: true, actualizacion: true, importar_comprobantes: true, tabs: ['facturas'] })
const APROBADOR = perfil({ lectura: true, aprobar_facturas: true, tabs: ['facturas'] })
const CONTADOR = perfil({ lectura: true, registrar_pagos: true, tabs: ['facturas', 'pagos'] })

const FILA = {
  fecha: '2026-07-01', cbte_tipo: 1, pto_vta: 8837, numero: 4557, emisor_doc_tipo: 80, emisor_doc_nro: '30590360763',
  emisor_razon_social: 'Cencosud', neto_gravado: 100.004, iva: 21, total: 121.004,
}
const CSV = [
  'Fecha;Tipo;Punto de Venta;Número Desde;Nro. Doc. Emisor;Denominación Emisor;Imp. Neto Gravado;IVA;Imp. Total',
  '01/07/2026;1 - Factura A;1;10;30744444446;Uno SA;100,00;21,00;121,00',
  '99/07/2026;1 - Factura A;1;11;30744444446;Uno SA;100,00;21,00;121,00',
  '02/07/2026;6 - Factura B;2;12;30755555555;Dos SA;0;0;50,00',
].join('\n')

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  filtros.length = 0
  state.userId = 'u-1'
  state.profile = null
  state.facturas = []
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(t, state.profile)
    if (t === 'pagos_facturas' || t === 'v_pagos_facturas') return chain(t, state.facturas)
    return chain(t, [])
  })
  rpcMock.mockImplementation(async (name: string, args: any) => {
    if (name === '_pagos_periodo_iva_sugerido') return { data: args.p_fecha < '2026-08-01' ? '2026-08-01' : `${args.p_fecha.slice(0, 7)}-01`, error: null }
    if (name === 'pagos_importar_recibidos') {
      return { data: {
        confirmado: args.p_confirmar, importacion_id: args.p_confirmar ? 7 : null, total_filas: args.p_filas.length, nuevas: args.p_filas.length,
        duplicadas: 0, errores: 0, proveedores_nuevos: [],
        filas: args.p_filas.map((_f: unknown, i: number) => ({ indice: i + 1, estado: 'nueva' })),
      }, error: null }
    }
    if (name === 'pagos_imputar_factura') return { data: { factura: { id: args.p_factura_id, proveedor_cbu: '2850590940090418135201', sin_imputar: false } }, error: null }
    if (name === 'pagos_imputar_lote') return { data: { imputadas: args.p_ids.length, ids: args.p_ids }, error: null }
    if (name === 'pagos_marcar_pagadas') return { data: { ordenes: args.p_factura_ids.map((id: number, i: number) => ({ factura_id: id, orden_id: 100 + i, numero: 50 + i })), total: 999 }, error: null }
    if (name === 'pagos_crear_factura') return { data: { factura: { id: 10 } }, error: null }
    if (name === 'pagos_editar_factura') return { data: { factura: { id: 5 } }, error: null }
    return { data: null, error: null }
  })
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as any

// ═══════════════════════════════ Período IVA ════════════════════════════════

describe('período IVA', () => {
  it('sugerido: corrido si el mes de la fecha está cerrado', async () => {
    state.profile = COMPRAS
    const r = await pagos.request('/facturas/periodo-iva-sugerido?fecha=2026-07-20')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ periodo_iva: '2026-08-01', corrido: true })
    expect(llamada('_pagos_periodo_iva_sugerido')).toEqual({ p_fecha: '2026-07-20' })
    const r2 = await pagos.request('/facturas/periodo-iva-sugerido?fecha=2026-09-03')
    expect(await r2.json()).toEqual({ periodo_iva: '2026-09-01', corrido: false })
  })

  it('sugerido con fecha inválida → 400 DATOS_INVALIDOS; sin tab facturas → 403', async () => {
    state.profile = COMPRAS
    const r = await pagos.request('/facturas/periodo-iva-sugerido?fecha=20-07-2026')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'DATOS_INVALIDOS', campo: 'fecha' })
    state.profile = perfil({ lectura: true, tabs: ['pagos'] })
    expect((await pagos.request('/facturas/periodo-iva-sugerido?fecha=2026-07-20')).status).toBe(403)
  })

  it('schemas: YYYY-MM se guarda como día 1; el resumen filtra sin_imputar pero no el período IVA', () => {
    const base = { proveedor_id: 1, tipo_comprobante: 'A', numero: '1-1', fecha: '2026-07-01', total: 1, descripcion: 'abc', concepto_id: 1, imputaciones: [{ obra_cod: 'X', monto: 1 }] }
    expect(CreateFacturaSchema.parse({ ...base, periodo_iva: '2026-08' }).periodo_iva).toBe('2026-08-01')
    expect(CreateFacturaSchema.parse({ ...base, periodo_iva: null }).periodo_iva).toBeNull()
    expect(CreateFacturaSchema.safeParse({ ...base, periodo_iva: '2026-08-15' }).success).toBe(false)
    expect(UpdateFacturaSchema.safeParse({ periodo_iva: null }).success).toBe(false)
    expect(UpdateFacturaSchema.parse({ periodo_iva: '2026-09-01' }).periodo_iva).toBe('2026-09-01')
    expect(ListFacturasQuerySchema.parse({ periodo_iva: '2026-09', sin_imputar: '1' })).toMatchObject({ periodo_iva: '2026-09', sin_imputar: '1' })
    const res = FacturasResumenQuerySchema.parse({ periodo_iva: '2026-09', sin_imputar: '1' })
    expect(res).toHaveProperty('sin_imputar', '1')
    expect(res).not.toHaveProperty('periodo_iva')
  })

  it('alta con período anterior al mes de la fecha → 400 antes de la RPC; válido viaja en p_factura', async () => {
    state.profile = COMPRAS
    const base = { proveedor_id: 1, tipo_comprobante: 'A', numero: '0001-00000007', fecha: HOY, total: 100, descripcion: 'Hierro', concepto_id: 2, imputaciones: [{ obra_cod: 'CC 1', monto: 100 }] }
    const r = await post('/facturas', { ...base, periodo_iva: '2020-01' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'PERIODO_IVA_ANTERIOR_A_FECHA', campo: 'periodo_iva' })
    expect(llamada('pagos_crear_factura')).toBeUndefined()
    const ok = await post('/facturas', { ...base, periodo_iva: '2099-12' })
    expect(ok.status).toBe(200)
    expect(llamada('pagos_crear_factura').p_factura.periodo_iva).toBe('2099-12-01')
    rpcMock.mockClear()
    await post('/facturas', base)
    expect(llamada('pagos_crear_factura').p_factura.periodo_iva).toBeNull()
  })

  it('edición: valida contra la fecha fusionada y manda el período en p_cambios', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pagada', clase: 'factura', fecha: '2026-08-20', total: 100, periodo_iva: '2026-08-01', sin_imputar: false }]
    const mal = await patch('/facturas/5', { periodo_iva: '2026-07' })
    expect(mal.status).toBe(400)
    expect(await mal.json()).toMatchObject({ error: 'PERIODO_IVA_ANTERIOR_A_FECHA' })
    // Pagada: el período IVA no está congelado (es clasificación).
    const ok = await patch('/facturas/5', { periodo_iva: '2026-09' })
    expect(ok.status).toBe(200)
    expect(llamada('pagos_editar_factura').p_cambios).toEqual({ periodo_iva: '2026-09-01' })
  })

  it('filtros de la bandeja', async () => {
    state.profile = COMPRAS
    await pagos.request('/facturas?periodo_iva=2026-09&periodo_iva_distinto=1&sin_imputar=0&tributos_a_revisar=1&origen_carga=arca_recibidos&importacion_id=7')
    expect(filtros).toEqual(expect.arrayContaining([
      ['v_pagos_facturas', 'periodo_iva', '2026-09-01'], ['v_pagos_facturas', 'periodo_iva_distinto', true],
      ['v_pagos_facturas', 'sin_imputar', false], ['v_pagos_facturas', 'tributos_a_revisar', true],
      ['v_pagos_facturas', 'origen_carga', 'arca_recibidos'], ['v_pagos_facturas', 'importacion_id', 7],
    ]))
    filtros.length = 0
    await pagos.request('/facturas')
    expect(filtros.some((f) => f[1] === 'sin_imputar')).toBe(false)
  })
})

// ═══════════════════════════════ Importador ═════════════════════════════════

describe('importar de ARCA', () => {
  it('sin el flag importar_comprobantes → 403 (aunque tenga creación); admin pasa', async () => {
    state.profile = COMPRAS
    const r = await post('/facturas/importar-arca', { filas: [FILA] })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'importar_comprobantes' } })
    state.profile = ADMIN
    expect((await post('/facturas/importar-arca', { filas: [FILA] })).status).toBe(200)
  })

  it('filas armadas: redondea a centavos y pasa archivo, hash y confirmar', async () => {
    state.profile = IMPORTADOR
    const hash = 'a'.repeat(64)
    const r = await post('/facturas/importar-arca', { filas: [FILA], archivo: 'julio.xlsx', hash_sha256: hash, confirmar: true })
    expect(r.status).toBe(200)
    const a = llamada('pagos_importar_recibidos')
    expect(a).toMatchObject({ p_user_id: 'u-1', p_confirmar: true, p_archivo: 'julio.xlsx', p_hash: hash })
    expect(a.p_filas[0]).toMatchObject({ neto_gravado: 100, total: 121, moneda: 'PES', tipo_cambio: 1, emisor_razon_social: 'Cencosud' })
    const b = await r.json() as any
    expect(b.importacion_id).toBe(7)
    expect(b).not.toHaveProperty('errores_parseo')
  })

  it('CSV crudo: vista previa con errores de lectura y fila_archivo por fila', async () => {
    state.profile = IMPORTADOR
    const r = await post('/facturas/importar-arca', { csv: CSV, archivo: 'julio.csv' })
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(llamada('pagos_importar_recibidos').p_filas).toHaveLength(2)
    expect(b.formato).toBe('clasico')
    expect(b.errores_parseo).toEqual([{ fila_archivo: 3, motivo: expect.stringMatching(/Fecha ilegible/) }])
    expect(b.filas.map((f: any) => f.fila_archivo)).toEqual([2, 4])
  })

  it('CSV con errores de lectura y confirmar → 422 sin tocar la base', async () => {
    state.profile = IMPORTADOR
    const r = await post('/facturas/importar-arca', { csv: CSV, confirmar: true })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'IMPORTACION_CON_ERRORES', detail: { errores_parseo: [{ fila_archivo: 3 }] } })
    expect(llamada('pagos_importar_recibidos')).toBeUndefined()
  })

  it('el archivo de EMITIDOS → 400 ARCHIVO_ILEGIBLE; filas y csv juntos → 400', async () => {
    state.profile = IMPORTADOR
    const r = await post('/facturas/importar-arca', { matriz: [['Fecha', 'Tipo', 'Número Desde', 'Denominación Comprador', 'Imp. Total']] })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'ARCHIVO_ILEGIBLE', detail: { motivo: expect.stringMatching(/EMITIDOS/) } })
    expect((await post('/facturas/importar-arca', { filas: [FILA], csv: CSV })).status).toBe(400)
    expect((await post('/facturas/importar-arca', {})).status).toBe(400)
  })

  it('errores de la RPC: IMPORTACION_CON_ERRORES es 422 con su detail', async () => {
    state.profile = IMPORTADOR
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'IMPORTACION_CON_ERRORES', details: '{"errores":[{"indice":1,"error":"EMISOR_SIN_CUIT"}]}' } }))
    const r = await post('/facturas/importar-arca', { filas: [FILA], confirmar: true })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'IMPORTACION_CON_ERRORES', detail: { errores: [{ indice: 1, error: 'EMISOR_SIN_CUIT' }] } })
  })

  it('GET /importaciones con el nombre de quien la hizo', async () => {
    state.profile = COMPRAS
    fromMock.mockImplementation((t: string) => {
      // maybeSingle (guardias) toma el primero; el `.in(ids)` del listado, todos.
      if (t === 'profiles') return chain(t, [state.profile, { id: 'u-9', nombre: 'Nicolás' }])
      if (t === 'pagos_importaciones') return chain(t, [{ id: 7, archivo: 'julio.xlsx', created_by: 'u-9' }])
      return chain(t, [])
    })
    const r = await pagos.request('/importaciones')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([{ id: 7, archivo: 'julio.xlsx', created_by: 'u-9', created_by_nombre: 'Nicolás', deshecha_por_nombre: null, facturas_vigentes: 0 }])
  })
})

// ═══════════════════════════════ Imputar ════════════════════════════════════

describe('imputar', () => {
  const IMPUTAR = { concepto_id: 3, imputaciones: [{ obra_cod: 'CC 1', monto: 60 }, { obra_cod: 'CC 2', monto: 40 }] }

  it('una: cuadra contra total − percepciones y enmascara el CBU sin ver_pii', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pendiente', fecha: '2026-07-01', total: 110, percepciones: 10, sin_imputar: true, tributos_a_revisar: false }]
    const r = await post('/facturas/5/imputar', IMPUTAR)
    expect(r.status).toBe(200)
    expect(llamada('pagos_imputar_factura')).toEqual({
      p_factura_id: 5, p_concepto_id: 3, p_descripcion: null, p_user_id: 'u-1',
      p_imputaciones: [{ obra_cod: 'CC 1', monto: 60, obs: '' }, { obra_cod: 'CC 2', monto: 40, obs: '' }],
    })
    const b = await r.json() as any
    expect(b.factura.proveedor_cbu).not.toBe('2850590940090418135201')
  })

  it('reparto que no cuadra → 400 IMPUTACION_NO_CUADRA sin RPC', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pendiente', fecha: '2026-07-01', total: 110, percepciones: 0, sin_imputar: true, tributos_a_revisar: false }]
    const r = await post('/facturas/5/imputar', IMPUTAR)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'IMPUTACION_NO_CUADRA', campo: 'imputaciones' })
    expect(llamada('pagos_imputar_factura')).toBeUndefined()
  })

  it('ya imputada → 409; tributos a revisar → 409; anulada → 409', async () => {
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pendiente', total: 100, sin_imputar: false }]
    expect(await (await post('/facturas/5/imputar', IMPUTAR)).json()).toMatchObject({ error: 'FACTURA_YA_IMPUTADA' })
    state.facturas = [{ id: 5, estado: 'pendiente', total: 100, sin_imputar: true, tributos_a_revisar: true }]
    const r = await post('/facturas/5/imputar', IMPUTAR)
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'TRIBUTOS_A_REVISAR' })
    state.facturas = [{ id: 5, estado: 'anulada', total: 100, sin_imputar: true }]
    expect(await (await post('/facturas/5/imputar', IMPUTAR)).json()).toMatchObject({ error: 'FACTURA_CERRADA' })
  })

  it('lote: ids únicos y ordenados; una no imputable frena todo con su factura_id', async () => {
    state.profile = COMPRAS
    state.facturas = [
      { id: 3, estado: 'pendiente', sin_imputar: true, tributos_a_revisar: false },
      { id: 9, estado: 'pendiente', sin_imputar: true, tributos_a_revisar: false },
    ]
    const r = await post('/facturas/imputar-lote', { ids: [9, 3, 9], concepto_id: 2, obra_cod: 'CC 1' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ imputadas: 2, ids: [3, 9] })
    expect(llamada('pagos_imputar_lote')).toEqual({ p_ids: [3, 9], p_concepto_id: 2, p_obra_cod: 'CC 1', p_user_id: 'u-1' })
    rpcMock.mockClear()
    const mal = await post('/facturas/imputar-lote', { ids: [3, 4], concepto_id: 2, obra_cod: 'CC 1' })
    expect(mal.status).toBe(404)
    expect(await mal.json()).toMatchObject({ error: 'FACTURA_NO_EXISTE', detail: { factura_id: 4 } })
    expect(llamada('pagos_imputar_lote')).toBeUndefined()
  })

  it('sin actualizacion no imputa', async () => {
    state.profile = APROBADOR
    expect((await post('/facturas/imputar-lote', { ids: [3], concepto_id: 2, obra_cod: 'CC 1' })).status).toBe(403)
  })

  it('aprobar una sin imputar → 409 FACTURA_SIN_IMPUTAR; repartirla por PATCH → 409 con usar=imputar', async () => {
    state.profile = APROBADOR
    state.facturas = [{ id: 5, created_by: 'otro', estado: 'pendiente', sin_imputar: true }]
    const r = await post('/facturas/5/aprobar')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'FACTURA_SIN_IMPUTAR', detail: { factura_id: 5 } })
    state.profile = COMPRAS
    state.facturas = [{ id: 5, estado: 'pendiente', clase: 'factura', fecha: '2026-07-01', total: 100, sin_imputar: true }]
    const p = await patch('/facturas/5', { imputaciones: [{ obra_cod: 'CC 1', monto: 100 }] })
    expect(p.status).toBe(409)
    expect(await p.json()).toMatchObject({ error: 'FACTURA_SIN_IMPUTAR', detail: { factura_id: 5, usar: 'imputar' } })
    expect(llamada('pagos_editar_factura')).toBeUndefined()
  })
})

// ═══════════════════════ Históricas: pago a reconstruir ══════════════════════

describe('compras de meses ya pagados (pago_a_reconstruir)', () => {
  it('importar: historica viaja como p_historica (default false)', async () => {
    state.profile = IMPORTADOR
    await post('/facturas/importar-arca', { filas: [FILA] })
    expect(llamada('pagos_importar_recibidos')).toMatchObject({ p_historica: false })
    rpcMock.mockClear()
    const r = await post('/facturas/importar-arca', { filas: [FILA], historica: true, confirmar: true })
    expect(r.status).toBe(200)
    expect(llamada('pagos_importar_recibidos')).toMatchObject({ p_historica: true, p_confirmar: true })
    expect((await post('/facturas/importar-arca', { filas: [FILA], historica: 'si' })).status).toBe(400)
  })

  it('importar: periodo_iva viaja como p_periodo_iva (null si no viene) y valida el formato (20260928g)', async () => {
    state.profile = IMPORTADOR
    await post('/facturas/importar-arca', { filas: [FILA] })
    expect(llamada('pagos_importar_recibidos')).toMatchObject({ p_periodo_iva: null })
    rpcMock.mockClear()
    expect((await post('/facturas/importar-arca', { filas: [FILA], periodo_iva: '2026-07-01' })).status).toBe(200)
    expect(llamada('pagos_importar_recibidos')).toMatchObject({ p_periodo_iva: '2026-07-01' })
    rpcMock.mockClear()
    for (const malo of ['2026-07-15', '2026-13-01', '07/2026']) {
      expect((await post('/facturas/importar-arca', { filas: [FILA], periodo_iva: malo })).status).toBe(400)
    }
    expect(llamada('pagos_importar_recibidos')).toBeUndefined()
  })

  it('lista y resumen filtran pago_a_reconstruir solo si viene', async () => {
    state.profile = COMPRAS
    await pagos.request('/facturas?pago_a_reconstruir=0')
    expect(filtros).toContainEqual(['v_pagos_facturas', 'pago_a_reconstruir', false])
    filtros.length = 0
    await pagos.request('/facturas')
    expect(filtros.some((f) => f[1] === 'pago_a_reconstruir')).toBe(false)
    await pagos.request('/facturas/resumen?pago_a_reconstruir=1')
    expect(llamada('pagos_resumen')).toMatchObject({ p_pago_a_reconstruir: true })
    rpcMock.mockClear()
    await pagos.request('/facturas/resumen')
    expect(llamada('pagos_resumen')).toMatchObject({ p_pago_a_reconstruir: null })
  })

  it('«vence en 7 días» no trae las de meses ya pagados', async () => {
    state.profile = COMPRAS
    await pagos.request('/facturas?vencimiento=7')
    expect(filtros).toContainEqual(['v_pagos_facturas', 'pago_a_reconstruir', false])
  })

  it('aprobar una a reconstruir → 409 FACTURA_A_RECONSTRUIR sin RPC; la RPC también lo mapea a 409', async () => {
    state.profile = APROBADOR
    state.facturas = [{ id: 5, created_by: 'otro', estado: 'pendiente', sin_imputar: false, pago_a_reconstruir: true }]
    const r = await post('/facturas/5/aprobar')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'FACTURA_A_RECONSTRUIR', detail: { factura_id: 5 } })
    expect(llamada('pagos_aprobar_factura')).toBeUndefined()
    state.facturas = [{ id: 5, created_by: 'otro', estado: 'pendiente', sin_imputar: false, pago_a_reconstruir: false }]
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'FACTURA_A_RECONSTRUIR' } }))
    const r2 = await post('/facturas/5/aprobar')
    expect(r2.status).toBe(409)
    expect(await r2.json()).toMatchObject({ error: 'FACTURA_A_RECONSTRUIR' })
  })
})

// ═══════════════════════════════ Pagadas en lote ════════════════════════════

describe('marcar pagadas con tarjeta / billetera', () => {
  it('compras (creación) puede; ids únicos y ordenados, fecha opcional', async () => {
    state.profile = COMPRAS
    const r = await post('/facturas/marcar-pagadas', { factura_ids: [8, 2, 8], cuenta_origen_id: 4, forma_pago: 'tarjeta' })
    expect(r.status).toBe(200)
    expect(llamada('pagos_marcar_pagadas')).toEqual({ p_factura_ids: [2, 8], p_cuenta_origen_id: 4, p_forma: 'tarjeta', p_fecha: null, p_user_id: 'u-1' })
    expect((await r.json() as any).ordenes).toHaveLength(2)
  })

  it('el contador (sin creación) no; admin sí', async () => {
    state.profile = CONTADOR
    const r = await post('/facturas/marcar-pagadas', { factura_ids: [2], cuenta_origen_id: 4, forma_pago: 'otro' })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'SIN_PERMISO' })
    state.profile = ADMIN
    expect((await post('/facturas/marcar-pagadas', { factura_ids: [2], cuenta_origen_id: 4, forma_pago: 'otro', fecha: HOY })).status).toBe(200)
  })

  it('fecha futura → 400; forma fuera de tarjeta/otro → 400; más de 200 → 400', async () => {
    state.profile = COMPRAS
    const r = await post('/facturas/marcar-pagadas', { factura_ids: [2], cuenta_origen_id: 4, forma_pago: 'tarjeta', fecha: '2999-01-01' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'FECHA_FUTURA', campo: 'fecha' })
    expect((await post('/facturas/marcar-pagadas', { factura_ids: [2], cuenta_origen_id: 4, forma_pago: 'transferencia' })).status).toBe(400)
    expect((await post('/facturas/marcar-pagadas', { factura_ids: Array.from({ length: 201 }, (_, i) => i + 1), cuenta_origen_id: 4, forma_pago: 'tarjeta' })).status).toBe(400)
    expect(llamada('pagos_marcar_pagadas')).toBeUndefined()
  })

  it('errores de la RPC mapeados', async () => {
    state.profile = COMPRAS
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: 'FORMA_NO_COINCIDE_CUENTA', details: '{"cuenta_origen_id":4}' } }))
    const r = await post('/facturas/marcar-pagadas', { factura_ids: [2], cuenta_origen_id: 4, forma_pago: 'tarjeta' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'FORMA_NO_COINCIDE_CUENTA' })
  })
})

// ═══════════════════════════════ Auditoría ══════════════════════════════════

describe('auditoría de las rutas nuevas', () => {
  it('verbos y entidades', () => {
    expect(parseRoute('/api/pagos/facturas/importar-arca', 'POST')).toMatchObject({ entidad: 'factura de proveedor', accion: 'importar de ARCA' })
    expect(parseRoute('/api/pagos/facturas/12/imputar', 'POST')).toMatchObject({ entidad: 'factura de proveedor', accion: 'imputar', entidadId: '12' })
    expect(parseRoute('/api/pagos/facturas/imputar-lote', 'POST')).toMatchObject({ accion: 'imputar en lote' })
    expect(parseRoute('/api/pagos/facturas/marcar-pagadas', 'POST')).toMatchObject({ accion: 'marcar pagadas en lote' })
    expect(parseRoute('/api/pagos/facturas/marcar-pagadas', 'POST')).not.toHaveProperty('entidadId')
  })
})
