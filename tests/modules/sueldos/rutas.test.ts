/**
 * Rutas de Sueldos con la base mockeada: guardias (flags y tabs), PII
 * enmascarada, lo que le llega a cada RPC, el mapeo de errores de la base,
 * «Generar recibos» con horas de tarja y préstamos, y la auditoría.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { valoresUocra } from './fixtures.js'

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
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => fromMock(t),
    rpc: (n: string, a: unknown) => rpcMock(n, a),
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import sue from '../../../src/modules/sueldos/sueldos.routes.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => sue.request(path, { method: 'POST', ...json(body) })
const put = (path: string, body: unknown = {}) => sue.request(path, { method: 'PUT', ...json(body) })
const get = (path: string) => sue.request(path)

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { sueldos: p } : {} })
const LIQUIDADOR = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['legajos', 'liquidaciones', 'exportar'], liquidar: true })
const LECTOR = perfil({ lectura: true, tabs: ['legajos', 'liquidaciones', 'exportar'] })
const ADMIN = perfil(null, 'admin')

const LEGAJO = {
  id: 1, leg: '112', chofer_id: null, nombre: '', nombre_mostrar: 'Pérez Juan', cuil: '20123456786', cbu: '2850590940090418135201',
  dni: '12345678', convenio_id: 1, categoria_id: 11, zona: 'A', fecha_ingreso: '2026-03-01', fecha_egreso: null,
  afiliado_sindicato: true, rifl: false, titulo_nivel: null, activo: true, obra_social_codigo: '', conyuge_a_cargo: false,
  hijos_a_cargo: 0, modalidad_contratacion: 'tiempo_indeterminado', categoria_nombre: 'Oficial', incompleto: false, faltantes: [],
}
const LIQ = { id: 5, codigo: 'LIQ-0005', numero: 5, convenio_id: 1, tipo: 'quincena', periodo: '2026-09-01', quincena: 2, fecha_pago: '2026-10-05', estado: 'borrador' }

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  state.profile = null
  state.tablas = {
    v_sueldos_legajos: [LEGAJO],
    sueldos_liquidaciones: [LIQ],
    sueldos_recibos: [],
    horas: [
      { id: 1, leg: '112', fecha: '2026-09-16', obra_cod: 'CC-020', horas: 9 },
      { id: 2, leg: '112', fecha: '2026-09-17', obra_cod: 'CC-020', horas: 9 },
    ],
    prestamos: [
      { id: 1, leg: '112', tipo: 'otorgado', monto: 100000 },
      { id: 2, leg: '112', tipo: 'descontado', monto: 40000 },
    ],
  }
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile)
    return chain(state.tablas[t] ?? [])
  })
  rpcMock.mockImplementation((n: string, a: any) => {
    if (n === 'sueldos_valores_a_fecha') return Promise.resolve({ data: valoresUocra(a.p_fecha), error: null })
    if (n === 'sueldos_guardar_recibo') return Promise.resolve({ data: { id: 77, legajo_id: a.p_legajo_id, snapshot: a.p_recibo.snapshot, lineas: a.p_lineas }, error: null })
    if (n === 'sueldos_liquidacion_json') return Promise.resolve({ data: { ...LIQ, convenio: { codigo: 'uocra', nombre: 'UOCRA' }, recibos: [] }, error: null })
    return Promise.resolve({ data: { ok: true }, error: null })
  })
})

describe('guardias', () => {
  it('sin lectura → 403', async () => {
    state.profile = perfil({ lectura: false })
    expect((await get('/convenios')).status).toBe(403)
  })
  it('configurar: sin el flag no se escribe la configuración', async () => {
    state.profile = perfil({ lectura: true, tabs: ['convenios'] })
    const r = await post('/escalas', { categoria_id: 11, vigente_desde: '2026-12-01', valor: 7000 })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'SIN_PERMISO', detail: { flag: 'configurar' } })
    expect(rpcMock).not.toHaveBeenCalled()
  })
  it('configurar sin la tab convenios → SIN_TAB', async () => {
    state.profile = perfil({ lectura: true, tabs: ['legajos'], configurar: true })
    const r = await post('/escalas/paritaria', { convenio_id: 1, desde: '2026-12-01', porcentaje: 2 })
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('SIN_TAB')
  })
  it('liquidar: crear liquidación sin el flag → 403', async () => {
    state.profile = LECTOR
    expect((await post('/liquidaciones', { convenio_id: 1, tipo: 'mensual', periodo: '2026-09-01' })).status).toBe(403)
  })
  it('cerrar pide cerrar_liquidaciones', async () => {
    state.profile = LIQUIDADOR
    expect((await post('/liquidaciones/5/cerrar')).status).toBe(403)
    state.profile = perfil({ lectura: true, tabs: ['liquidaciones'], cerrar_liquidaciones: true })
    expect((await post('/liquidaciones/5/cerrar')).status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('sueldos_cerrar_liquidacion', { p_id: 5, p_user_id: 'u-1' })
  })
  it('exportar banco y LSD piden ver_pii', async () => {
    state.profile = LECTOR
    expect((await get('/liquidaciones/5/exportar/banco')).status).toBe(403)
    expect((await get('/liquidaciones/5/exportar/lsd')).status).toBe(403)
  })
})

describe('legajos y PII', () => {
  it('sin ver_pii el CUIL, el CBU y el DNI salen enmascarados', async () => {
    state.profile = LECTOR
    const [l] = await (await get('/legajos')).json()
    expect(l.cuil).toBe('***6786')
    expect(l.cbu).toBe('***5201')
    expect(l.dni).toBe('***5678')
  })
  it('admin los ve completos', async () => {
    state.profile = ADMIN
    const [l] = await (await get('/legajos')).json()
    expect(l.cuil).toBe('20123456786')
  })
  it('cambiar el CUIL sin ver_pii → 403 SIN_PERMISO_PII sin llamar a la base', async () => {
    state.profile = LIQUIDADOR
    const r = await sue.request('/legajos/1', { method: 'PATCH', ...json({ cuil: '20-12345678-6' }) })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'SIN_PERMISO_PII', campo: 'cuil' })
    expect(rpcMock).not.toHaveBeenCalled()
  })
  it('CUIL con dígito verificador inválido → 400 CUIL_INVALIDO', async () => {
    state.profile = ADMIN
    const r = await post('/legajos', { leg: '112', convenio_id: 1, cuil: '20123456787' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'CUIL_INVALIDO', campo: 'cuil' })
  })
  it('alta desde un legajo de Personal: la RPC recibe el CUIL normalizado', async () => {
    state.profile = ADMIN
    const r = await post('/legajos', { leg: '112', convenio_id: 1, cuil: '20-12345678-6', afiliado_sindicato: true })
    expect(r.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('sueldos_guardar_legajo', {
      p_legajo: { leg: '112', convenio_id: 1, cuil: '20123456786', afiliado_sindicato: true }, p_user_id: 'u-1',
    })
  })
  it('error de la base con detail → status y campo', async () => {
    state.profile = ADMIN
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'LEGAJO_DUPLICADO', details: '{"campo":"leg","legajo_id":3}', code: 'P0001' } })
    const r = await post('/legajos', { leg: '112', convenio_id: 1 })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'LEGAJO_DUPLICADO', campo: 'leg', detail: { campo: 'leg', legajo_id: 3 } })
  })
})

describe('recibos', () => {
  it('calcular: vista previa con el motor, sin guardar', async () => {
    state.profile = LIQUIDADOR
    const r = await post('/liquidaciones/5/recibos/calcular', { legajo_id: 1, entradas: { horas_normales: 88 } })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.totales.remunerativo).toBe(683020.8)
    expect(body.totales.neto).toBe(529841.85)
    expect(rpcMock).toHaveBeenCalledWith('sueldos_valores_a_fecha', { p_convenio_id: 1, p_fecha: '2026-09-30', p_zona: 'A' })
    expect(rpcMock).not.toHaveBeenCalledWith('sueldos_guardar_recibo', expect.anything())
  })
  it('entradas con claves desconocidas → 400', async () => {
    state.profile = LIQUIDADOR
    const r = await post('/liquidaciones/5/recibos/calcular', { legajo_id: 1, entradas: { horas: 88 } })
    expect(r.status).toBe(400)
  })
  it('concepto desconocido → 400 CONCEPTO_DESCONOCIDO', async () => {
    state.profile = LIQUIDADOR
    const r = await post('/liquidaciones/5/recibos/calcular', { legajo_id: 1, entradas: { conceptos: [{ codigo: 'no_existe' }] } })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('CONCEPTO_DESCONOCIDO')
  })
  it('guardar: la RPC recibe líneas, totales y entradas; la respuesta enmascara el snapshot', async () => {
    state.profile = LIQUIDADOR
    const r = await put('/liquidaciones/5/recibos/1', { entradas: { horas_normales: 88 }, obs: 'ok' })
    expect(r.status).toBe(200)
    const call = rpcMock.mock.calls.find(c => c[0] === 'sueldos_guardar_recibo')![1]
    expect(call.p_liquidacion_id).toBe(5)
    expect(call.p_legajo_id).toBe(1)
    expect(call.p_recibo).toMatchObject({ total_remunerativo: 683020.8, neto: 529841.85, horas_trabajadas: 88, obs: 'ok', entradas: { horas_normales: 88 } })
    expect(call.p_lineas[0]).toMatchObject({ nombre: 'basico', tipo: 'remunerativo', importe: 569184, orden: 0 })
    const body = await r.json()
    expect(body.recibo.snapshot.legajo.cuil).toBe('***6786')
    expect(body.calculo.totales.neto).toBe(529841.85)
  })
  it('guardar en una liquidación cerrada → 409 antes de calcular', async () => {
    state.profile = LIQUIDADOR
    state.tablas.sueldos_liquidaciones = [{ ...LIQ, estado: 'cerrada' }]
    const r = await put('/liquidaciones/5/recibos/1', { entradas: {} })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('LIQUIDACION_NO_BORRADOR')
  })
  it('sugerencias: horas de tarja de la quincena y saldo de préstamos', async () => {
    state.profile = LIQUIDADOR
    const body = await (await get('/liquidaciones/5/recibos/1/sugerencias')).json()
    expect(body.horas_tarja.horas).toBe(18)
    expect(body.prestamos.saldo).toBe(60000)
    expect(body.entradas).toEqual({ horas_normales: 18, asistencia: true, prestamos: 60000 })
  })
  it('generar: crea el borrador con las sugerencias; el préstamo no deja el neto negativo', async () => {
    state.profile = LIQUIDADOR
    const r = await post('/liquidaciones/5/generar', {})
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.creados).toHaveLength(1)
    expect(body.errores).toEqual([])
    const call = rpcMock.mock.calls.find(c => c[0] === 'sueldos_guardar_recibo')![1]
    expect(call.p_recibo.entradas.horas_normales).toBe(18)
    // 18 h × 6468 + 20 % = 139.708,80 de rem → el préstamo de 60.000 entra entero y el neto queda ≥ 0.
    expect(call.p_recibo.neto).toBeGreaterThanOrEqual(0)
  })
  it('guardar con neto negativo → 409 NETO_NEGATIVO sin llamar a la base', async () => {
    state.profile = LIQUIDADOR
    const r = await put('/liquidaciones/5/recibos/1', { entradas: { horas_normales: 1, prestamos: 900000 } })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('NETO_NEGATIVO')
    expect(rpcMock.mock.calls.some(c => c[0] === 'sueldos_guardar_recibo')).toBe(false)
  })
  it('sugerencias: el préstamo ya puesto en otra liquidación en borrador no se ofrece de nuevo', async () => {
    state.profile = LIQUIDADOR
    state.tablas.sueldos_legajos = [{ id: 1, leg: '112' }]
    state.tablas.sueldos_recibos = [{ id: 9, legajo_id: 1, liquidacion_id: 6 }]
    state.tablas.sueldos_recibo_lineas = [{ recibo_id: 9, importe: 25000 }]
    const body = await (await get('/liquidaciones/5/recibos/1/sugerencias')).json()
    expect(body.prestamos).toMatchObject({ en_borradores: 25000, saldo: 35000 })
  })
  it('I5: generar incluye al inactivo que egresó dentro del período', async () => {
    state.profile = LIQUIDADOR
    state.tablas.v_sueldos_legajos = [{ ...LEGAJO, activo: false, fecha_egreso: '2026-09-20' }]
    const body = await (await post('/liquidaciones/5/generar', {})).json()
    expect(body.creados).toHaveLength(1)
  })
  it('generar omite al que va por hora y no tiene horas en la tarja del período', async () => {
    state.profile = LIQUIDADOR
    state.tablas.horas = []
    state.tablas.prestamos = []
    const body = await (await post('/liquidaciones/5/generar', {})).json()
    expect(body.creados).toEqual([])
    expect(body.omitidos).toEqual([{ legajo_id: 1, nombre: 'Pérez Juan', motivo: 'SIN_HORAS_EN_TARJA' }])
  })
  it('generar omite a los que ya tienen recibo salvo reemplazar', async () => {
    state.profile = LIQUIDADOR
    state.tablas.sueldos_recibos = [{ legajo_id: 1 }]
    const body = await (await post('/liquidaciones/5/generar', {})).json()
    expect(body.omitidos).toEqual([{ legajo_id: 1, nombre: 'Pérez Juan', motivo: 'YA_TIENE_RECIBO' }])
  })
  it('generar en vacaciones sin lista de legajos → 400 LEGAJOS_REQUERIDOS', async () => {
    state.profile = LIQUIDADOR
    state.tablas.sueldos_liquidaciones = [{ ...LIQ, tipo: 'vacaciones', quincena: null }]
    const r = await post('/liquidaciones/5/generar', {})
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('LEGAJOS_REQUERIDOS')
  })
  it('reabrir pide motivo', async () => {
    state.profile = perfil({ lectura: true, tabs: ['liquidaciones'], cerrar_liquidaciones: true })
    const r = await post('/liquidaciones/5/reabrir', { motivo: 'x' })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('MOTIVO_REQUERIDO')
  })
})

describe('exportar', () => {
  it('banco de una liquidación en borrador → 409 LIQUIDACION_NO_CERRADA', async () => {
    state.profile = ADMIN
    const r = await get('/liquidaciones/5/exportar/banco')
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('LIQUIDACION_NO_CERRADA')
  })
})

describe('ficha del legajo sin ver_pii', () => {
  it('no trae teléfono, dirección, nacimiento, licencia ni alias bancario', async () => {
    state.profile = LECTOR
    state.tablas.personal = [{ leg: '112', nom: 'Pérez Juan', dni: '12345678', tel: '3815551234', dir: 'Calle 1', fecha_nacimiento: '1990-01-01', condicion: 'blanco' }]
    const body = await (await get('/legajos/1')).json()
    expect(body.personal).not.toHaveProperty('tel')
    expect(body.personal).not.toHaveProperty('dir')
    expect(body.personal).not.toHaveProperty('fecha_nacimiento')
    expect(body.personal.dni).toBe('***5678')
  })
})

describe('auditoría', () => {
  it('rutas legibles y la vista previa no se audita', () => {
    expect(parseRoute('/api/sueldos/liquidaciones/5/recibos/12', 'PUT')).toEqual({ modulo: 'sueldos', entidad: 'recibo de sueldo', accion: 'actualizar', entidadId: '12' })
    expect(parseRoute('/api/sueldos/liquidaciones/5/cerrar', 'POST')).toMatchObject({ entidad: 'liquidación de sueldos', accion: 'cerrar', entidadId: '5' })
    expect(parseRoute('/api/sueldos/escalas/paritaria', 'POST')).toMatchObject({ entidad: 'escala salarial', accion: 'nueva paritaria' })
    expect(parseRoute('/api/sueldos/conceptos/7/valores', 'POST')).toMatchObject({ entidad: 'valor de concepto de sueldo', entidadId: '7' })
    expect(parseRoute('/api/sueldos/liquidaciones/5/recibos/calcular', 'POST')).toBeNull()
  })
})
