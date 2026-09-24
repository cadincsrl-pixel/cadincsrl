/**
 * Contabilidad fase 3 (20260927d–f) con la base mockeada: guardias de las
 * rutas de automáticos y mapeos, el bucle del contabilizador con el cursor,
 * contraasientos solo con `cerrar_periodos`, el cierre de período frenado por
 * pendientes (y `forzar`), el campo de los errores de mapeo, la config, y la
 * tesorería con tarjeta y billetera (20260927h). También el líquido de la
 * CVLP en Ventas.
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

function chain(data: unknown, error: unknown = null) {
  const obj: any = {}
  const self = () => obj
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'order', 'range', 'limit', 'update', 'insert', 'delete']) obj[m] = self
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: (n: string, a: unknown) => rpcMock(n, a) })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import ctb from '../../../src/modules/contabilidad/contabilidad.routes.js'
import { automaticosService, sumarTanda, configDeFilas } from '../../../src/modules/contabilidad/automaticos.service.js'
import { validarDatosBanco } from '../../../src/modules/contabilidad/tesoreria.service.js'
import { TesoreriaSchema, CuentaSchema, UpdateCuentaSchema } from '../../../src/modules/contabilidad/contabilidad.schema.js'
import { normRubro } from '../../../src/modules/contabilidad/plan-import.js'
import { externosService } from '../../../src/modules/facturacion/externos.service.js'
import { parseRoute } from '../../../src/middleware/audit.js'
import { hoyAR } from '../../../src/modules/pagos/pagos.util.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body?: unknown) => ctb.request(path, body === undefined ? { method: 'POST' } : { method: 'POST', ...json(body) })
const put = (path: string, body: unknown) => ctb.request(path, { method: 'PUT', ...json(body) })
const patch = (path: string, body: unknown) => ctb.request(path, { method: 'PATCH', ...json(body) })
const get = (path: string) => ctb.request(path)

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { contabilidad: p } : {} })
const MARIANA = perfil({
  lectura: true, creacion: true, actualizacion: true,
  tabs: ['asientos', 'periodos', 'automaticos', 'mapeos'],
  contabilizar: true, editar_mapeos: true, cerrar_periodos: true,
})
const SIN_CERRAR = perfil({ lectura: true, actualizacion: true, tabs: ['automaticos'], contabilizar: true })
const LECTOR = perfil({ lectura: true, tabs: ['automaticos'] })
const HOY = hoyAR()

let tandas: Fila[] = []

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  state.profile = null
  tandas = []
  state.tablas = {
    cont_config: [{ clave: 'automaticos_desde', valor: '2026-08-01' }, { clave: 'cvlp_modo', valor: 'bruto' }],
    cont_periodos: [{ id: 2, desde: '2026-07-01', hasta: '2026-07-31' }],
    cont_ejercicios: [{ id: 1, nombre: '2026/27', desde: '2026-07-01', hasta: '2027-06-30', estado: 'abierto' }],
    v_cont_periodos: [{ id: 2, ejercicio_id: 1, numero: 1, estado: 'abierto', cant_borradores: 0 }],
  }
  fromMock.mockImplementation((t: string) => (t === 'profiles' ? chain(state.profile) : chain(state.tablas[t] ?? [])))
  rpcMock.mockImplementation((name: string, args: any) => {
    if (name === 'cont_pendientes') return chain({ total: 3, resumen: { por_estado: { sin_contabilizar: 2, pendiente: 1 }, por_fuente: {}, por_motivo: [] }, items: [{ origen_id: 1 }] })
    if (name === 'cont_contabilizar') return chain(tandas.shift() ?? { procesados: 0, hay_mas: false, cursor: null })
    if (name === 'cont_propuesta') return chain(args.p_origen_id === 404 ? null : { origen_tabla: args.p_origen_tabla, origen_id: args.p_origen_id, lineas: [] })
    if (name === 'cont_mapeos_listar') return chain({ claves: [{ clave: 'compras.concepto', subclaves: [] }] })
    if (name === 'cont_guardar_mapeos') return chain({ claves: [] })
    if (name === 'cont_guardar_config') return chain({ automaticos_desde: '2026-09-01', cvlp_modo: 'neto_liquidado', compras_fecha_contable: 'fecha', paga_cliente_modo: null })
    if (name === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 1, estado: 'cerrado', cant_borradores: 0 }, numerados: 0 })
    return chain(null)
  })
})

const llamadas = (name: string) => rpcMock.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as any)

describe('guardias', () => {
  it('sin tab automaticos/mapeos o sin flags → 403', async () => {
    state.profile = perfil({ lectura: true, actualizacion: true, tabs: ['asientos'], contabilizar: true, editar_mapeos: true })
    expect((await get('/automaticos/pendientes')).status).toBe(403)
    expect((await get('/mapeos')).status).toBe(403)
    state.profile = LECTOR
    expect((await get('/automaticos/pendientes')).status).toBe(200)
    expect((await post('/automaticos/contabilizar', { hasta: HOY })).status).toBe(403)
    expect((await put('/mapeos', { mapeos: [{ clave: 'x', subclave: '', cuenta_id: 1 }] })).status).toBe(403)
    expect((await patch('/config', { cvlp_modo: 'bruto' })).status).toBe(403)
    // La config se lee con lectura, sin tab.
    expect((await get('/config')).status).toBe(200)
  })
})

describe('pendientes y propuesta', () => {
  it('default desde = automaticos_desde de la config, hasta = hoy; página con resumen', async () => {
    state.profile = LECTOR
    const r = await get('/automaticos/pendientes?fuente=pagos_facturas&limit=10')
    expect(r.status).toBe(200)
    expect(llamadas('cont_pendientes')[0]).toEqual({ p_desde: '2026-08-01', p_hasta: HOY, p_fuente: 'pagos_facturas', p_estado: null, p_motivo: null, p_limit: 10, p_offset: 0 })
    expect(await r.json()).toMatchObject({ total: 3, limit: 10, offset: 0, hasMore: true, items: [{ origen_id: 1 }], resumen: { por_estado: { sin_contabilizar: 2 } } })
  })

  it('fuente inválida → 400; propuesta inexistente → 404 ORIGEN_NO_EXISTE', async () => {
    state.profile = LECTOR
    expect((await get('/automaticos/pendientes?fuente=caja')).status).toBe(400)
    expect((await get('/automaticos/propuesta?origen_tabla=pagos_facturas&origen_id=9')).status).toBe(200)
    const r = await get('/automaticos/propuesta?origen_tabla=pagos_facturas&origen_id=404')
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ error: 'ORIGEN_NO_EXISTE' })
  })
})

describe('contabilizar', () => {
  it('llama en bucle con el cursor hasta hay_mas=false y suma los totales', async () => {
    state.profile = MARIANA
    tandas = [
      { procesados: 300, creados: 250, pendientes: 50, errores: 1, hay_mas: true, cursor: { fecha: '2026-07-20', tabla: 'pagos_facturas', id: 9 },
        detalle_errores: [{ origen_tabla: 'pagos_facturas', origen_id: 3, codigo: 'ERROR_INTERNO', mensaje: 'x' }] },
      { procesados: 20, creados: 20, hay_mas: false, cursor: null },
    ]
    const r = await post('/automaticos/contabilizar', { hasta: HOY, fuentes: ['pagos_facturas'] })
    expect(r.status).toBe(200)
    const c = llamadas('cont_contabilizar')
    expect(c).toHaveLength(2)
    expect(c[0]).toEqual({ p_hasta: HOY, p_user_id: 'u-1', p_fuentes: ['pagos_facturas'], p_revertir_cerrados: false, p_cursor: null, p_limite: 100 })
    expect(c[1].p_cursor).toEqual({ fecha: '2026-07-20', tabla: 'pagos_facturas', id: 9 })
    expect(await r.json()).toMatchObject({ procesados: 320, creados: 270, pendientes: 50, errores: 1, hay_mas: false, cursor: null, detalle_errores: [{ origen_id: 3 }] })
  })

  it('corta si el cursor no avanza (no se cuelga)', async () => {
    state.profile = MARIANA
    const cur = { fecha: '2026-07-20', tabla: 'pagos_facturas', id: 9 }
    tandas = [{ procesados: 1, hay_mas: true, cursor: cur }, { procesados: 0, hay_mas: true, cursor: cur }, { procesados: 0, hay_mas: true, cursor: cur }]
    const b = await (await post('/automaticos/contabilizar', { hasta: HOY })).json() as any
    expect(llamadas('cont_contabilizar')).toHaveLength(2)
    expect(b).toMatchObject({ hay_mas: true, cursor: cur })
  })

  it('reenvía el cursor que manda el FE; respeta el presupuesto de tiempo', async () => {
    state.profile = MARIANA
    const cur = { fecha: '2026-07-20', tabla: 'ventas_cobros', id: 4 }
    await post('/automaticos/contabilizar', { hasta: HOY, cursor: cur })
    expect(llamadas('cont_contabilizar')[0].p_cursor).toEqual(cur)
    rpcMock.mockClear()
    tandas = [{ procesados: 1, hay_mas: true, cursor: { ...cur, id: 5 } }, { procesados: 1, hay_mas: false }]
    const t = await automaticosService.contabilizar({ hasta: HOY, revertir_cerrados: false }, 'u-1', undefined, 0)
    expect(t).toMatchObject({ procesados: 1, hay_mas: true })
  })

  it('revertir_cerrados sin cerrar_periodos → 403 SIN_PERMISO_CERRAR; fecha futura → 400', async () => {
    state.profile = SIN_CERRAR
    const r = await post('/automaticos/contabilizar', { hasta: HOY, revertir_cerrados: true })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'SIN_PERMISO_CERRAR' })
    expect(llamadas('cont_contabilizar')).toHaveLength(0)
    state.profile = MARIANA
    expect((await post('/automaticos/contabilizar', { hasta: HOY, revertir_cerrados: true })).status).toBe(200)
    expect(llamadas('cont_contabilizar')[0].p_revertir_cerrados).toBe(true)
    const f = await post('/automaticos/contabilizar', { hasta: '2999-01-01' })
    expect(f.status).toBe(400)
    expect(await f.json()).toMatchObject({ error: 'FECHA_FUTURA', campo: 'hasta' })
  })

  it('errores de la RPC: ocupado → 409', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation(() => chain(null, { message: 'CONTABILIZADOR_OCUPADO', code: 'P0001' }))
    const r = await post('/automaticos/contabilizar', { hasta: HOY })
    expect(r.status).toBe(409)
  })

  it('sumarTanda tope 50 errores', () => {
    const e = { origen_tabla: 'pagos_facturas' as const, origen_id: 1, codigo: 'X', mensaje: '' }
    let t = sumarTanda({ procesados: 0, creados: 0, regenerados: 0, anulados: 0, revertidos: 0, sin_cambios: 0, pendientes: 0, desactualizados: 0, errores: 0, hay_mas: false, cursor: null, detalle_errores: [] },
      { errores: 40, detalle_errores: Array(40).fill(e) })
    t = sumarTanda(t, { errores: 40, detalle_errores: Array(40).fill(e) })
    expect(t.errores).toBe(80)
    expect(t.detalle_errores).toHaveLength(50)
  })
})

describe('cerrar período con pendientes', () => {
  it('sin forzar → 409 HAY_PENDIENTES_AUTOMATICOS con el conteo; con forzar cierra', async () => {
    state.profile = MARIANA
    const r = await post('/periodos/2/cerrar')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'HAY_PENDIENTES_AUTOMATICOS', detail: { cantidad: 3, por_estado: { sin_contabilizar: 2, pendiente: 1 } } })
    expect(llamadas('cont_pendientes')[0]).toMatchObject({ p_desde: '2026-07-01', p_hasta: '2026-07-31', p_limit: 1 })
    expect(llamadas('cont_cerrar_periodo')).toHaveLength(0)
    const ok = await post('/periodos/2/cerrar', { forzar: true })
    expect(ok.status).toBe(200)
    expect(llamadas('cont_cerrar_periodo')).toHaveLength(1)
  })

  it('sin pendientes cierra; sin la función en la base (migración no aplicada) cierra igual', async () => {
    state.profile = MARIANA
    rpcMock.mockImplementation((name: string) => {
      if (name === 'cont_pendientes') return chain({ total: 0, resumen: { por_estado: {} } })
      if (name === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 1, estado: 'cerrado', cant_borradores: 0 } })
      return chain(null)
    })
    expect((await post('/periodos/2/cerrar')).status).toBe(200)
    rpcMock.mockImplementation((name: string) => {
      if (name === 'cont_pendientes') return chain(null, { message: 'Could not find the function', code: 'PGRST202' })
      if (name === 'cont_cerrar_periodo') return chain({ periodo: { id: 2, ejercicio_id: 1, numero: 1, estado: 'cerrado', cant_borradores: 0 } })
      return chain(null)
    })
    expect((await post('/periodos/2/cerrar')).status).toBe(200)
  })

  it('body inválido → 400', async () => {
    state.profile = MARIANA
    expect((await post('/periodos/2/cerrar', { forzar: 'si' })).status).toBe(400)
  })
})

describe('mapeos y config', () => {
  it('GET y PUT; el error de una fila apunta a mapeos.<i>.cuenta_id', async () => {
    state.profile = MARIANA
    expect(await (await get('/mapeos')).json()).toMatchObject({ claves: [{ clave: 'compras.concepto' }] })
    const body = { mapeos: [{ clave: 'compras.concepto', subclave: '3', cuenta_id: 10 }, { clave: 'compras.iva_cf', subclave: '', cuenta_id: null }] }
    expect((await put('/mapeos', body)).status).toBe(200)
    expect(llamadas('cont_guardar_mapeos')[0]).toEqual({ p_mapeos: body.mapeos, p_user_id: 'u-1' })
    rpcMock.mockImplementation(() => chain(null, { message: 'MAPEO_CUENTA_INCOMPATIBLE', code: 'P0001', details: '{"indice":1,"clave":"compras.iva_cf","rubro":"egreso"}' }))
    const r = await put('/mapeos', body)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'MAPEO_CUENTA_INCOMPATIBLE', campo: 'mapeos.1.cuenta_id', detail: { indice: 1 } })
  })

  it('más de 500 → 400 DEMASIADAS_FILAS', async () => {
    state.profile = MARIANA
    const r = await put('/mapeos', { mapeos: Array.from({ length: 501 }, () => ({ clave: 'x', subclave: '', cuenta_id: 1 })) })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'DEMASIADAS_FILAS' })
  })

  it('config: GET con defaults; PATCH valida y devuelve la config', async () => {
    state.profile = MARIANA
    expect(await (await get('/config')).json()).toEqual({ automaticos_desde: '2026-08-01', cvlp_modo: 'bruto', compras_fecha_contable: 'mes_iva', paga_cliente_modo: null })
    const r = await patch('/config', { automaticos_desde: '2026-09-01', compras_fecha_contable: 'fecha' })
    expect(r.status).toBe(200)
    expect(llamadas('cont_guardar_config')[0]).toEqual({ p_cambios: { automaticos_desde: '2026-09-01', compras_fecha_contable: 'fecha' }, p_user_id: 'u-1' })
    expect(await r.json()).toMatchObject({ automaticos_desde: '2026-09-01', compras_fecha_contable: 'fecha' })
    const mal = await patch('/config', { automaticos_desde: '2026-06-01' })
    expect(mal.status).toBe(400)
    expect(await mal.json()).toMatchObject({ error: 'CONFIG_INVALIDA' })
    expect((await patch('/config', {})).status).toBe(400)
    expect((await patch('/config', { cvlp_modo: 'raro' })).status).toBe(400)
  })

  it('configDeFilas ignora claves desconocidas', () => {
    expect(configDeFilas([{ clave: 'otra', valor: 1 }]).cvlp_modo).toBe('neto_liquidado')
  })
})

describe('tesorería: tarjeta y billetera (20260927h)', () => {
  it('tipos nuevos en el schema', () => {
    expect(TesoreriaSchema.safeParse({ tipo: 'tarjeta', nombre: 'Visa Galicia', banco: 'Galicia' }).success).toBe(true)
    expect(TesoreriaSchema.safeParse({ tipo: 'billetera', nombre: 'Mercado Pago' }).success).toBe(true)
    expect(TesoreriaSchema.safeParse({ tipo: 'cripto', nombre: 'X' }).success).toBe(false)
  })

  it('CBU/CVU y alias solo en banco y billetera', () => {
    // CVU válido de Mercado Pago (mismos verificadores que un CBU).
    expect(validarDatosBanco('billetera', '0000003100010000000009', 'cadinc.mp')).toEqual({ cbu: '0000003100010000000009', alias: 'CADINC.MP' })
    expect(() => validarDatosBanco('tarjeta', '0000003100010000000009', null)).toThrowError('CBU_INVALIDO')
    expect(() => validarDatosBanco('tarjeta', null, 'alias.x')).toThrowError('ALIAS_INVALIDO')
    expect(validarDatosBanco('tarjeta', null, null)).toEqual({ cbu: null, alias: null })
    expect(() => validarDatosBanco('billetera', '0000003100010000000002', null)).toThrowError('CBU_INVALIDO')
  })
})

describe('líquido de la CVLP (Ventas)', () => {
  const db = (externo: Fila | null) => {
    const updates: Fila[] = []
    const tabla = () => {
      const o: any = chain(externo)
      o.update = (x: Fila) => { updates.push(x); return o }
      return o
    }
    return { db: { from: tabla } as any, updates }
  }

  it('solo CVLP y 0 < líquido ≤ total', async () => {
    const d1 = db({ id: 1, cbte_tipo: 1, total: 1000 })
    await expect(externosService.liquido(1, 900, 'u-1', d1.db)).rejects.toMatchObject({ code: 'NO_ES_CVLP', status: 400 })
    const d2 = db({ id: 2, cbte_tipo: 60, total: 1000 })
    await expect(externosService.liquido(2, 1000.01, 'u-1', d2.db)).rejects.toMatchObject({ code: 'LIQUIDO_INVALIDO' })
    await expect(externosService.liquido(2, 0, 'u-1', d2.db)).rejects.toMatchObject({ code: 'LIQUIDO_INVALIDO' })
    await externosService.liquido(2, 912.345, 'u-1', d2.db)
    expect(d2.updates[0]).toEqual({ liquido: 912.35, updated_by: 'u-1' })
    await externosService.liquido(2, null, 'u-1', d2.db)
    expect(d2.updates[1]).toEqual({ liquido: null, updated_by: 'u-1' })
    const d3 = db(null)
    await expect(externosService.liquido(3, 10, 'u-1', d3.db)).rejects.toMatchObject({ code: 'EXTERNO_NO_EXISTE', status: 404 })
  })
})

describe('auditoría', () => {
  it('rutas nuevas', () => {
    expect(parseRoute('/api/contabilidad/automaticos/contabilizar', 'POST')).toMatchObject({ entidad: 'contabilizador', accion: 'contabilizar' })
    expect(parseRoute('/api/contabilidad/mapeos', 'PUT')).toMatchObject({ entidad: 'mapeo contable', accion: 'actualizar' })
    expect(parseRoute('/api/contabilidad/config', 'PATCH')).toMatchObject({ entidad: 'config contable', accion: 'actualizar' })
    expect(parseRoute('/api/facturacion/externos/5/liquido', 'PATCH')).toMatchObject({ entidad: 'comprobante externo', accion: 'cargar líquido', entidadId: '5' })
  })
})

describe('rubro «resultado» (pieza 5, plan de Finnegans)', () => {
  it('el parser del plan lo reconoce', () => {
    expect(normRubro('Resultado')).toBe('resultado')
    expect(normRubro('RESULTADOS')).toBe('resultado')
    expect(normRubro('Resultado del Período')).toBe('resultado')
    expect(normRubro('resultado positivo')).toBe('ingreso')
    expect(normRubro('R-')).toBe('egreso')
  })

  it('solo títulos: imputable → RESULTADO_SOLO_TITULO', async () => {
    expect(CuentaSchema.safeParse({ codigo: '4', nombre: 'Resultado del periodo', rubro: 'resultado', imputable: false }).success).toBe(true)
    expect(CuentaSchema.safeParse({ codigo: '4', nombre: 'Resultado del periodo', rubro: 'resultado', imputable: true }).success).toBe(false)
    expect(UpdateCuentaSchema.safeParse({ rubro: 'resultado' }).success).toBe(true)
    expect(UpdateCuentaSchema.safeParse({ rubro: 'resultado', imputable: true }).success).toBe(false)
    state.profile = perfil({ lectura: true, creacion: true, tabs: ['plan'], editar_plan: true })
    const r = await post('/cuentas', { codigo: '4', nombre: 'Resultado del periodo', rubro: 'resultado', imputable: true })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'RESULTADO_SOLO_TITULO', campo: 'rubro' })
  })

  it('los errores de la base se mapean', async () => {
    state.profile = perfil({ lectura: true, creacion: true, tabs: ['plan'], editar_plan: true })
    rpcMock.mockImplementation(() => chain(null, { message: 'RUBRO_REQUERIDO', code: 'P0001', details: '{"campo":"rubro"}' }))
    const r = await post('/cuentas', { codigo: '4.1', nombre: 'Ingresos', imputable: false })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'RUBRO_REQUERIDO', campo: 'rubro' })
    rpcMock.mockImplementation(() => chain(null, { message: 'RESULTADO_SOLO_TITULO', code: 'P0001' }))
    expect((await post('/cuentas', { codigo: '4.1', nombre: 'Ingresos', rubro: 'resultado', imputable: false })).status).toBe(400)
  })
})
