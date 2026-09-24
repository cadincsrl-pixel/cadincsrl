/**
 * Compras 25/09: proveedores con el padrón de ARCA, cheques con foto y
 * recibo del proveedor (20260925o–q).
 *
 *   - Guardias de los endpoints nuevos (padrón, actualizar uno y todos, leer cheque).
 *   - Aviso LETRA_NO_COINCIDE_CONDICION: casos, y que sale en el alta de la factura.
 *   - Qué pisa «Actualizar desde ARCA» (pura).
 *   - Schema: cheques con foto_path, tipos de adjunto nuevos, sin_recibo, datos fiscales.
 *   - La foto del cheque se adjunta a la OP como tipo `cheque` y no viaja en el cheque.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, consultarMock, iaChequeMock, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  consultarMock: vi.fn(),
  iaChequeMock: vi.fn(),
  state: {
    userId: 'u-1',
    profile: null as Fila | null,
    proveedores: [] as Fila[],
    facturas: [] as Fila[],
    cheques: [] as Fila[],
    updates: [] as { tabla: string; valores: Fila }[],
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: state.userId, email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

function chain(data: unknown, tabla = '') {
  const obj: any = {}
  const self = () => obj
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'contains', 'order', 'range', 'limit', 'insert', 'delete']) obj[m] = self
  obj.update = (v: Fila) => { state.updates.push({ tabla, valores: v }); return obj }
  const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (res: any, rej: any) => Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : null }).then(res, rej)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const storage = {
    from: () => ({
      remove: async () => ({}),
      move: async () => ({}),
      download: async (path: string) => ({ data: new Blob([`contenido de ${path}`]), error: null }),
    }),
  }
  const cliente = () => ({ from: (t: string) => fromMock(t), rpc: (n: string, a: unknown) => rpcMock(n, a), storage })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

vi.mock('../../../src/lib/arca/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/arca/index.js')>()),
  consultarPersona: (cuit: string) => consultarMock(cuit),
}))

vi.mock('../../../src/modules/pagos/lectura/cheque-ia.js', () => ({
  leerChequeConIA: (b: Buffer, m: string) => iaChequeMock(b, m),
}))

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { hoyAR } from '../../../src/modules/pagos/pagos.util.js'
import { avisoLetraCondicion } from '../../../src/modules/pagos/condicion-iva.js'
import { cambiosProveedorDesdePadron } from '../../../src/modules/pagos/proveedores.service.js'
import { adjuntosDeCheques, chequesParaRpc, propuestaDeCheque } from '../../../src/modules/pagos/cheques.service.js'
import {
  ChequeSchema, CreateOrdenSchema, CreateProveedorSchema, DatosPagoSchema, ListOrdenesQuerySchema, TIPOS_ADJ_ORDEN, UpdateProveedorSchema,
} from '../../../src/modules/pagos/pagos.schema.js'
import { ArcaError, type PersonaPadron } from '../../../src/lib/arca/index.js'
import { parseRoute } from '../../../src/middleware/audit.js'

const HOY = hoyAR()
const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => pagos.request(path, { method: 'POST', ...json(body) })
const get = (path: string) => pagos.request(path)

const perfil = (permisosPagos: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: permisosPagos ? { pagos: permisosPagos } : {} })
const COMPRAS   = perfil({ lectura: true, creacion: true, actualizacion: true, ver_pii: true, tabs: ['facturas', 'proveedores'] })
const COMPRAS_SOLO_FACTURAS = perfil({ lectura: true, creacion: true, actualizacion: true, tabs: ['facturas'] })
const APROBADOR = perfil({ lectura: true, aprobar_facturas: true, tabs: ['facturas'] })
const CONTADOR  = perfil({ lectura: true, registrar_pagos: true, ver_pii: true, tabs: ['facturas', 'pagos', 'proveedores'] })

const CUIT_OK = '30500010912' // YPF: dígito verificador válido

const PADRON: PersonaPadron = {
  cuit: CUIT_OK, razon_social: 'FERRETERIA NORTE SRL', tipo_persona: 'JURIDICA', estado_clave: 'ACTIVO',
  domicilio_fiscal: { direccion: 'AV. MATE DE LUNA  1234', localidad: 'SAN MIGUEL DE TUCUMAN', cod_postal: '4000', provincia: 'TUCUMAN', id_provincia: 24 },
  condicion_iva_id: 1, condicion_iva_dudosa: false, condicion_iva_motivo: 'Inscripto en IVA (impuesto 30).',
  es_monotributo: false, es_exento: false, categoria_monotributo: null, impuestos: [],
  actividades: [{ id: 475230, descripcion: 'VENTA AL POR MENOR DE ARTICULOS DE FERRETERIA', orden: 1 }], avisos: [],
}

beforeEach(() => {
  fromMock.mockReset()
  rpcMock.mockReset()
  consultarMock.mockReset()
  iaChequeMock.mockReset()
  state.userId = 'u-1'
  state.profile = null
  state.proveedores = []
  state.facturas = []
  state.cheques = []
  state.updates = []
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile, t)
    if (t === 'pagos_proveedores' || t === 'v_pagos_proveedores') return chain(state.proveedores, t)
    if (t === 'pagos_facturas' || t === 'v_pagos_facturas') return chain(state.facturas, t)
    if (t === 'pagos_cheques') return chain(state.cheques, t)
    return chain([], t)
  })
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'pagos_crear_factura') return { data: { factura: { id: 10, estado: 'pendiente' }, orden: null }, error: null }
    if (name === 'pagos_registrar_orden') return { data: { orden: { id: 20, numero: 1 }, facturas: [] }, error: null }
    return { data: null, error: null }
  })
  consultarMock.mockResolvedValue(PADRON)
})

const llamada = (name: string) => rpcMock.mock.calls.find((c) => c[0] === name)?.[1] as Fila | undefined

// ── Guardias ────────────────────────────────────────────────────────────────

describe('guardias de los endpoints nuevos', () => {
  it('GET /proveedores/padron/:cuit pide creacion + tab facturas o proveedores', async () => {
    state.profile = CONTADOR // sin creacion
    expect((await get(`/proveedores/padron/${CUIT_OK}`)).status).toBe(403)
    state.profile = COMPRAS_SOLO_FACTURAS // alta rápida desde el modal de factura
    const res = await get(`/proveedores/padron/${CUIT_OK}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cuit).toBe(CUIT_OK)
    expect(body.precarga).toEqual({
      razon_social: 'FERRETERIA NORTE SRL', domicilio: 'AV. MATE DE LUNA 1234 - SAN MIGUEL DE TUCUMAN (CP 4000)',
      provincia: 'Tucuman', condicion_iva_id: 1,
    })
    expect(body.padron).toMatchObject({
      razon_social: 'FERRETERIA NORTE SRL', domicilio: 'AV. MATE DE LUNA 1234 - SAN MIGUEL DE TUCUMAN (CP 4000)', provincia: 'Tucuman',
      condicion_iva_id: 1, condicion_iva_dudosa: false, tipo_persona: 'JURIDICA', estado_clave: 'ACTIVO',
    })
    expect(Array.isArray(body.padron.actividades)).toBe(true)
    expect(typeof body.consultado_at).toBe('string')
    // No guarda nada.
    expect(state.updates).toEqual([])
  })

  it('padrón: CUIT inválido 400 sin llamar a ARCA; errores de ARCA con los status de Ventas', async () => {
    state.profile = COMPRAS
    const inv = await get('/proveedores/padron/30500010911')
    expect(inv.status).toBe(400)
    expect((await inv.json()).error).toBe('CUIT_INVALIDO')
    expect(consultarMock).not.toHaveBeenCalled()

    const casos: [string, number, string][] = [
      ['ARCA_PADRON_CUIT_INEXISTENTE', 404, 'PADRON_CUIT_INEXISTENTE'],
      ['ARCA_PADRON_NO_ALCANZADO', 422, 'PADRON_NO_ALCANZADO'],
      ['ARCA_PADRON_CLAVE_INACTIVA', 422, 'PADRON_CLAVE_INACTIVA'],
      ['ARCA_PADRON_SIN_DATOS', 422, 'PADRON_SIN_DATOS'],
      ['ARCA_PADRON_SIN_AUTORIZACION', 503, 'PADRON_SIN_AUTORIZACION'],
      ['ARCA_TIMEOUT', 503, 'ARCA_NO_DISPONIBLE'],
    ]
    for (const [codigo, status, code] of casos) {
      consultarMock.mockRejectedValueOnce(new ArcaError({ tipo: 'rechazo', codigo, mensaje: 'x', errores: [] } as any))
      const r = await get(`/proveedores/padron/${CUIT_OK}`)
      expect(r.status).toBe(status)
      expect((await r.json()).error).toBe(code)
    }
  })

  it('POST /proveedores/:id/actualizar-desde-arca pide actualizacion + tab proveedores', async () => {
    state.profile = APROBADOR
    expect((await post('/proveedores/7/actualizar-desde-arca')).status).toBe(403)
    state.profile = COMPRAS_SOLO_FACTURAS
    expect((await post('/proveedores/7/actualizar-desde-arca')).status).toBe(403)

    state.profile = COMPRAS
    state.proveedores = [{ id: 7, razon_social: 'Ferretería Norte', cuit: CUIT_OK, domicilio: null, provincia: null, condicion_iva_id: null, cbu: '0170099220000123456788' }]
    const res = await post('/proveedores/7/actualizar-desde-arca')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['diferencias', 'proveedor'])
    const upd = state.updates.find((u) => u.tabla === 'pagos_proveedores')!.valores
    expect(upd).toMatchObject({ provincia: 'Tucuman', condicion_iva_id: 1, tipo_persona: 'JURIDICA', updated_by: 'u-1' })
    expect(upd.padron_json).toBeTruthy()
    expect(upd.padron_consultado_at).toBeTruthy()
    // Sin ?todo la razón social no se toca.
    expect(upd.razon_social).toBeUndefined()
    expect(body.diferencias.find((d: Fila) => d.campo === 'razon_social')).toMatchObject({ aplicado: false })

    state.updates = []
    await post('/proveedores/7/actualizar-desde-arca?todo=1')
    expect(state.updates[0]!.valores).toMatchObject({ razon_social: 'FERRETERIA NORTE SRL', razon_social_norm: 'ferreteria norte srl' })
  })

  it('actualizar un proveedor sin CUIT → 400 PROVEEDOR_SIN_CUIT', async () => {
    state.profile = COMPRAS
    state.proveedores = [{ id: 7, razon_social: 'Del exterior', cuit: null }]
    const res = await post('/proveedores/7/actualizar-desde-arca')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('PROVEEDOR_SIN_CUIT')
  })

  it('POST /proveedores/actualizar-desde-arca (masivo) pide actualizacion + tab proveedores y devuelve el resumen', async () => {
    state.profile = COMPRAS_SOLO_FACTURAS
    expect((await post('/proveedores/actualizar-desde-arca')).status).toBe(403)
    state.profile = COMPRAS
    state.proveedores = [
      { id: 1, razon_social: 'Ferretería Norte', cuit: CUIT_OK },
      { id: 2, razon_social: 'Sin CUIT', cuit: null },
    ]
    const res = await post('/proveedores/actualizar-desde-arca')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ actualizados: 1, sin_cuit: 1, errores: [], interrumpido: false })
  })
})

describe('leer la foto de un cheque', () => {
  const BODY = { storage_path: 'ordenes/pendientes/abc.jpg', mime_type: 'image/jpeg' }
  const LEIDO = {
    legible: true, numero: 'N° 12345678', banco: 'Banco de Galicia', sucursal: null,
    fecha_emision: '2026-09-20', fecha_pago: '2026-10-20', importe: 1250000.5, importe_en_letras: 'un millón…',
    importe_letras_coincide: true, librador: 'Constructora Sur SA', librador_cuit: CUIT_OK,
    es_echeq: false, es_diferido: null, a_la_orden_de: null, notas: null,
  }

  it('pide lectura + registrar_pagos + tab facturas o pagos', async () => {
    state.profile = COMPRAS
    const res = await post('/cheques/leer', BODY)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'SIN_PERMISO', detail: { flag: 'registrar_pagos' } })
    expect(iaChequeMock).not.toHaveBeenCalled()
  })

  it('path fuera de ordenes/pendientes → 400 PATH_INVALIDO', async () => {
    state.profile = CONTADOR
    const res = await post('/cheques/leer', { ...BODY, storage_path: 'ordenes/3/x.jpg' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('PATH_INVALIDO')
  })

  it('devuelve { propuesta, avisos, storage_path } y no crea nada', async () => {
    state.profile = CONTADOR
    iaChequeMock.mockResolvedValue({ ok: true, lectura: LEIDO, modelo: 'claude-opus-5' })
    const res = await post('/cheques/leer', BODY)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.storage_path).toBe(BODY.storage_path)
    expect(body.propuesta).toEqual({
      numero: '12345678', banco: 'Banco de Galicia', fecha_cobro: '2026-10-20', fecha_emision: '2026-09-20',
      importe: 1250000.5, librador: 'Constructora Sur SA', librador_cuit: CUIT_OK,
      es_echeq: false, es_diferido: true, es_propio: false,
    })
    expect(body.avisos).toEqual([])
    expect(rpcMock).not.toHaveBeenCalled()
    expect(state.updates).toEqual([])
  })

  it('avisa si el cheque ya se entregó en otra OP emitida', async () => {
    state.profile = CONTADOR
    iaChequeMock.mockResolvedValue({ ok: true, lectura: LEIDO, modelo: 'claude-opus-5' })
    state.cheques = [{ orden_id: 9, numero: '12345678', banco: 'Banco de Galicia', pagos_ordenes: { numero: 12, estado: 'emitida' } }]
    const body = await (await post('/cheques/leer', BODY)).json()
    expect(body.avisos[0]).toMatchObject({ codigo: 'CHEQUE_YA_ENTREGADO', severidad: 'error', orden_ids: [9] })
  })

  it('si la IA no puede leer → 422 CHEQUE_ILEGIBLE (con el path, para adjuntarla igual)', async () => {
    state.profile = CONTADOR
    iaChequeMock.mockResolvedValue({ ok: true, lectura: { ...LEIDO, legible: false, notas: 'borroso' }, modelo: 'm' })
    let res = await post('/cheques/leer', BODY)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'CHEQUE_ILEGIBLE', detail: { storage_path: BODY.storage_path, motivo: 'borroso' } })
    iaChequeMock.mockResolvedValue({ ok: false, motivo: 'SIN_API_KEY', modelo: null })
    res = await post('/cheques/leer', BODY)
    expect(res.status).toBe(422)
    expect((await res.json()).detail.motivo).toBe('SIN_API_KEY')
  })

  it('propuestaDeCheque: fecha de pago = emisión si no es diferido, CUIT inválido se descarta, letras que no cierran avisan', () => {
    const r = propuestaDeCheque({ ...LEIDO, fecha_pago: null, librador_cuit: '20111111111', importe_letras_coincide: false, librador: 'CADINC SRL' })
    expect(r.propuesta.fecha_cobro).toBe('2026-09-20')
    expect(r.propuesta.es_diferido).toBe(false)
    expect(r.propuesta.librador_cuit).toBeNull()
    expect(r.propuesta.es_propio).toBe(true)
    expect(r.avisos.map((a) => a.codigo).sort()).toEqual(['CUIT_LIBRADOR_INVALIDO', 'IMPORTE_LETRAS_NO_COINCIDE'])
    const vacio = propuestaDeCheque({ ...LEIDO, numero: null, importe: null, fecha_pago: '2026-02-30', fecha_emision: null })
    expect(vacio.propuesta).toMatchObject({ numero: null, importe: null, fecha_cobro: null })
    expect(vacio.avisos.map((a) => a.codigo)).toEqual(['NUMERO_NO_LEIDO', 'FECHA_NO_LEIDA', 'IMPORTE_NO_LEIDO'])
  })
})

// ── Letra vs condición ──────────────────────────────────────────────────────

describe('aviso LETRA_NO_COINCIDE_CONDICION', () => {
  it.each([
    [6, 'A', true], [6, 'B', true], [6, 'C', false],
    [13, 'A', true], [16, 'B', true],
    [1, 'C', true], [1, 'A', false], [1, 'B', false],
    [4, 'A', true], [4, 'B', false], [4, 'C', false],
    [5, 'A', false], [null, 'A', false], [6, 'recibo', false], [6, 'ticket', false], [1, null, false],
  ] as const)('condición %s + letra %s → aviso %s', (cond, letra, hayAviso) => {
    const a = avisoLetraCondicion(cond, letra)
    expect(!!a).toBe(hayAviso)
    if (a) {
      expect(a).toMatchObject({ code: 'LETRA_NO_COINCIDE_CONDICION', condicion: cond, letra })
      expect(a.mensaje.length).toBeGreaterThan(10)
    }
  })

  it('sale en los avisos del alta de la factura y no la bloquea', async () => {
    state.profile = COMPRAS
    state.proveedores = [{ id: 1, condicion_iva_id: 6 }]
    const res = await post('/facturas', {
      proveedor_id: 1, tipo_comprobante: 'A', numero: '0001-00000007', fecha: HOY, total: 1000, descripcion: 'Hierro',
      concepto_id: 2, imputaciones: [{ obra_cod: 'CC 1', monto: 1000 }],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.avisos).toContainEqual(expect.objectContaining({ code: 'LETRA_NO_COINCIDE_CONDICION', condicion: 6, letra: 'A' }))
    expect(llamada('pagos_crear_factura')).toBeTruthy()
  })
})

// ── Qué pisa «Actualizar desde ARCA» ────────────────────────────────────────

describe('cambiosProveedorDesdePadron', () => {
  const actual = { razon_social: 'Ferretería Norte', domicilio: 'viejo', provincia: 'Tucuman', condicion_iva_id: 6, tipo_persona: null, actividad_principal: null }

  it('pisa domicilio, tipo, actividad y condición; no la razón social sin todo', () => {
    const { upd, diferencias } = cambiosProveedorDesdePadron(actual, PADRON, false)
    expect(upd).toEqual({
      domicilio: 'AV. MATE DE LUNA 1234 - SAN MIGUEL DE TUCUMAN (CP 4000)', tipo_persona: 'JURIDICA',
      actividad_principal: 'VENTA AL POR MENOR DE ARTICULOS DE FERRETERIA', condicion_iva_id: 1,
    })
    expect(diferencias.find((d) => d.campo === 'provincia')).toBeUndefined() // ya coincidía
    expect(diferencias.find((d) => d.campo === 'razon_social')).toMatchObject({ aplicado: false })
  })

  it('una condición DUDOSA no pisa la cargada salvo con todo', () => {
    const dudoso = { ...PADRON, condicion_iva_id: 5, condicion_iva_dudosa: true }
    expect(cambiosProveedorDesdePadron(actual, dudoso, false).upd.condicion_iva_id).toBeUndefined()
    expect(cambiosProveedorDesdePadron({ ...actual, condicion_iva_id: null }, dudoso, false).upd.condicion_iva_id).toBe(5)
    expect(cambiosProveedorDesdePadron(actual, dudoso, true).upd.condicion_iva_id).toBe(5)
  })
})

// ── Schema ──────────────────────────────────────────────────────────────────

describe('schema', () => {
  const CHEQUE = { numero: '123', fecha_cobro: HOY, monto: 100 }

  it('el cheque acepta foto_path (opcional, nullable)', () => {
    expect(ChequeSchema.safeParse(CHEQUE).success).toBe(true)
    expect(ChequeSchema.safeParse({ ...CHEQUE, foto_path: null }).success).toBe(true)
    const r = ChequeSchema.safeParse({ ...CHEQUE, foto_path: 'ordenes/pendientes/a.jpg' })
    expect(r.success && r.data.foto_path).toBe('ordenes/pendientes/a.jpg')
    expect(ChequeSchema.safeParse({ ...CHEQUE, foto_path: '' }).success).toBe(false)
    expect(CreateOrdenSchema.safeParse({
      proveedor_id: 1, fecha: HOY, forma_pago: 'cheque', lineas: [{ factura_id: 5, monto: 100 }],
      cheques: [{ ...CHEQUE, foto_path: 'ordenes/pendientes/a.jpg' }],
    }).success).toBe(true)
  })

  it('tipos de adjunto de la OP: recibo_proveedor y cheque (espejo del CHECK de 20260925p)', () => {
    expect([...TIPOS_ADJ_ORDEN]).toEqual(['comprobante_pago', 'nota_credito', 'otro', 'recibo_proveedor', 'cheque'])
  })

  it('GET /ordenes acepta sin_recibo', () => {
    expect(ListOrdenesQuerySchema.parse({ sin_recibo: '1' }).sin_recibo).toBe('1')
  })

  it('alta/edición del proveedor aceptan datos fiscales; la puerta del contador no', () => {
    expect(CreateProveedorSchema.safeParse({ razon_social: 'Ferretería', domicilio: 'Calle 1', provincia: 'Salta', condicion_iva_id: 6 }).success).toBe(true)
    expect(UpdateProveedorSchema.safeParse({ condicion_iva_id: null, domicilio: null }).success).toBe(true)
    expect(UpdateProveedorSchema.safeParse({ condicion_iva_id: 99 }).success).toBe(false)
    expect(DatosPagoSchema.safeParse({ domicilio: 'x' }).success).toBe(false)
    expect(DatosPagoSchema.safeParse({ condicion_iva_id: 1 }).success).toBe(false)
  })
})

// ── Foto del cheque → adjunto de la OP ──────────────────────────────────────

describe('foto del cheque al emitir la OP', () => {
  it('adjuntosDeCheques: tipo cheque, obs «Cheque N° X», una foto para dos cheques, sin repetir paths', () => {
    const r = adjuntosDeCheques([
      { numero: '111', foto_path: 'ordenes/pendientes/a.jpg' },
      { numero: '222', foto_path: 'ordenes/pendientes/a.jpg' },
      { numero: '333', foto_path: 'ordenes/pendientes/b.pdf' },
      { numero: '444', foto_path: null },
      { numero: '555', foto_path: 'ordenes/pendientes/c.png' },
    ], [{ storage_path: 'ordenes/pendientes/c.png' }])
    expect(r).toEqual([
      { tipo: 'cheque', storage_path: 'ordenes/pendientes/a.jpg', nombre_archivo: 'cheque-111-222.jpg', mime_type: 'image/jpeg', obs: 'Cheques N° 111, 222' },
      { tipo: 'cheque', storage_path: 'ordenes/pendientes/b.pdf', nombre_archivo: 'cheque-333.pdf', mime_type: 'application/pdf', obs: 'Cheque N° 333' },
    ])
    expect(() => adjuntosDeCheques([{ numero: '1', foto_path: 'ordenes/9/a.jpg' }])).toThrow()
    expect(() => adjuntosDeCheques([{ numero: '1', foto_path: 'ordenes/pendientes/a.exe' }])).toThrow()
  })

  it('chequesParaRpc saca foto_path', () => {
    expect(chequesParaRpc([{ numero: '1', monto: 1, foto_path: 'x' }])).toEqual([{ numero: '1', monto: 1 }])
  })

  it('POST /ordenes adjunta la foto como tipo cheque y la RPC recibe el cheque sin foto_path', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, clase: 'factura', created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', {
      proveedor_id: 1, fecha: HOY, forma_pago: 'cheque', lineas: [{ factura_id: 5, monto: 100 }],
      cheques: [{ numero: '12345678', banco: 'Galicia', fecha_cobro: HOY, monto: 100, foto_path: 'ordenes/pendientes/ch.jpg' }],
    })
    expect(res.status).toBe(200)
    const args = llamada('pagos_registrar_orden')!
    const adj = args.p_adjuntos as Fila[]
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ tipo: 'cheque', storage_path: 'ordenes/pendientes/ch.jpg', obs: 'Cheque N° 12345678', mime_type: 'image/jpeg' })
    expect(typeof adj[0]!.hash_sha256).toBe('string')
    const cheques = (args.p_orden as Fila).cheques as Fila[]
    expect(cheques[0]).not.toHaveProperty('foto_path')
    expect(cheques[0]).toMatchObject({ numero: '12345678', monto: 100 })
  })

  it('la foto del cheque NO reemplaza el comprobante de un echeq (COMPROBANTE_REQUERIDO)', async () => {
    state.profile = CONTADOR
    state.facturas = [{ id: 5, clase: 'factura', created_by: 'otro', aprobada_por: 'diego', proveedor_id: 1 }]
    const res = await post('/ordenes', {
      proveedor_id: 1, fecha: HOY, forma_pago: 'echeq', lineas: [{ factura_id: 5, monto: 100 }],
      cheques: [{ numero: '1', fecha_cobro: HOY, monto: 100, foto_path: 'ordenes/pendientes/ch.jpg' }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('COMPROBANTE_REQUERIDO')
  })
})

describe('auditoría de las rutas nuevas', () => {
  it.each([
    ['POST', '/api/pagos/proveedores/7/actualizar-desde-arca', { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'actualizar desde el padrón de ARCA', entidadId: '7' }],
    ['POST', '/api/pagos/proveedores/actualizar-desde-arca', { modulo: 'pagos', entidad: 'proveedor (pagos)', accion: 'actualizar desde el padrón de ARCA' }],
    ['POST', '/api/pagos/cheques/leer', { modulo: 'pagos', entidad: 'cheque', accion: 'leer comprobante' }],
  ] as const)('%s %s', (method, path, esperado) => {
    expect(parseRoute(path, method)).toEqual(esperado)
  })

  it('consultar el padrón (GET) no se audita', () => {
    expect(parseRoute(`/api/pagos/proveedores/padron/${CUIT_OK}`, 'GET')).toBeNull()
  })
})
