/**
 * Rutas de Contabilidad con la base mockeada: guardias (flags y tabs), lo que
 * le llega a cada RPC, la partida doble que corta antes de la base, el
 * importador que mezcla errores locales y el listado de períodos con sus
 * acciones. También parseRoute (audit) y `accionesDePeriodos`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  state: { profile: null as Fila | null, tablas: {} as Record<string, unknown> },
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
  const self = () => obj
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'order', 'range', 'limit', 'update', 'insert', 'delete']) obj[m] = self
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => fromMock(t),
    rpc: (n: string, a: unknown) => rpcMock(n, a),
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import ctb from '../../../src/modules/contabilidad/contabilidad.routes.js'
import { accionesDePeriodos, ejercicioPorDefecto } from '../../../src/modules/contabilidad/periodos.service.js'
import { parseRoute } from '../../../src/middleware/audit.js'
import type { ImportarFila } from '../../../src/modules/contabilidad/plan-import.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => ctb.request(path, { method: 'POST', ...json(body) })
const patch = (path: string, body: unknown = {}) => ctb.request(path, { method: 'PATCH', ...json(body) })
const get = (path: string) => ctb.request(path)

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { contabilidad: p } : {} })
const MARIANA = perfil({
  lectura: true, creacion: true, actualizacion: true, eliminacion: false,
  tabs: ['asientos', 'diario', 'mayor', 'sumas-saldos', 'plan', 'periodos'],
  asientos_manuales: true, editar_plan: true, cerrar_periodos: false,
})
const LECTOR = perfil({ lectura: true, tabs: ['diario', 'mayor'] })
const ADMIN = perfil(null, 'admin')

const ASIENTO = { id: 5, estado: 'confirmado', periodo_estado: 'abierto', lineas: [] }
const PERIODOS = [
  { id: 1, ejercicio_id: 1, numero: 1, estado: 'cerrado', cant_borradores: 0 },
  { id: 2, ejercicio_id: 1, numero: 2, estado: 'abierto', cant_borradores: 2 },
  { id: 3, ejercicio_id: 1, numero: 3, estado: 'abierto', cant_borradores: 0 },
]

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  state.profile = null
  state.tablas = {
    cont_ejercicios: [{ id: 1, nombre: '2026/27', desde: '2026-07-01', hasta: '2027-06-30', estado: 'abierto' }],
    v_cont_periodos: PERIODOS,
    v_cont_cuentas: [{ id: 9, codigo: '1.1', nombre: 'Caja', rubro: 'activo', imputable: true, auxiliar: 'none', activo: true, obs: '' }],
  }
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile)
    return chain(state.tablas[t] ?? [])
  })
  rpcMock.mockImplementation((name: string, args: any) => {
    if (name === 'cont_guardar_asiento' || name === '_cont_asiento_json') return chain(ASIENTO)
    if (name === 'cont_listar_asientos') return chain({ total: 120, items: [{ id: 1 }, { id: 2 }] })
    if (name === 'cont_guardar_cuenta') return chain({ id: 9 })
    if (name === 'cont_importar_plan') {
      return chain({
        confirmado: args.p_confirmar, total_filas: args.p_filas.length, nuevas: args.p_filas.length, duplicadas: 0, errores: 0,
        filas: args.p_filas.map((f: any, i: number) => ({ indice: i + 1, estado: 'nueva', error: null, detalle: null, ...f, nivel: 1, padre_codigo: null, cuenta_id: null })),
      })
    }
    if (name === 'cont_abrir_ejercicio_siguiente') {
      return chain({ ejercicio: { id: 2, nombre: '2027/28', desde: '2027-07-01', hasta: '2028-06-30', estado: 'abierto' }, periodos: 12 })
    }
    if (name === 'cont_cerrar_periodo') return chain({ periodo: PERIODOS[1], numerados: 4, desde_numero: 1, hasta_numero: 4 })
    if (name === 'cont_libro_diario') return chain({ total_asientos: 3, total_debe: 1, total_haber: 1, items: [{}, {}, {}] })
    return chain(null)
  })
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as Fila | undefined
const lineas = [{ cuenta_id: 1, debe: 100.004, haber: 0 }, { cuenta_id: 2, debe: 0, haber: 100, aux_id: 3, obra_cod: 'CC 24' }]

describe('asientos', () => {
  it('Mariana crea: montos a centavos, líneas en orden y su user id', async () => {
    state.profile = MARIANA
    const r = await post('/asientos', { fecha: '2026-08-10', glosa: 'Pago luz', estado: 'confirmado', lineas })
    expect(r.status).toBe(200)
    expect(llamada('cont_guardar_asiento')).toEqual({
      p_asiento: { fecha: '2026-08-10', tipo: 'manual', glosa: 'Pago luz', estado: 'confirmado' },
      p_lineas: [
        { cuenta_id: 1, debe: 100, haber: 0, aux_id: null, obra_cod: null, glosa: '' },
        { cuenta_id: 2, debe: 0, haber: 100, aux_id: 3, obra_cod: 'CC 24', glosa: '' },
      ],
      p_user_id: 'u-1',
    })
  })

  it('PATCH manda el id', async () => {
    state.profile = MARIANA
    expect((await patch('/asientos/5', { fecha: '2026-08-10', glosa: 'Pago luz', estado: 'borrador', lineas: [lineas[0]] })).status).toBe(200)
    expect(llamada('cont_guardar_asiento')).toMatchObject({ p_asiento: { id: 5, estado: 'borrador' } })
  })

  it('confirmado desbalanceado → 422 sin tocar la base', async () => {
    state.profile = MARIANA
    const r = await post('/asientos', { fecha: '2026-08-10', glosa: 'Pago luz', estado: 'confirmado', lineas: [{ cuenta_id: 1, debe: 100 }, { cuenta_id: 2, haber: 90 }] })
    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: 'ASIENTO_DESBALANCEADO', campo: 'lineas', detail: { campo: 'lineas', debe: 100, haber: 90, diferencia: 10 } })
    expect(llamada('cont_guardar_asiento')).toBeUndefined()
  })

  it('error de línea de la RPC → campo lineas.N.campo', async () => {
    state.profile = MARIANA
    rpcMock.mockResolvedValue({ data: null, error: { message: 'CUENTA_NO_IMPUTABLE', code: 'P0001', details: '{"indice":0,"campo":"cuenta_id"}' } })
    const r = await post('/asientos', { fecha: '2026-08-10', glosa: 'Pago luz', estado: 'borrador', lineas: [lineas[0]] })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'CUENTA_NO_IMPUTABLE', campo: 'lineas.0.cuenta_id' })
  })

  it('sin el flag asientos_manuales → 403; el lector abre la ficha desde el diario pero no lista', async () => {
    state.profile = LECTOR
    expect((await post('/asientos', { fecha: '2026-08-10', glosa: 'Pago luz', estado: 'borrador', lineas })).status).toBe(403)
    expect((await get('/asientos/5')).status).toBe(200)
    const r = await get('/asientos')
    expect(r.status).toBe(403)
    expect((await r.json() as any).error).toBe('SIN_TAB')
  })

  it('ficha inexistente → 404', async () => {
    state.profile = ADMIN
    rpcMock.mockImplementation(() => chain(null))
    const r = await get('/asientos/77')
    expect(r.status).toBe(404)
    expect((await r.json() as any).error).toBe('ASIENTO_NO_EXISTE')
  })

  it('listado → CtbPage', async () => {
    state.profile = MARIANA
    const r = await get('/asientos?estado=borrador&limit=2&offset=10&cuenta_id=4')
    expect(await r.json()).toEqual({ items: [{ id: 1 }, { id: 2 }], total: 120, limit: 2, offset: 10, hasMore: true })
    expect(llamada('cont_listar_asientos')).toMatchObject({ p_estado: 'borrador', p_cuenta_id: 4, p_limit: 2, p_offset: 10, p_q: null })
  })

  it('anular manda motivo y fecha', async () => {
    state.profile = MARIANA
    expect((await post('/asientos/5/anular', { motivo: 'duplicado', fecha: '2026-09-01' })).status).toBe(200)
    expect(llamada('cont_anular_asiento')).toEqual({ p_id: 5, p_motivo: 'duplicado', p_user_id: 'u-1', p_fecha: '2026-09-01' })
    const r = await post('/asientos/5/anular', { motivo: 'x' })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('MOTIVO_REQUERIDO')
  })

  it('id inválido → 400 ID_INVALIDO', async () => {
    state.profile = ADMIN
    expect((await get('/asientos/abc')).status).toBe(400)
  })
})

describe('períodos', () => {
  it('lista con puede_cerrar/bloqueo_*', async () => {
    state.profile = MARIANA
    const body = await (await get('/periodos')).json() as any[]
    expect(body.map((p) => [p.id, p.bloqueo_cerrar, p.bloqueo_reabrir])).toEqual([
      [1, 'PERIODO_YA_CERRADO', null],
      [2, 'HAY_BORRADORES', 'PERIODO_NO_CERRADO'],
      [3, 'PERIODO_ANTERIOR_ABIERTO', 'PERIODO_NO_CERRADO'],
    ])
  })

  it('cerrar pide cerrar_periodos (Mariana no lo tiene); admin sí y el período vuelve con acciones', async () => {
    state.profile = MARIANA
    expect((await post('/periodos/2/cerrar')).status).toBe(403)
    state.profile = ADMIN
    const r = await post('/periodos/2/cerrar')
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b).toMatchObject({ numerados: 4, periodo: { id: 2, puede_cerrar: false, bloqueo_cerrar: 'HAY_BORRADORES' } })
  })

  it('abrir el ejercicio siguiente pide cerrar_periodos; admin lo abre con su user id', async () => {
    state.profile = MARIANA
    expect((await post('/ejercicios/siguiente')).status).toBe(403)
    expect(llamada('cont_abrir_ejercicio_siguiente')).toBeUndefined()
    state.profile = ADMIN
    const r = await post('/ejercicios/siguiente')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ejercicio: { nombre: '2027/28' }, periodos: 12 })
    expect(llamada('cont_abrir_ejercicio_siguiente')).toEqual({ p_user_id: 'u-1' })
  })

  it('abrir el siguiente cuando ya existe → 409 EJERCICIO_SIGUIENTE_YA_EXISTE', async () => {
    state.profile = ADMIN
    rpcMock.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'P0001', message: 'EJERCICIO_SIGUIENTE_YA_EXISTE', details: '{"nombre":"2027/28"}' } }))
    const r = await post('/ejercicios/siguiente')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'EJERCICIO_SIGUIENTE_YA_EXISTE', detail: { nombre: '2027/28' } })
  })

  it('ejercicio inexistente → 404', async () => {
    state.profile = ADMIN
    expect((await get('/periodos?ejercicio_id=99')).status).toBe(404)
  })
})

describe('plan de cuentas', () => {
  it('importar: imputable ilegible marca la fila y la vista previa no confirma', async () => {
    state.profile = MARIANA
    const csv = 'codigo;nombre;rubro;imputable\n1;ACTIVO;A;N\n1.1;Caja;A;quizás'
    const r = await post('/cuentas/importar', { csv })
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b.errores).toBe(1)
    expect(b.filas[1]).toMatchObject({ estado: 'error', error: 'IMPUTABLE_INVALIDO' })
    expect(llamada('cont_importar_plan')).toMatchObject({
      p_confirmar: false,
      p_filas: [
        { codigo: '1', nombre: 'ACTIVO', rubro: 'activo', imputable: false, auxiliar: null },
        { codigo: '1.1', nombre: 'Caja', rubro: 'activo', imputable: null, auxiliar: null },
      ],
    })
  })

  it('importar confirmando con error local → 422 y la RPC NO confirma', async () => {
    state.profile = MARIANA
    const r = await post('/cuentas/importar', { filas: [{ codigo: '1.1', nombre: 'Caja', imputable: 'quizás' }], confirmar: true })
    expect(r.status).toBe(422)
    expect((await r.json() as any).error).toBe('IMPORTACION_CON_ERRORES')
    expect(llamada('cont_importar_plan')).toMatchObject({ p_confirmar: false })
  })

  it('importar formato Finnegans: convierte, no manda las deshabilitadas y devuelve el código original', async () => {
    state.profile = MARIANA
    const csv = 'codigo;descripcion;nivel;cuenta_madre;imputable;capitulo;saldo_normal;habilitada\n'
      + '1000000;ACTIVO;1;;NO;ACTIVO;DEUDOR;SI\n1100000;VIEJA;2;1000000;NO;ACTIVO;DEUDOR;NO\n1200000;NO CORRIENTE;2;1000000;NO;ACTIVO;DEUDOR;SI'
    const r = await post('/cuentas/importar', { csv })
    expect(r.status).toBe(200)
    expect(llamada('cont_importar_plan')).toMatchObject({
      p_filas: [
        { codigo: '1', nombre: 'ACTIVO', rubro: 'activo', imputable: false, auxiliar: null },
        { codigo: '1.2', nombre: 'NO CORRIENTE', rubro: 'activo', imputable: false, auxiliar: null },
      ],
    })
    const b = await r.json() as { filas: ImportarFila[] }
    expect(b).toMatchObject({ formato: 'finnegans', total_filas: 3, nuevas: 2, omitidas: 1, errores: 0 })
    expect(b.filas.map((f) => [f.indice, f.codigo, f.codigo_original, f.estado])).toEqual([
      [1, '1', '1000000', 'nueva'], [2, '1.1', '1100000', 'omitida'], [3, '1.2', '1200000', 'nueva'],
    ])
  })

  it('IMPORTACION_CON_ERRORES de la RPC vuelve con los índices del archivo', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation(() => Promise.resolve({ data: null, error: {
      code: 'P0001', message: 'IMPORTACION_CON_ERRORES',
      details: JSON.stringify({ errores: [{ indice: 2, estado: 'error', error: 'PADRE_IMPUTABLE', detalle: { padre_codigo: '1' }, codigo: '1.2' }] }),
    } }))
    const csv = 'codigo;descripcion;nivel;cuenta_madre;imputable;capitulo;saldo_normal;habilitada\n'
      + '1000000;ACTIVO;1;;SI;ACTIVO;DEUDOR;SI\n1100000;VIEJA;2;1000000;NO;ACTIVO;DEUDOR;NO\n1200000;NO CORRIENTE;2;1000000;NO;ACTIVO;DEUDOR;SI'
    const r = await post('/cuentas/importar', { csv, confirmar: true })
    expect(r.status).toBe(422)
    expect((await r.json() as { detail: { errores: ImportarFila[] } }).detail.errores).toEqual([expect.objectContaining({ indice: 3, codigo: '1.2', codigo_original: '1200000', error: 'PADRE_IMPUTABLE' })])
  })

  it('importar limpio confirma', async () => {
    state.profile = MARIANA
    expect((await post('/cuentas/importar', { csv: 'codigo;nombre\n1;ACTIVO', confirmar: true })).status).toBe(200)
    expect(llamada('cont_importar_plan')).toMatchObject({ p_confirmar: true })
  })

  it('crear cuenta → RPC y relee de la vista; duplicado → 409 CODIGO_DUPLICADO', async () => {
    state.profile = MARIANA
    const r = await post('/cuentas', { codigo: '1.1', nombre: 'Caja', imputable: true })
    expect(r.status).toBe(200)
    expect((await r.json() as any).id).toBe(9)
    expect(llamada('cont_guardar_cuenta')).toEqual({
      p_cuenta: { codigo: '1.1', nombre: 'Caja', rubro: null, imputable: true, auxiliar: 'none', obs: '' }, p_user_id: 'u-1',
    })
    rpcMock.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "cont_cuentas_codigo_key"' } })
    const r2 = await post('/cuentas', { codigo: '1.1', nombre: 'Caja', imputable: true })
    expect(r2.status).toBe(409)
    expect((await r2.json() as any).error).toBe('CODIGO_DUPLICADO')
  })

  it('PATCH completa con lo guardado', async () => {
    state.profile = MARIANA
    expect((await patch('/cuentas/9', { nombre: 'Caja en pesos' })).status).toBe(200)
    expect(llamada('cont_guardar_cuenta')).toMatchObject({
      p_cuenta: { id: 9, codigo: '1.1', nombre: 'Caja en pesos', rubro: 'activo', imputable: true, auxiliar: 'none' },
    })
  })

  it('código inválido → 400 CODIGO_INVALIDO en el campo', async () => {
    state.profile = MARIANA
    const r = await post('/cuentas', { codigo: '1.1234', nombre: 'Caja', imputable: true })
    expect(await r.json()).toMatchObject({ error: 'CODIGO_INVALIDO', campo: 'codigo' })
  })

  it('borrar pide eliminacion (Mariana no la tiene)', async () => {
    state.profile = MARIANA
    expect((await ctb.request('/cuentas/9', { method: 'DELETE' })).status).toBe(403)
  })

  it('el lector no edita el plan', async () => {
    state.profile = LECTOR
    expect((await post('/cuentas', { codigo: '1.1', nombre: 'Caja', imputable: true })).status).toBe(403)
    expect((await get('/cuentas')).status).toBe(200)
  })
})

describe('reportes', () => {
  it('diario con hasMore', async () => {
    state.profile = MARIANA
    const b = await (await get('/diario?desde=2026-07-01&hasta=2026-07-31&limit=3')).json() as any
    expect(b).toMatchObject({ total_asientos: 3, limit: 3, offset: 0, hasMore: false })
  })

  it('rango invertido → 400 RANGO_INVALIDO', async () => {
    state.profile = MARIANA
    const r = await get('/diario?desde=2026-08-01&hasta=2026-07-31')
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('RANGO_INVALIDO')
  })

  it('mayor exige cuenta_id', async () => {
    state.profile = MARIANA
    expect((await get('/mayor?desde=2026-07-01&hasta=2026-07-31')).status).toBe(400)
  })

  it('sumas y saldos: nivel y sin movimiento', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation(() => chain({ cuadra: true, items: [] }))
    expect((await get('/sumas-saldos?desde=2026-07-01&hasta=2026-07-31&nivel=2&incluir_sin_movimiento=1')).status).toBe(200)
    expect(llamada('cont_sumas_saldos')).toEqual({ p_desde: '2026-07-01', p_hasta: '2026-07-31', p_nivel: 2, p_incluir_sin_movimiento: true })
  })
})

describe('tanda 4: circuitos, diario resumido y estados', () => {
  const CONTADORA = perfil({
    lectura: true, creacion: true, actualizacion: true,
    tabs: ['diario', 'sumas-saldos', 'estados', 'automaticos'],
  })

  it('pendientes: `fuentes` CSV viaja como p_fuentes; inválida → 400', async () => {
    state.profile = CONTADORA
    rpcMock.mockImplementation(() => chain({ total: 0, resumen: { por_estado: {}, por_fuente: {}, por_motivo: [] }, items: [] }))
    const r = await get('/automaticos/pendientes?desde=2026-07-01&hasta=2026-07-31&fuentes=ventas_facturas,ventas_comprobantes_externos')
    expect(r.status).toBe(200)
    expect(llamada('cont_pendientes')).toMatchObject({ p_fuentes: ['ventas_facturas', 'ventas_comprobantes_externos'] })
    rpcMock.mockClear()
    await get('/automaticos/pendientes?desde=2026-07-01&hasta=2026-07-31')
    expect(llamada('cont_pendientes')).toMatchObject({ p_fuentes: null })
    expect((await get('/automaticos/pendientes?desde=2026-07-01&hasta=2026-07-31&fuentes=otra_tabla')).status).toBe(400)
  })

  it('diario: modo mes despacha al resumido con hasMore sobre total_items', async () => {
    state.profile = CONTADORA
    rpcMock.mockImplementation((n: string) => n === 'cont_libro_diario_resumido'
      ? chain({ total_items: 5, total_asientos: 400, items: [{}, {}] })
      : chain({ total_asientos: 3, items: [{}, {}, {}] }))
    const b = await (await get('/diario?desde=2026-07-01&hasta=2026-09-30&modo=mes&limit=2')).json() as any
    expect(llamada('cont_libro_diario_resumido')).toEqual({ p_desde: '2026-07-01', p_hasta: '2026-09-30', p_agrupar: 'mes', p_limit: 2, p_offset: 0 })
    expect(b).toMatchObject({ modo: 'mes', total_items: 5, hasMore: true })
    expect(llamada('cont_libro_diario')).toBeUndefined()
    const d = await (await get('/diario?desde=2026-07-01&hasta=2026-07-31')).json() as any
    expect(d.modo).toBe('detallado')
    expect((await get('/diario?desde=2026-07-01&hasta=2026-07-31&modo=semana')).status).toBe(400)
  })

  it('estados: sin la tab → 403 SIN_TAB; con la tab llegan los parámetros', async () => {
    state.profile = MARIANA
    const r = await get('/estados/balance?fecha=2026-09-30')
    expect(r.status).toBe(403)
    expect((await r.json() as any).error).toBe('SIN_TAB')

    state.profile = CONTADORA
    rpcMock.mockImplementation(() => chain({ cuadra: true }))
    expect((await get('/estados/balance?fecha=2026-09-30&incluir_cero=1')).status).toBe(200)
    expect(llamada('cont_balance')).toEqual({ p_fecha: '2026-09-30', p_nivel: 3, p_incluir_cero: true })
    expect((await get('/estados/resultados?desde=2026-07-01&hasta=2026-09-30&comparativo=1&nivel=2')).status).toBe(200)
    expect(llamada('cont_estado_resultados')).toEqual({ p_desde: '2026-07-01', p_hasta: '2026-09-30', p_nivel: 2, p_comparativo: true, p_incluir_cero: false })
    expect((await get('/estados/balance?fecha=2026-09-30&nivel=9')).status).toBe(400)
    const inv = await get('/estados/resultados?desde=2026-09-30&hasta=2026-07-01')
    expect((await inv.json() as any).error).toBe('RANGO_INVALIDO')
  })

  it('admin pasa sin tabs', async () => {
    state.profile = ADMIN
    rpcMock.mockImplementation(() => chain({ cuadra: true }))
    expect((await get('/estados/balance?fecha=2026-09-30')).status).toBe(200)
  })
})

describe('tesorería', () => {
  it('CBU con verificadores inválidos → 400 CBU_INVALIDO; caja con CBU → 400', async () => {
    state.profile = MARIANA
    const r = await post('/tesoreria', { tipo: 'banco', nombre: 'Galicia', cbu: '1234567890123456789012' })
    expect(await r.json()).toMatchObject({ error: 'CBU_INVALIDO', campo: 'cbu' })
    expect((await post('/tesoreria', { tipo: 'caja', nombre: 'Caja', cbu: '1234567890123456789012' })).status).toBe(400)
  })

  it('lista aplana la cuenta contable', async () => {
    state.profile = MARIANA
    state.tablas.tesoreria_cuentas = [{ id: 1, tipo: 'caja', nombre: 'Caja en pesos', cuenta_id: 9, cuenta: { codigo: '1.1', nombre: 'Caja' } }]
    const b = await (await get('/tesoreria')).json() as any[]
    expect(b[0]).toMatchObject({ id: 1, cuenta_codigo: '1.1', cuenta_nombre: 'Caja' })
    expect(b[0].cuenta).toBeUndefined()
  })
})

describe('accionesDePeriodos', () => {
  const P = (numero: number, estado: 'abierto' | 'cerrado', cant_borradores = 0) => ({ id: numero, ejercicio_id: 1, numero, estado, cant_borradores })

  it('solo el último cerrado se reabre; solo el primero abierto sin borradores se cierra', () => {
    const r = accionesDePeriodos([P(3, 'abierto'), P(1, 'cerrado'), P(2, 'cerrado')], false)
    expect(r.map((p) => [p.numero, p.puede_cerrar, p.bloqueo_cerrar, p.puede_reabrir, p.bloqueo_reabrir])).toEqual([
      [1, false, 'PERIODO_YA_CERRADO', false, 'PERIODO_POSTERIOR_CERRADO'],
      [2, false, 'PERIODO_YA_CERRADO', true, null],
      [3, true, null, false, 'PERIODO_NO_CERRADO'],
    ])
  })

  it('ejercicio cerrado bloquea todo', () => {
    const r = accionesDePeriodos([P(1, 'abierto'), P(2, 'cerrado')], true)
    expect(r[0]!.bloqueo_cerrar).toBe('EJERCICIO_CERRADO')
    expect(r[1]!.bloqueo_reabrir).toBe('EJERCICIO_CERRADO')
  })

  it('ejercicioPorDefecto: el de hoy o el último', () => {
    const E = [
      { id: 1, nombre: '2026/27', desde: '2026-07-01', hasta: '2027-06-30', estado: 'abierto' as const },
      { id: 2, nombre: '2027/28', desde: '2027-07-01', hasta: '2028-06-30', estado: 'abierto' as const },
    ]
    expect(ejercicioPorDefecto(E, '2026-09-24')!.id).toBe(1)
    expect(ejercicioPorDefecto(E, '2030-01-01')!.id).toBe(2)
    expect(ejercicioPorDefecto([], '2026-09-24')).toBeNull()
  })
})

describe('parseRoute — módulo contabilidad', () => {
  it.each([
    ['POST',   '/api/contabilidad/asientos',                { modulo: 'contabilidad', entidad: 'asiento contable', accion: 'crear' }],
    ['PATCH',  '/api/contabilidad/asientos/5',              { modulo: 'contabilidad', entidad: 'asiento contable', accion: 'actualizar', entidadId: '5' }],
    ['DELETE', '/api/contabilidad/asientos/5',              { modulo: 'contabilidad', entidad: 'asiento contable', accion: 'eliminar', entidadId: '5' }],
    ['POST',   '/api/contabilidad/asientos/5/anular',       { modulo: 'contabilidad', entidad: 'asiento contable', accion: 'anular', entidadId: '5' }],
    ['POST',   '/api/contabilidad/periodos/3/cerrar',       { modulo: 'contabilidad', entidad: 'período contable', accion: 'cerrar', entidadId: '3' }],
    ['POST',   '/api/contabilidad/periodos/3/reabrir',      { modulo: 'contabilidad', entidad: 'período contable', accion: 'reabrir', entidadId: '3' }],
    ['POST',   '/api/contabilidad/ejercicios/siguiente',    { modulo: 'contabilidad', entidad: 'ejercicio contable', accion: 'abrir el siguiente' }],
    ['POST',   '/api/contabilidad/cuentas/importar',        { modulo: 'contabilidad', entidad: 'cuenta contable', accion: 'importar' }],
    ['POST',   '/api/contabilidad/cuentas/9/baja',          { modulo: 'contabilidad', entidad: 'cuenta contable', accion: 'dar de baja', entidadId: '9' }],
    ['POST',   '/api/contabilidad/cuentas/9/alta',          { modulo: 'contabilidad', entidad: 'cuenta contable', accion: 'dar de alta', entidadId: '9' }],
    ['POST',   '/api/contabilidad/tesoreria',               { modulo: 'contabilidad', entidad: 'cuenta de tesorería', accion: 'crear' }],
    ['PATCH',  '/api/contabilidad/tesoreria/2',             { modulo: 'contabilidad', entidad: 'cuenta de tesorería', accion: 'actualizar', entidadId: '2' }],
  ])('%s %s', (method, path, esperado) => {
    expect(parseRoute(path, method)).toEqual(esperado)
  })
})
