/**
 * Contabilidad tanda 5 (20260928l–r) con la base mockeada: movimientos de
 * fondos (guardias, lo que le llega a la RPC, adjuntos), asiento mensual de
 * IVA (diferencias mayor vs libros, generar sin aceptar la foto del cliente,
 * bloqueo del cierre), bienes de uso (guardias, importador puro y su vista
 * previa) y las piezas compartidas (FUENTES, config, permisos, audit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, storage, state, posicionFiscal } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  storage: {
    createSignedUploadUrl: vi.fn(),
    download: vi.fn(),
    createSignedUrl: vi.fn(),
    remove: vi.fn(),
  },
  state: { profile: null as Fila | null, tablas: {} as Record<string, unknown>, insertError: null as unknown },
  posicionFiscal: vi.fn(),
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))
vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))
vi.mock('../../../src/modules/facturacion/lid-compras.service.js', () => ({
  lidComprasService: { posicion: (...a: unknown[]) => posicionFiscal(...a) },
}))

function chain(data: unknown, error: unknown = null) {
  const obj: any = {}
  const self = () => obj
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'order', 'range', 'limit', 'update', 'delete']) obj[m] = self
  obj.insert = () => {
    const ins: any = {}
    ins.select = () => ins
    ins.single = () => Promise.resolve(state.insertError ? { data: null, error: state.insertError } : { data: { id: 77, tipo: 'vep' }, error: null })
    return ins
  }
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : 0 }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => fromMock(t),
    rpc: (n: string, a: unknown) => rpcMock(n, a),
    storage: { from: () => storage },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import ctb from '../../../src/modules/contabilidad/contabilidad.routes.js'
import { FUENTES, CursorSchema, ConfigSchema, TesMovimientoSchema, BienSchema } from '../../../src/modules/contabilidad/contabilidad.schema.js'
import { configDeFilas } from '../../../src/modules/contabilidad/automaticos.service.js'
import { movimientoParaRpc, numeroMovimiento, totalesDe } from '../../../src/modules/contabilidad/fondos.service.js'
import { pathDeMovimientoValido } from '../../../src/modules/contabilidad/fondos-adjuntos.service.js'
import { diferenciasIva, periodoDeFecha, ddjjBloqueaCierre } from '../../../src/modules/contabilidad/iva.service.js'
import { filtrarBienes, bienParaRpc } from '../../../src/modules/contabilidad/bienes.service.js'
import {
  campoDeEncabezado, parsearFecha, parsearImporte, parsearVidaUtil, bienesDeEntrada, armarVistaPreviaBienes,
} from '../../../src/modules/contabilidad/bienes-import.js'
import { STATUS_POR_CODIGO } from '../../../src/modules/contabilidad/contabilidad.errors.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body?: unknown) => ctb.request(path, body === undefined ? { method: 'POST' } : { method: 'POST', ...json(body) })
const patch = (path: string, body: unknown) => ctb.request(path, { method: 'PATCH', ...json(body) })
const del = (path: string) => ctb.request(path, { method: 'DELETE' })
const get = (path: string) => ctb.request(path)

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { contabilidad: p } : {} })
const MARIANA = perfil({
  lectura: true, creacion: true, actualizacion: true,
  tabs: ['tesoreria', 'periodos', 'bienes'],
  movimientos_fondos: true, bienes_uso: true, contabilizar: true, cerrar_periodos: true,
})
const SIN_FLAGS = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['tesoreria', 'periodos', 'bienes'] })
const SIN_TABS = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['asientos'], movimientos_fondos: true, bienes_uso: true, contabilizar: true })
const ADMIN = perfil(null, 'admin')

const FISCAL = {
  periodo: '2026-08', debito_fiscal: 1000, credito_fiscal: 400, impuesto_determinado: 600, saldo_tecnico_a_favor: 0,
  percepciones_iva: 50, retenciones_iva: 25, a_pagar: 525, libre_disponibilidad: 0, excluidos_ventas: 0, excluidos_compras: 0, avisos: [],
}
const CONTABLE = { periodo_id: 2, desde: '2026-08-01', hasta: '2026-08-31', debito_fiscal: 1000, credito_fiscal: 400, pagos_a_cuenta: 75, a_pagar: 525, estado: 'sin_generar', registro: null }
const MOV = { id: 5, numero: 12, estado: 'vigente', tipo: 'egreso' }

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  posicionFiscal.mockReset()
  for (const f of Object.values(storage)) f.mockReset()
  storage.remove.mockResolvedValue({ data: [], error: null })
  state.profile = null
  state.insertError = null
  state.tablas = {
    cont_ejercicios: [{ id: 1, nombre: '2026/27', desde: '2026-07-01', hasta: '2027-06-30', estado: 'abierto' }],
    cont_periodos: [{ id: 2, desde: '2026-08-01', hasta: '2026-08-31' }],
    v_cont_periodos: [{ id: 2, ejercicio_id: 1, numero: 2, estado: 'abierto', cant_borradores: 0 }],
    v_tesoreria_movimientos: [MOV],
    tesoreria_movimientos: [{ id: 5 }],
    tesoreria_movimientos_adjuntos: [],
    tesoreria_conceptos: [{ id: 3, nombre: 'Comisiones', sentido: 'egreso', orden: 1, activo: true, obs: '' }],
    cont_mapeos: [{ subclave: '3', cuenta_id: 40, cuenta: { codigo: '4.2.1.05.01', nombre: 'Gastos bancarios' } }],
    v_cont_bienes_uso: [
      { id: 1, codigo: 'BU-0001', descripcion: 'Camión Scania', identificador: 'AB123CD', fecha_baja: null },
      { id: 2, codigo: 'BU-0002', descripcion: 'Batea', identificador: '', fecha_baja: null },
    ],
    cont_amortizaciones: [{ id: 9, corrida_id: 4, hasta: '2026-07-31', meses: 1, importe: 100, acumulada_al_cierre: 1100, corrida: { estado: 'vigente', desde: '2026-07-01', frecuencia: 'mensual', asiento_id: 50 } }],
    cont_amortizacion_corridas: [{ id: 4, hasta: '2026-07-31', estado: 'vigente', asiento: { numero: 12 } }],
  }
  fromMock.mockImplementation((t: string) => (t === 'profiles' ? chain(state.profile) : chain(state.tablas[t] ?? [])))
  posicionFiscal.mockResolvedValue(FISCAL)
  rpcMock.mockImplementation((name: string, args: any) => {
    if (name === 'tesoreria_movimientos_listar') return chain({ total: 3, totales: { ingresos: 10, egresos: 20 }, items: [MOV] })
    if (name === 'tesoreria_guardar_movimiento') return chain({ ...MOV, ...(args.p_mov.id ? { id: args.p_mov.id } : {}) })
    if (name === 'tesoreria_anular_movimiento') return chain({ ...MOV, estado: 'anulado' })
    if (name === 'tesoreria_guardar_concepto') return chain({ id: args.p_concepto.id ?? 3, nombre: args.p_concepto.nombre, en_uso: 1 })
    if (name === 'tesoreria_conceptos_listar') return chain([{ id: 3, nombre: 'Comisiones', cuenta_id: 40, cuenta_codigo: '4.2.1.05.01', en_uso: 1 }])
    if (name === 'cont_iva_posicion') return chain(CONTABLE)
    if (name === 'cont_iva_generar') return chain({ accion: 'creado', posicion: { ...CONTABLE, estado: 'al_dia', registro: { id: 1 } } })
    if (name === 'cont_iva_estados') return chain([{ periodo_id: 2, estado: 'al_dia' }])
    if (name === 'cont_guardar_bien') return chain({ id: 7, codigo: 'BU-0007' })
    if (name === 'cont_amortizar') return chain({ frecuencia: 'mensual', tramos: [{ accion: 'creado' }, { accion: 'sin_cambios' }], total: 300 })
    if (name === 'cont_importar_bienes') {
      return chain({
        confirmado: args.p_confirmar,
        filas: args.p_filas.map((f: any) => ({ indice: f.indice, estado: 'ok', errores: [], avisos: [], resuelto: { cuenta_origen_codigo: '1.2.2.04.01' } })),
      })
    }
    if (name === 'cont_pendientes') return chain({ total: 0, resumen: { por_estado: {} } })
    if (name === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 2, estado: 'cerrado', cant_borradores: 0 }, numerados: 3 })
    return chain(null)
  })
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as any

// ═══════════════════════════════════ Piezas compartidas ══════════════════════

describe('motor, config y errores', () => {
  it('FUENTES suma tesoreria_movimientos y el cursor la acepta', () => {
    expect(FUENTES).toContain('tesoreria_movimientos')
    expect(CursorSchema.safeParse({ fecha: '2026-08-01', tabla: 'tesoreria_movimientos', id: 3 }).success).toBe(true)
  })

  it('pendientes aceptan la fuente nueva en `fuentes`', async () => {
    state.profile = ADMIN
    rpcMock.mockImplementation(() => chain({ total: 0, resumen: {}, items: [] }))
    expect((await get('/automaticos/pendientes?desde=2026-07-01&hasta=2026-07-31&fuentes=tesoreria_movimientos')).status).toBe(200)
    expect(llamada('cont_pendientes')).toMatchObject({ p_fuentes: ['tesoreria_movimientos'] })
  })

  it('ConfigSchema acepta las 4 claves nuevas y rechaza valores fuera de catálogo', () => {
    expect(ConfigSchema.safeParse({ iva_ddjj_arrastre: true, bu_frecuencia: 'anual', bu_criterio_alta: 'completo', bu_corte_inicial: '2026-06-30' }).success).toBe(true)
    expect(ConfigSchema.safeParse({ bu_frecuencia: 'semanal' }).success).toBe(false)
    expect(ConfigSchema.safeParse({ bu_corte_inicial: '2026-02-30' }).success).toBe(false)
  })

  it('configDeFilas: defaults de la tanda 5', () => {
    expect(configDeFilas([])).toMatchObject({ iva_ddjj_arrastre: false, bu_frecuencia: 'mensual', bu_criterio_alta: 'proporcional', bu_corte_inicial: '2026-06-30' })
    expect(configDeFilas([{ clave: 'iva_ddjj_arrastre', valor: true }]).iva_ddjj_arrastre).toBe(true)
  })

  it('ConfigSchema: bu_titulo_rubros es un id positivo (20260929h)', () => {
    expect(ConfigSchema.safeParse({ bu_titulo_rubros: 1111 }).data).toEqual({ bu_titulo_rubros: 1111 })
    expect(ConfigSchema.safeParse({ bu_titulo_rubros: '1111' }).data).toEqual({ bu_titulo_rubros: 1111 })
    expect(ConfigSchema.safeParse({ bu_titulo_rubros: 0 }).success).toBe(false)
    expect(ConfigSchema.safeParse({ bu_titulo_rubros: -3 }).success).toBe(false)
    expect(ConfigSchema.safeParse({ bu_titulo_rubros: 'abc' }).success).toBe(false)
    expect(ConfigSchema.safeParse({ bu_titulo_rubros: 1.5 }).success).toBe(false)
  })

  it('configDeFilas: bu_titulo_rubros como id crudo o como objeto de cont_config_json', () => {
    expect(configDeFilas([]).bu_titulo_rubros).toBeNull()
    expect(configDeFilas([{ clave: 'bu_titulo_rubros', valor: 1111 }]).bu_titulo_rubros).toEqual({ cuenta_id: 1111, codigo: null, nombre: null })
    expect(configDeFilas([{ clave: 'bu_titulo_rubros', valor: { cuenta_id: 1111, codigo: '1.2.2', nombre: 'BIENES DE USO' } }]).bu_titulo_rubros)
      .toEqual({ cuenta_id: 1111, codigo: '1.2.2', nombre: 'BIENES DE USO' })
    expect(configDeFilas([{ clave: 'bu_titulo_rubros', valor: null }]).bu_titulo_rubros).toBeNull()
  })

  it('PATCH /config manda bu_titulo_rubros a la RPC como número', async () => {
    state.profile = ADMIN
    expect((await patch('/config', { bu_titulo_rubros: '1111' })).status).toBe(200)
    expect(llamada('cont_guardar_config')).toEqual({ p_cambios: { bu_titulo_rubros: 1111 }, p_user_id: 'u-1' })
  })

  it('PATCH /config manda las claves nuevas a la RPC', async () => {
    state.profile = ADMIN
    expect((await patch('/config', { iva_ddjj_arrastre: true, bu_frecuencia: 'anual' })).status).toBe(200)
    expect(llamada('cont_guardar_config')).toEqual({ p_cambios: { iva_ddjj_arrastre: true, bu_frecuencia: 'anual' }, p_user_id: 'u-1' })
  })

  it('códigos nuevos con su status', () => {
    expect(STATUS_POR_CODIGO.SIN_PERMISO_FONDOS).toBe(403)
    expect(STATUS_POR_CODIGO.MOVIMIENTO_DE_CONCILIACION).toBe(409)
    expect(STATUS_POR_CODIGO.IVA_DIFIERE_DE_LIBROS).toBe(409)
    expect(STATUS_POR_CODIGO.IVA_NO_GENERADO).toBe(404)
    expect(STATUS_POR_CODIGO.BU_SIN_CUENTA_GASTO).toBe(400)
    expect(STATUS_POR_CODIGO.AMORTIZADOR_OCUPADO).toBe(409)
  })
})

describe('permisos: el whitelist de Admin conserva los flags nuevos', () => {
  it('movimientos_fondos y bienes_uso están en ModuloPermisosSchema', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../../src/modules/auth/usuarios.routes.ts', import.meta.url), 'utf8')
    const bloque = src.slice(src.indexOf('const ModuloPermisosSchema'), src.indexOf('const PermisosSchema'))
    expect(bloque).toMatch(/movimientos_fondos:\s+z\.boolean\(\)\.optional\(\)/)
    expect(bloque).toMatch(/bienes_uso:\s+z\.boolean\(\)\.optional\(\)/)
  })
})

// ═══════════════════════════════════ Movimientos de fondos ══════════════════

describe('fondos: schema y armado', () => {
  const base = { fecha: '2026-08-10', tesoreria_id: 1, importe: 100 }

  it('transferencia: destino obligatorio, distinto, sin concepto ni obra', () => {
    const e = (b: unknown) => (TesMovimientoSchema.safeParse(b) as any).error?.issues.map((i: any) => i.message)
    expect(e({ ...base, tipo: 'transferencia' })).toEqual(['TESORERIA_DESTINO_REQUERIDA'])
    expect(e({ ...base, tipo: 'transferencia', tesoreria_destino_id: 1 })).toEqual(['TESORERIA_IGUALES'])
    expect(e({ ...base, tipo: 'transferencia', tesoreria_destino_id: 2, concepto_id: 3, obra_cod: 'CC 1' })).toEqual(['CONCEPTO_NO_CORRESPONDE', 'OBRA_NO_CORRESPONDE'])
    expect(e({ ...base, tipo: 'egreso' })).toEqual(['CONCEPTO_REQUERIDO'])
    expect(TesMovimientoSchema.safeParse({ ...base, tipo: 'egreso', concepto_id: 3 }).success).toBe(true)
    expect(e({ ...base, tipo: 'egreso', concepto_id: 3, importe: 0 })).toEqual(['IMPORTE_INVALIDO'])
  })

  it('movimientoParaRpc: centavos, vacíos a null, transferencia sin concepto ni obra', () => {
    expect(movimientoParaRpc({ ...base, tipo: 'egreso', concepto_id: 3, importe: 10.005, obra_cod: '  ', referencia: ' VEP 1 ' } as any)).toEqual({
      fecha: '2026-08-10', tipo: 'egreso', tesoreria_id: 1, tesoreria_destino_id: null, concepto_id: 3, importe: 10.01,
      importe_destino: null, cotizacion: null, obra_cod: null, referencia: 'VEP 1', obs: '',
    })
    expect(movimientoParaRpc({ ...base, tipo: 'transferencia', tesoreria_destino_id: 2, importe_destino: 50, cotizacion: 1000 } as any, 9))
      .toMatchObject({ id: 9, tesoreria_destino_id: 2, concepto_id: null, obra_cod: null, importe_destino: 50, cotizacion: 1000 })
  })

  it('numeroMovimiento y totalesDe', () => {
    expect(numeroMovimiento(123)).toBe('MF-000123')
    expect(totalesDe({ ingresos: '10.5' })).toEqual({ ingresos: 10.5, egresos: 0, transferencias: 0 })
    expect(totalesDe(null)).toEqual({ ingresos: 0, egresos: 0, transferencias: 0 })
  })

  it('pathDeMovimientoValido', () => {
    expect(pathDeMovimientoValido(5, 'movimientos/5/abc.pdf')).toBe(true)
    expect(pathDeMovimientoValido(5, 'movimientos/51/abc.pdf')).toBe(false)
    expect(pathDeMovimientoValido(5, 'movimientos/5/../6/abc.pdf')).toBe(false)
    expect(pathDeMovimientoValido(5, 'movimientos/5/')).toBe(false)
  })
})

describe('fondos: rutas', () => {
  const mov = { fecha: '2026-08-10', tipo: 'egreso', tesoreria_id: 1, concepto_id: 3, importe: 100 }

  it('sin la tab → 403 SIN_TAB; sin el flag lee pero no escribe', async () => {
    state.profile = SIN_TABS
    const r = await get('/fondos/movimientos')
    expect(r.status).toBe(403)
    expect((await r.json() as any).error).toBe('SIN_TAB')
    state.profile = SIN_FLAGS
    expect((await get('/fondos/movimientos')).status).toBe(200)
    const w = await post('/fondos/movimientos', mov)
    expect(w.status).toBe(403)
    expect(await w.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'movimientos_fondos' } })
    expect((await post('/fondos/conceptos', { nombre: 'Otro', sentido: 'ambos' })).status).toBe(403)
    expect((await post('/fondos/movimientos/5/anular', { motivo: 'duplicado' })).status).toBe(403)
    expect(llamada('tesoreria_guardar_movimiento')).toBeUndefined()
  })

  it('listar: parámetros a la RPC, `todos` = null, página + totales', async () => {
    state.profile = MARIANA
    const r = await get('/fondos/movimientos?desde=2026-08-01&hasta=2026-08-31&tipo=egreso&tesoreria_id=4&estado=todos&limit=1')
    expect(r.status).toBe(200)
    expect(llamada('tesoreria_movimientos_listar')).toEqual({
      p_desde: '2026-08-01', p_hasta: '2026-08-31', p_tipo: 'egreso', p_tesoreria_id: 4, p_concepto_id: null, p_obra_cod: null,
      p_estado: null, p_origen: null, p_q: null, p_limit: 1, p_offset: 0,
    })
    expect(await r.json()).toEqual({ items: [MOV], total: 3, limit: 1, offset: 0, hasMore: true, totales: { ingresos: 10, egresos: 20, transferencias: 0 } })
    expect((await get('/fondos/movimientos?limit=500')).status).toBe(400)
    expect((await get('/fondos/movimientos?desde=2026-09-01&hasta=2026-08-01')).status).toBe(400)
  })

  it('crear → 201 con su user id; editar manda el id; anular manda el motivo', async () => {
    state.profile = MARIANA
    const r = await post('/fondos/movimientos', mov)
    expect(r.status).toBe(201)
    expect(llamada('tesoreria_guardar_movimiento')).toMatchObject({ p_mov: { tipo: 'egreso', concepto_id: 3, importe: 100 }, p_user_id: 'u-1' })
    rpcMock.mockClear()
    expect((await patch('/fondos/movimientos/5', mov)).status).toBe(200)
    expect(llamada('tesoreria_guardar_movimiento').p_mov.id).toBe(5)
    expect((await post('/fondos/movimientos/5/anular', { motivo: '  cargado dos veces ' })).status).toBe(200)
    expect(llamada('tesoreria_anular_movimiento')).toEqual({ p_id: 5, p_motivo: 'cargado dos veces', p_user_id: 'u-1' })
  })

  it('errores de la RPC con su status y campo', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation(() => chain(null, { code: 'P0001', message: 'COTIZACION_REQUERIDA', details: '{"campo":"cotizacion"}' }))
    const r = await post('/fondos/movimientos', mov)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'COTIZACION_REQUERIDA', campo: 'cotizacion' })
    rpcMock.mockImplementation(() => chain(null, { code: 'P0001', message: 'MOVIMIENTO_DE_CONCILIACION' }))
    expect((await patch('/fondos/movimientos/5', mov)).status).toBe(409)
  })

  it('detalle con adjuntos; inexistente → 404', async () => {
    state.profile = MARIANA
    state.tablas.tesoreria_movimientos_adjuntos = [{ id: 1, tipo: 'vep' }]
    expect(await (await get('/fondos/movimientos/5')).json()).toMatchObject({ id: 5, adjuntos: [{ id: 1, tipo: 'vep' }] })
    state.tablas.v_tesoreria_movimientos = []
    const r = await get('/fondos/movimientos/99')
    expect(r.status).toBe(404)
    expect((await r.json() as any).error).toBe('MOVIMIENTO_NO_EXISTE')
  })

  it('conceptos: en_uso y la cuenta del mapeo; PATCH completa con lo guardado', async () => {
    state.profile = MARIANA
    const b = await (await get('/fondos/conceptos?incluir_inactivos=1')).json() as any[]
    expect(b[0]).toMatchObject({ id: 3, nombre: 'Comisiones', cuenta_id: 40, cuenta_codigo: '4.2.1.05.01', en_uso: 1 })
    expect(llamada('tesoreria_conceptos_listar')).toEqual({ p_incluir_inactivos: true })
    const nuevo = await post('/fondos/conceptos', { nombre: ' Otro ', sentido: 'ambos' })
    expect(nuevo.status).toBe(201)
    expect(llamada('tesoreria_guardar_concepto')).toEqual({ p_concepto: { nombre: 'Otro', sentido: 'ambos', orden: 0, activo: true, obs: '' }, p_user_id: 'u-1' })
    rpcMock.mockClear()
    expect((await patch('/fondos/conceptos/3', { activo: false })).status).toBe(200)
    expect(llamada('tesoreria_guardar_concepto')).toEqual({
      p_concepto: { id: 3, nombre: 'Comisiones', sentido: 'egreso', orden: 1, activo: false, obs: '' }, p_user_id: 'u-1',
    })
    expect((await patch('/fondos/conceptos/3', {})).status).toBe(400)
  })

  it('adjuntos: upload-url con path del movimiento y los dos nombres; registrar hashea y 409 si se repite', async () => {
    state.profile = MARIANA
    storage.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: 'https://s/u', token: 'tk' }, error: null })
    const r = await post('/fondos/movimientos/5/adjuntos/upload-url', { nombre_archivo: 'vep.pdf', mime_type: 'application/pdf', size_bytes: 1000 })
    expect(r.status).toBe(200)
    const u = await r.json() as any
    expect(u.path).toMatch(/^movimientos\/5\/[0-9a-f-]+\.pdf$/)
    expect(u).toMatchObject({ token: 'tk', signedUrl: 'https://s/u', signed_url: 'https://s/u', storage_path: u.path })
    expect((await post('/fondos/movimientos/5/adjuntos/upload-url', { nombre_archivo: 'x.exe', mime_type: 'application/x-msdownload', size_bytes: 10 })).status).toBe(400)

    storage.download.mockResolvedValue({ data: new Blob(['hola']), error: null })
    const ok = await post('/fondos/movimientos/5/adjuntos', { tipo: 'vep', storage_path: 'movimientos/5/a.pdf', nombre_archivo: 'vep.pdf', mime_type: 'application/pdf' })
    expect(ok.status).toBe(201)
    const mal = await post('/fondos/movimientos/5/adjuntos', { tipo: 'vep', storage_path: 'movimientos/6/a.pdf', nombre_archivo: 'vep.pdf', mime_type: 'application/pdf' })
    expect((await mal.json() as any).error).toBe('PATH_INVALIDO')
    state.insertError = { code: '23505', message: 'duplicate key' }
    const dup = await post('/fondos/movimientos/5/adjuntos', { tipo: 'vep', storage_path: 'movimientos/5/b.pdf', nombre_archivo: 'vep.pdf', mime_type: 'application/pdf' })
    expect(dup.status).toBe(409)
    expect((await dup.json() as any).error).toBe('ADJUNTO_DUPLICADO')
    expect(storage.remove).toHaveBeenCalledWith(['movimientos/5/b.pdf'])
  })

  it('adjuntos: borrar pide actualización + flag', async () => {
    state.profile = SIN_FLAGS
    expect((await del('/fondos/movimientos/5/adjuntos/1')).status).toBe(403)
  })
})

// ═══════════════════════════════════ Asiento de IVA ═════════════════════════

describe('IVA: diferencias mayor vs libros', () => {
  it('coincide dentro de $0,05', () => {
    expect(diferenciasIva({ debito_fiscal: 1000.04, credito_fiscal: 400, pagos_a_cuenta: 75 }, FISCAL)).toEqual([])
  })

  it('marca débito, crédito, pagos a cuenta y excluidos', () => {
    const d = diferenciasIva({ debito_fiscal: 1100, credito_fiscal: 390, pagos_a_cuenta: 50 }, { ...FISCAL, excluidos_compras: 2 })
    expect(d).toEqual([
      { componente: 'debito', contable: 1100, fiscal: 1000, diferencia: 100 },
      { componente: 'credito', contable: 390, fiscal: 400, diferencia: -10 },
      { componente: 'pagos_a_cuenta', contable: 50, fiscal: 75, diferencia: -25 },
      { componente: 'excluidos', contable: 0, fiscal: 2, diferencia: -2 },
    ])
  })

  it('pago a cuenta ITC: compara solo si los libros lo traen (20261001b)', () => {
    expect(diferenciasIva({ debito_fiscal: 1000, credito_fiscal: 400, pagos_a_cuenta: 75, itc_mes: 90 }, FISCAL)).toEqual([])
    expect(diferenciasIva({ debito_fiscal: 1000, credito_fiscal: 400, pagos_a_cuenta: 75, itc_mes: 90 }, { ...FISCAL, pago_a_cuenta_itc: 100 }))
      .toEqual([{ componente: 'itc', contable: 90, fiscal: 100, diferencia: -10 }])
    expect(diferenciasIva({ debito_fiscal: 1000, credito_fiscal: 400, pagos_a_cuenta: 75 }, { ...FISCAL, pago_a_cuenta_itc: 0 })).toEqual([])
  })

  it('periodoDeFecha y ddjjBloqueaCierre', () => {
    expect(periodoDeFecha('2026-08-01')).toBe('2026-08')
    expect(ddjjBloqueaCierre({ estado: 'desactualizado', registro: { id: 1 } })).toBe(true)
    expect(ddjjBloqueaCierre({ estado: 'desactualizado', registro: null })).toBe(false)
    expect(ddjjBloqueaCierre({ estado: 'sin_generar', registro: null })).toBe(false)
    expect(ddjjBloqueaCierre(null)).toBe(false)
  })
})

describe('IVA: rutas', () => {
  it('posición: contable + fiscal del mes del período (con CVLP) + diferencias', async () => {
    state.profile = MARIANA
    const r = await get('/iva/2')
    expect(r.status).toBe(200)
    expect(posicionFiscal).toHaveBeenCalledWith('2026-08', true, expect.anything())
    expect(await r.json()).toMatchObject({ contable: { periodo_id: 2 }, fiscal: { periodo: '2026-08' }, diferencias: [] })
  })

  it('generar: la foto fiscal la arma el server (ignora la del body) y viaja con forzar', async () => {
    state.profile = MARIANA
    expect((await post('/iva/2/generar', { forzar: true, fiscal: { debito_fiscal: 1 } })).status).toBe(400)
    const r = await post('/iva/2/generar', { forzar: true })
    expect(r.status).toBe(200)
    expect(llamada('cont_iva_generar')).toEqual({ p_periodo_id: 2, p_fiscal: FISCAL, p_forzar: true, p_user_id: 'u-1' })
    expect(await r.json()).toMatchObject({ accion: 'creado', posicion: { contable: { estado: 'al_dia' }, diferencias: [] } })
    rpcMock.mockClear()
    expect((await post('/iva/2/generar')).status).toBe(200)
    expect(llamada('cont_iva_generar').p_forzar).toBe(false)
  })

  it('409 IVA_DIFIERE_DE_LIBROS con el detalle de la RPC', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation((n: string) => n === 'cont_iva_generar'
      ? chain(null, { code: 'P0001', message: 'IVA_DIFIERE_DE_LIBROS', details: '{"diferencias":[{"componente":"debito"}]}' })
      : chain(null))
    const r = await post('/iva/2/generar', {})
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'IVA_DIFIERE_DE_LIBROS', detail: { diferencias: [{ componente: 'debito' }] } })
  })

  it('generar y anular piden el flag contabilizar; leer, la tab periodos', async () => {
    state.profile = SIN_FLAGS
    expect((await get('/iva/2')).status).toBe(200)
    expect((await post('/iva/2/generar', {})).status).toBe(403)
    expect((await post('/iva/2/anular', { motivo: 'error de carga' })).status).toBe(403)
    state.profile = SIN_TABS
    expect((await get('/iva?ejercicio_id=1')).status).toBe(403)
  })

  it('estados del ejercicio (default el de hoy o el pedido); anular devuelve la posición', async () => {
    state.profile = MARIANA
    expect(await (await get('/iva?ejercicio_id=1')).json()).toEqual([{ periodo_id: 2, estado: 'al_dia' }])
    expect(llamada('cont_iva_estados')).toEqual({ p_ejercicio_id: 1 })
    const r = await post('/iva/2/anular', { motivo: 'se regenera' })
    expect(r.status).toBe(200)
    expect(llamada('cont_iva_anular')).toEqual({ p_periodo_id: 2, p_motivo: 'se regenera', p_user_id: 'u-1' })
  })

  it('período inexistente → 404', async () => {
    state.profile = MARIANA
    state.tablas.cont_periodos = []
    expect((await get('/iva/99')).status).toBe(404)
  })
})

describe('IVA: bloqueo del cierre de período', () => {
  it('DDJJ generada y desactualizada → 409 IVA_DDJJ_DESACTUALIZADA; forzar cierra', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation((n: string) => {
      if (n === 'cont_pendientes') return chain({ total: 0, resumen: { por_estado: {} } })
      if (n === 'cont_iva_posicion') return chain({ ...CONTABLE, estado: 'desactualizado', registro: { id: 1 } })
      if (n === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 2, estado: 'cerrado', cant_borradores: 0 }, numerados: 1 })
      return chain(null)
    })
    const r = await post('/periodos/2/cerrar')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'IVA_DDJJ_DESACTUALIZADA', detail: { periodo_id: 2 } })
    expect(llamada('cont_cerrar_periodo')).toBeUndefined()
    expect((await post('/periodos/2/cerrar', { forzar: true })).status).toBe(200)
  })

  it('pendientes + DDJJ desactualizada → un solo 409 que avisa las dos; forzar cierra igual', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation((n: string) => {
      if (n === 'cont_pendientes') return chain({ total: 4, resumen: { por_estado: { pendiente: 4 } } })
      if (n === 'cont_iva_posicion') return chain({ ...CONTABLE, estado: 'desactualizado', registro: { id: 1 } })
      if (n === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 2, estado: 'cerrado', cant_borradores: 0 }, numerados: 1 })
      return chain(null)
    })
    const r = await post('/periodos/2/cerrar')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({
      error: 'HAY_PENDIENTES_AUTOMATICOS', detail: { periodo_id: 2, cantidad: 4, iva_ddjj_desactualizada: true },
    })
    expect(llamada('cont_cerrar_periodo')).toBeUndefined()
    expect((await post('/periodos/2/cerrar', { forzar: true })).status).toBe(200)
    expect(llamada('cont_cerrar_periodo')).toEqual({ p_periodo_id: 2, p_user_id: expect.any(String) })
  })

  it('sin generar no bloquea; la RPC inexistente (migración sin aplicar) tampoco', async () => {
    state.profile = MARIANA
    expect((await post('/periodos/2/cerrar')).status).toBe(200)
    rpcMock.mockImplementation((n: string) => {
      if (n === 'cont_iva_posicion') return chain(null, { code: 'PGRST202', message: 'Could not find the function' })
      if (n === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 2, estado: 'cerrado', cant_borradores: 0 }, numerados: 1 })
      return chain(null)
    })
    expect((await post('/periodos/2/cerrar')).status).toBe(200)
  })
})

// ═══════════════════════════════════ Bienes de uso ══════════════════════════

describe('bienes: schema', () => {
  const b = { descripcion: 'Camión', cuenta_origen_id: 1, fecha_alta: '2026-07-10', valor_origen: 1000 }
  const e = (x: unknown) => (BienSchema.safeParse(x) as any).error?.issues.map((i: any) => i.message)

  it('residual, inicial y cuentas si se amortiza', () => {
    expect(BienSchema.safeParse(b).success).toBe(true)
    expect(e({ ...b, valor_residual: 1000 })).toEqual(['BU_RESIDUAL_INVALIDO'])
    expect(e({ ...b, valor_residual: 100, amort_acum_inicial: 901 })).toEqual(['BU_INICIAL_INVALIDA'])
    expect(e({ ...b, vida_util_anios: 5 })).toEqual(['BU_SIN_CUENTA_AMORT', 'BU_SIN_CUENTA_GASTO'])
    expect(e({ ...b, descripcion: 'x' })).toEqual(['DESCRIPCION_REQUERIDA'])
    expect(e({ ...b, vida_util_anios: 0, cuenta_amort_id: 2, cuenta_gasto_id: 3 })).toEqual(['VIDA_UTIL_INVALIDA'])
  })

  it('bienParaRpc y filtrarBienes', () => {
    expect(bienParaRpc({ ...b, obra_cod: ' ', valor_origen: 10.005 } as any, 3)).toMatchObject({ id: 3, obra_cod: null, valor_origen: 10.01, valor_residual: 0, amort_acum_inicial: 0, vida_util_anios: null })
    const filas = [{ codigo: 'BU-0001', descripcion: 'Camión Scania', identificador: 'AB123CD' }, { codigo: 'BU-0002', descripcion: 'Batea', identificador: '' }]
    expect(filtrarBienes(filas, 'camion').length).toBe(1)
    expect(filtrarBienes(filas, 'ab123').length).toBe(1)
    expect(filtrarBienes(filas, '').length).toBe(2)
  })
})

describe('bienes: importador puro', () => {
  it('encabezados', () => {
    expect(campoDeEncabezado('Descripción')).toEqual({ campo: 'descripcion' })
    expect(campoDeEncabezado('V.O.')).toEqual({ campo: 'valor_origen' })
    expect(campoDeEncabezado('Amortización acumulada al 30/06/2026')).toEqual({ campo: 'amort_acum_inicial' })
    expect(campoDeEncabezado('Amort. acum. inicio')).toEqual({ campo: 'amort_acum_inicial' })
    expect(campoDeEncabezado('Cuenta amortización acumulada')).toEqual({ campo: 'cuenta_amort' })
    expect(campoDeEncabezado('Cuenta amortización')).toEqual({ campo: 'cuenta_gasto' })
    expect(campoDeEncabezado('Amortización del ejercicio')).toEqual({ campo: 'control_amort_ejercicio' })
    expect(campoDeEncabezado('Valor residual contable')).toEqual({ campo: 'control_neto' })
    expect(campoDeEncabezado('Valor residual')).toEqual({ campo: 'valor_residual' })
    expect(campoDeEncabezado('Vida útil (meses)')).toEqual({ campo: 'vida_util', unidad: 'meses' })
    expect(campoDeEncabezado('Años')).toEqual({ campo: 'vida_util', unidad: 'anios' })
    expect(campoDeEncabezado('%')).toEqual({ campo: 'vida_util', unidad: 'tasa' })
    expect(campoDeEncabezado('N° serie')).toEqual({ campo: 'identificador' })
    expect(campoDeEncabezado('Centro de costo')).toEqual({ campo: 'obra' })
    expect(campoDeEncabezado('cuenta_amort')).toEqual({ campo: 'cuenta_amort' })
    expect(campoDeEncabezado('fecha_alta')).toEqual({ campo: 'fecha_alta' })
    expect(campoDeEncabezado('Color')).toBeNull()
  })

  it('fechas', () => {
    expect(parsearFecha('15/03/2021')).toBe('2021-03-15')
    expect(parsearFecha('2021-03-15')).toBe('2021-03-15')
    expect(parsearFecha('03/2021')).toBe('2021-03-01')
    expect(parsearFecha(44270)).toBe('2021-03-15')
    expect(parsearFecha('44270')).toBe('2021-03-15')
    expect(parsearFecha('31/02/2021')).toBeNull()
    expect(parsearFecha('ayer')).toBeNull()
    expect(parsearFecha('')).toBeUndefined()
  })

  it('importes', () => {
    expect(parsearImporte('$ 1.234.567,89')).toBe(1234567.89)
    expect(parsearImporte('1234567.89')).toBe(1234567.89)
    expect(parsearImporte('1,234,567.89')).toBe(1234567.89)
    expect(parsearImporte('1.234')).toBe(1234)
    expect(parsearImporte('12,5')).toBe(12.5)
    expect(parsearImporte(1500.456)).toBe(1500.46)
    expect(parsearImporte('(100)')).toBe(-100)
    expect(parsearImporte('abc')).toBeNull()
    expect(parsearImporte(null)).toBeUndefined()
  })

  it('vida útil', () => {
    expect(parsearVidaUtil(5)).toBe(5)
    expect(parsearVidaUtil('5 años')).toBe(5)
    expect(parsearVidaUtil('60 meses')).toBe(5)
    expect(parsearVidaUtil(60, 'meses')).toBe(5)
    expect(parsearVidaUtil('20%')).toBe(5)
    expect(parsearVidaUtil(20, 'tasa')).toBe(5)
    expect(parsearVidaUtil('0')).toBeNull()
    expect(parsearVidaUtil('')).toBeUndefined()
  })

  it('filas: ignora títulos y subtotales, índice del archivo, errores y avisos locales', () => {
    const csv = [
      'Descripción;Rubro;Fecha alta;Valor origen;Vida útil;Amort. acumulada;Valor residual contable;Patente',
      'RODADOS;;;;;;;',
      'Camión Scania;Rodados;15/03/2021;$ 10.000.000,00;5;5.000.000;5.000.000;AB123CD',
      'Batea;1220401;01/2022;2.000.000;60 meses;2.500.000;;',
      'TOTAL RODADOS;;;12.000.000;;;;',
      'Terreno;1.2.2.07.01;ayer;500000;;;;',
    ].join('\n')
    const { bienes, ignoradas } = bienesDeEntrada({ csv })
    expect(ignoradas).toBe(2)
    expect(bienes.map((b) => b.indice)).toEqual([2, 3, 5])
    expect(bienes[0]!.fila).toMatchObject({ descripcion: 'Camión Scania', cuenta: 'Rodados', fecha_alta: '2021-03-15', valor_origen: 10000000, vida_util_anios: 5, amort_acum_inicial: 5000000, identificador: 'AB123CD' })
    expect(bienes[0]!.errores).toEqual([])
    expect(bienes[1]!.fila).toMatchObject({ fecha_alta: '2022-01-01', vida_util_anios: 5 })
    expect(bienes[1]!.errores.map((e) => e.codigo)).toEqual(['BU_INICIAL_INVALIDA'])
    expect(bienes[2]!.errores.map((e) => e.codigo)).toEqual(['FECHA_INVALIDA'])
  })

  it('aviso si el neto del archivo no coincide', () => {
    const { bienes } = bienesDeEntrada({ filas: [{ descripcion: 'Pala', cuenta: '1.2.2.01.01', fecha_alta: '2020-01-01', valor_origen: 1000, amort_acum_inicial: 400, neto: 700 }] })
    expect(bienes[0]!.avisos).toEqual([{ codigo: 'NETO_NO_COINCIDE', campo: 'amort_acum_inicial', detalle: { archivo: 700, calculado: 600 } }])
  })

  it('vista previa: junta RPC y locales, vuelve al índice del archivo y resume', () => {
    const { bienes } = bienesDeEntrada({ filas: [
      { descripcion: 'Pala', cuenta: 'x', fecha_alta: '2020-01-01', valor_origen: 1000 },
      { descripcion: '', cuenta: 'x', fecha_alta: '2020-01-01', valor_origen: 500 },
      { descripcion: 'Grúa', cuenta: 'x', fecha_alta: '2020-01-01', valor_origen: 300, amort_acum_inicial: 100 },
    ] })
    const vp = armarVistaPreviaBienes(bienes, [
      { indice: 1, estado: 'ok', errores: [], avisos: [], resuelto: { cuenta_origen_codigo: '1.2.2.01.01' } },
      { indice: 3, estado: 'aviso', errores: [], avisos: [{ codigo: 'BIEN_DUPLICADO' }], resuelto: {} },
    ], 4)
    expect(vp.filas.map((f) => [f.indice, f.estado])).toEqual([[1, 'ok'], [2, 'error'], [3, 'aviso']])
    expect(vp.filas[0]!.resuelto).toMatchObject({ cuenta_origen_codigo: '1.2.2.01.01', descripcion: 'Pala' })
    expect(vp.resumen).toEqual({ total: 3, ok: 1, con_error: 1, con_aviso: 1, valor_origen: 1300, amort_acum_inicial: 100, ignoradas: 4 })
  })
})

describe('bienes: rutas', () => {
  const bien = { descripcion: 'Camión', cuenta_origen_id: 1, fecha_alta: '2026-07-10', valor_origen: 1000, vida_util_anios: 5, cuenta_amort_id: 2, cuenta_gasto_id: 3 }

  it('sin la tab → 403; sin el flag lee pero no escribe', async () => {
    state.profile = SIN_TABS
    expect((await get('/bienes')).status).toBe(403)
    state.profile = SIN_FLAGS
    expect((await get('/bienes')).status).toBe(200)
    expect((await post('/bienes', bien)).status).toBe(403)
    expect((await post('/bienes/amortizar', { hasta: '2026-08-31' })).status).toBe(403)
    expect((await post('/bienes/importar', { csv: 'a;b\n1;2' })).status).toBe(403)
    expect((await post('/bienes/1/revertir-baja')).status).toBe(403)
  })

  it('listar filtra por texto; literales antes de /:id', async () => {
    state.profile = MARIANA
    expect((await (await get('/bienes?q=scania')).json() as any[]).map((b) => b.id)).toEqual([1])
    rpcMock.mockImplementation((n: string) => chain(n === 'cont_bienes_cuadro' ? { filas: [], rubros: [], control_mayor: [] } : null))
    expect((await get('/bienes/cuadro?hasta=2026-08-31')).status).toBe(200)
    expect(llamada('cont_bienes_cuadro')).toEqual({ p_hasta: '2026-08-31' })
    const c = await (await get('/bienes/amortizaciones')).json() as any[]
    expect(c[0]).toMatchObject({ id: 4, asiento_numero: 12 })
    expect(c[0].asiento).toBeUndefined()
  })

  it('detalle aplana las amortizaciones', async () => {
    state.profile = MARIANA
    const b = await (await get('/bienes/1')).json() as any
    expect(b.amortizaciones[0]).toMatchObject({ id: 9, corrida_estado: 'vigente', frecuencia: 'mensual', asiento_id: 50 })
    expect(b.amortizaciones[0].corrida).toBeUndefined()
    state.tablas.v_cont_bienes_uso = []
    expect((await get('/bienes/99')).status).toBe(404)
  })

  it('crear → 201; PATCH manda el id; baja con fecha y motivo', async () => {
    state.profile = MARIANA
    const r = await post('/bienes', bien)
    expect(r.status).toBe(201)
    expect(llamada('cont_guardar_bien')).toMatchObject({ p_bien: { descripcion: 'Camión', vida_util_anios: 5 }, p_user_id: 'u-1' })
    rpcMock.mockClear()
    expect((await patch('/bienes/7', bien)).status).toBe(200)
    expect(llamada('cont_guardar_bien').p_bien.id).toBe(7)
    expect((await post('/bienes/1/baja', { fecha: '2026-08-31', motivo: 'vendido' })).status).toBe(200)
    expect(llamada('cont_baja_bien')).toEqual({ p_id: 1, p_fecha: '2026-08-31', p_motivo: 'vendido', p_user_id: 'u-1' })
  })

  it('amortizar resume los tramos; anular corrida', async () => {
    state.profile = MARIANA
    const r = await post('/bienes/amortizar', { hasta: '2026-08-31' })
    expect(await r.json()).toEqual({ frecuencia: 'mensual', tramos: [{ accion: 'creado' }, { accion: 'sin_cambios' }], total: 300 })
    expect(llamada('cont_amortizar')).toEqual({ p_hasta: '2026-08-31', p_user_id: 'u-1' })
    expect((await post('/bienes/amortizaciones/4/anular', { motivo: 'vida útil mal' })).status).toBe(200)
    expect(llamada('cont_amortizacion_anular')).toEqual({ p_corrida_id: 4, p_motivo: 'vida útil mal', p_user_id: 'u-1' })
  })

  it('importar: vista previa sin confirmar; con error local, confirmar → 422 y la RPC no confirma', async () => {
    state.profile = MARIANA
    const csv = 'Descripción;Cuenta;Fecha;Valor origen\nCamión;Rodados;15/03/2021;1.000.000\nPala;Rodados;ayer;500'
    const r = await post('/bienes/importar', { csv })
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b).toMatchObject({ confirmado: false, resumen: { total: 2, ok: 1, con_error: 1 } })
    expect(llamada('cont_importar_bienes')).toMatchObject({
      p_confirmar: false, p_user_id: 'u-1',
      p_filas: [{ indice: 1, descripcion: 'Camión', cuenta: 'Rodados', fecha_alta: '2021-03-15', valor_origen: 1000000 }, { indice: 2, fecha_alta: null }],
    })
    rpcMock.mockClear()
    const c = await post('/bienes/importar', { csv, confirmar: true })
    expect(c.status).toBe(422)
    expect((await c.json() as any).error).toBe('IMPORTACION_CON_ERRORES')
    expect(llamada('cont_importar_bienes').p_confirmar).toBe(false)
  })

  it('importar limpio confirma', async () => {
    state.profile = MARIANA
    const r = await post('/bienes/importar', { filas: [{ descripcion: 'Camión', cuenta: 'Rodados', fecha_alta: '2021-03-15', valor_origen: 1000 }], confirmar: true })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ confirmado: true, resumen: { total: 1, ok: 1 } })
  })

  it('importar sin bienes (solo títulos) → 400 SIN_FILAS', async () => {
    state.profile = MARIANA
    const r = await post('/bienes/importar', { csv: 'Descripción;Valor origen\nRODADOS;' })
    expect((await r.json() as any).error).toBe('SIN_FILAS')
  })
})

describe('parseRoute — tanda 5', () => {
  it.each([
    ['POST',   '/api/contabilidad/fondos/movimientos',                     { modulo: 'contabilidad', entidad: 'movimiento de fondos', accion: 'crear' }],
    ['PATCH',  '/api/contabilidad/fondos/movimientos/5',                   { modulo: 'contabilidad', entidad: 'movimiento de fondos', accion: 'actualizar', entidadId: '5' }],
    ['POST',   '/api/contabilidad/fondos/movimientos/5/anular',            { modulo: 'contabilidad', entidad: 'movimiento de fondos', accion: 'anular', entidadId: '5' }],
    ['POST',   '/api/contabilidad/fondos/movimientos/5/adjuntos/upload-url', { modulo: 'contabilidad', entidad: 'adjunto de movimiento de fondos', accion: 'subir adjunto', entidadId: '5' }],
    ['DELETE', '/api/contabilidad/fondos/movimientos/5/adjuntos/8',        { modulo: 'contabilidad', entidad: 'adjunto de movimiento de fondos', accion: 'eliminar', entidadId: '8' }],
    ['PATCH',  '/api/contabilidad/fondos/conceptos/3',                     { modulo: 'contabilidad', entidad: 'concepto de fondos', accion: 'actualizar', entidadId: '3' }],
    ['POST',   '/api/contabilidad/iva/2/generar',                          { modulo: 'contabilidad', entidad: 'DDJJ de IVA', accion: 'generar', entidadId: '2' }],
    ['POST',   '/api/contabilidad/iva/2/anular',                           { modulo: 'contabilidad', entidad: 'DDJJ de IVA', accion: 'anular', entidadId: '2' }],
    ['POST',   '/api/contabilidad/bienes',                                 { modulo: 'contabilidad', entidad: 'bien de uso', accion: 'crear' }],
    ['POST',   '/api/contabilidad/bienes/importar',                        { modulo: 'contabilidad', entidad: 'bien de uso', accion: 'importar' }],
    ['POST',   '/api/contabilidad/bienes/amortizar',                       { modulo: 'contabilidad', entidad: 'bien de uso', accion: 'amortizar' }],
    ['POST',   '/api/contabilidad/bienes/7/revertir-baja',                 { modulo: 'contabilidad', entidad: 'bien de uso', accion: 'revertir baja', entidadId: '7' }],
    ['POST',   '/api/contabilidad/bienes/amortizaciones/4/anular',         { modulo: 'contabilidad', entidad: 'amortización de bienes de uso', accion: 'anular', entidadId: '4' }],
  ])('%s %s', (method, path, esperado) => {
    expect(parseRoute(path, method)).toEqual(esperado)
  })
})
