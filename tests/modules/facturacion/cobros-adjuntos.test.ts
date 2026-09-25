/**
 * Documentación del cliente en el cobro (20260924q, `ventas_cobro_adjuntos`):
 * guardias, hash calculado en el server, movimiento a `cobros/<id>/`,
 * adjuntos en POST /cobros (con `adjuntos_error` si fallan después de la RPC)
 * y auditoría de las rutas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

type Fila = Record<string, unknown>
const { fromMock, rpcMock, storage, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  storage: {
    move: vi.fn(), remove: vi.fn(), download: vi.fn(), createSignedUploadUrl: vi.fn(), createSignedUrl: vi.fn(),
  },
  state: {
    profile: null as Fila | null,
    inserts: [] as Fila[],
    insertError: null as Fila | null,
    adjunto: null as Fila | null,
  },
}))

vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))
vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

function chain(data: unknown | (() => unknown), opts: { onInsert?: (v: Fila) => void; error?: () => Fila | null } = {}) {
  const obj: any = {}
  const self = () => obj
  let inserto = false
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'gt', 'lt', 'ilike', 'order', 'range', 'limit', 'update', 'delete']) obj[m] = self
  obj.insert = (v: Fila) => { inserto = true; opts.onInsert?.(v); return obj }
  const res = () => {
    // El error configurado aplica solo al insert (o a todo si no hay insert handler).
    const error = (opts.onInsert ? (inserto ? opts.error?.() : null) : opts.error?.()) ?? null
    const d = typeof data === 'function' ? (data as () => unknown)() : data
    return { data: error ? null : d, error }
  }
  const uno = () => Promise.resolve((() => { const r = res(); return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data } })())
  obj.single = uno
  obj.maybeSingle = uno
  obj.then = (ok: any, ko: any) => Promise.resolve(res()).then(ok, ko)
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

import fact from '../../../src/modules/facturacion/facturacion.routes.js'
import { parseRoute } from '../../../src/middleware/audit.js'
import { AdjuntoCobroSchema } from '../../../src/modules/facturacion/facturacion.schema.js'

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}) => fact.request(path, { method: 'POST', ...json(body) })
const del = (path: string) => fact.request(path, { method: 'DELETE' })

const perfil = (p: Fila): Fila => ({ rol: 'operador', activo: true, rol_base: null, permisos: { facturacion: p } })
const MARIANA = perfil({ lectura: true, tabs: ['cobranzas', 'deudores'], registrar_cobros: true, anular_cobros: true })
const ALINA = perfil({ lectura: true, tabs: ['cobranzas', 'deudores'] })
const SOLO_ANULA = perfil({ lectura: true, tabs: ['cobranzas'], anular_cobros: true })

const PDF = Buffer.from('%PDF-1.4 prueba')
const HASH = createHash('sha256').update(PDF).digest('hex')
const DETALLE = { cobro: { id: 9, numero_fmt: 'RC 0001-00000002', total: 100, aplicado: 0 }, medios: [], retenciones: [], imputaciones: [] }
const ADJ = { tipo: 'comprobante_pago', storage_path: 'cobros/pendientes/abc.pdf', nombre_archivo: 'transferencia.pdf', mime: 'application/pdf' }

beforeEach(() => {
  fromMock.mockReset(); rpcMock.mockReset()
  for (const f of Object.values(storage)) f.mockReset()
  Object.assign(state, { profile: null, inserts: [], insertError: null, adjunto: null })
  storage.move.mockResolvedValue({ error: null })
  storage.remove.mockResolvedValue({ error: null })
  storage.download.mockResolvedValue({ data: new Blob([PDF]), error: null })
  storage.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: 'https://s/up', token: 't' }, error: null })
  storage.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://s/dl' }, error: null })
  fromMock.mockImplementation((t: string) => {
    if (t === 'profiles') return chain(state.profile)
    if (t === 'ventas_cobros') return chain({ id: 9 })
    if (t === 'ventas_cobro_adjuntos') {
      return chain(() => state.adjunto ?? [], {
        onInsert: (v) => { state.inserts.push(v); state.adjunto = { id: 50, ...v } },
        error: () => state.insertError,
      })
    }
    return chain([])
  })
  rpcMock.mockImplementation(() => chain(DETALLE))
})

describe('adjuntos del cobro — rutas', () => {
  it('upload-url: exige registrar_cobros y devuelve un path en cobros/pendientes/', async () => {
    state.profile = ALINA
    expect((await post('/cobros/adjuntos/upload-url', { nombre_archivo: 'a.pdf', mime_type: 'application/pdf', size_bytes: 10 })).status).toBe(403)
    state.profile = MARIANA
    const r = await post('/cobros/adjuntos/upload-url', { nombre_archivo: 'a.pdf', mime_type: 'application/pdf', size_bytes: 10 })
    expect(r.status).toBe(200)
    expect((await r.json() as any).storage_path).toMatch(/^cobros\/pendientes\/[0-9a-f-]+\.pdf$/)
    const big = await post('/cobros/adjuntos/upload-url', { nombre_archivo: 'a.pdf', mime_type: 'application/pdf', size_bytes: 11 * 1024 * 1024 })
    expect((await big.json() as any).error).toBe('TAMANO_INVALIDO')
  })

  it('adjuntar: hash en el server, mueve a cobros/<id>/ e inserta con el path final', async () => {
    state.profile = MARIANA
    const r = await post('/cobros/9/adjuntos', ADJ)
    expect(r.status).toBe(200)
    expect(storage.move).toHaveBeenCalledWith('cobros/pendientes/abc.pdf', 'cobros/9/abc.pdf')
    expect(state.inserts[0]).toMatchObject({
      cobro_id: 9, tipo: 'comprobante_pago', storage_path: 'cobros/9/abc.pdf', file_hash: HASH, size_bytes: PDF.length, created_by: 'u-1',
    })
  })

  it('adjuntar: un path fuera de cobros/pendientes/ → 400 PATH_INVALIDO', async () => {
    state.profile = MARIANA
    const r = await post('/cobros/9/adjuntos', { ...ADJ, storage_path: 'retenciones/pendientes/abc.pdf' })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('PATH_INVALIDO')
  })

  it('adjuntar el mismo archivo dos veces → 409 ADJUNTO_DUPLICADO y borra la copia', async () => {
    state.profile = MARIANA
    state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "ventas_cobro_adjuntos_hash_uidx"' }
    const r = await post('/cobros/9/adjuntos', ADJ)
    expect(r.status).toBe(409)
    expect((await r.json() as any).error).toBe('ADJUNTO_DUPLICADO')
    expect(storage.remove).toHaveBeenCalledWith(['cobros/9/abc.pdf'])
  })

  it('Alina lista y baja, pero no adjunta ni borra', async () => {
    state.profile = ALINA
    state.adjunto = { id: 50, cobro_id: 9, storage_path: 'cobros/9/abc.pdf', nombre_archivo: 'transferencia.pdf', mime: 'application/pdf' }
    expect((await fact.request('/cobros/9/adjuntos')).status).toBe(200)
    const u = await fact.request('/cobros/adjuntos/50/url')
    expect(u.status).toBe(200)
    expect(await u.json()).toMatchObject({ url: 'https://s/dl', nombre_archivo: 'transferencia.pdf' })
    // PDF: se abre en el navegador (sin download); ?descargar=1 lo baja con su nombre.
    expect(storage.createSignedUrl).toHaveBeenCalledWith('cobros/9/abc.pdf', 900, undefined)
    expect((await fact.request('/cobros/adjuntos/50/url?descargar=1')).status).toBe(200)
    expect(storage.createSignedUrl).toHaveBeenLastCalledWith('cobros/9/abc.pdf', 900, { download: 'transferencia.pdf' })
    expect((await post('/cobros/9/adjuntos', ADJ)).status).toBe(403)
    expect((await del('/cobros/adjuntos/50')).status).toBe(403)
  })

  it('borrar: alcanza con anular_cobros; borra fila y archivo', async () => {
    state.profile = SOLO_ANULA
    state.adjunto = { id: 50, cobro_id: 9, storage_path: 'cobros/9/abc.pdf' }
    const r = await del('/cobros/adjuntos/50')
    expect(r.status).toBe(200)
    expect(storage.remove).toHaveBeenCalledWith(['cobros/9/abc.pdf'])
  })

  it('borrar de un cobro anulado → 409 COBRO_ANULADO (lo frena la base) y el archivo queda', async () => {
    state.profile = MARIANA
    state.adjunto = { id: 50, cobro_id: 7, storage_path: 'cobros/7/abc.pdf' }
    fromMock.mockImplementation((t: string) => {
      if (t === 'profiles') return chain(state.profile)
      if (t === 'ventas_cobro_adjuntos') {
        const c = chain(state.adjunto)
        c.delete = () => chain(null, { error: () => ({ code: 'P0001', message: 'COBRO_ANULADO', details: '{"cobro_id":7}' }) })
        return c
      }
      return chain([])
    })
    const r = await del('/cobros/adjuntos/50')
    expect(r.status).toBe(409)
    expect((await r.json() as any).error).toBe('COBRO_ANULADO')
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('POST /cobros con adjuntos: valida antes de la RPC y los registra después', async () => {
    state.profile = MARIANA
    const r = await post('/cobros', { cobro: { cliente_id: 2 }, medios: [{ forma: 'efectivo', importe: 100 }], adjuntos: [ADJ] })
    expect(r.status).toBe(200)
    expect(state.inserts[0]).toMatchObject({ cobro_id: 9, storage_path: 'cobros/9/abc.pdf', file_hash: HASH })
    expect((await r.json() as any).adjuntos_error).toBeUndefined()
  })

  it('POST /cobros: el mismo archivo dos veces en la tanda frena ANTES de la RPC', async () => {
    state.profile = MARIANA
    const r = await post('/cobros', { cobro: { cliente_id: 2 }, medios: [{ forma: 'efectivo', importe: 100 }],
      adjuntos: [ADJ, { ...ADJ, storage_path: 'cobros/pendientes/otro.pdf' }] })
    expect(r.status).toBe(409)
    expect((await r.json() as any).error).toBe('ADJUNTO_DUPLICADO')
    expect(rpcMock.mock.calls.find((c) => c[0] === 'ventas_registrar_cobro')).toBeUndefined()
  })

  it('POST /cobros: si el insert del adjunto falla, el cobro queda y vuelve adjuntos_error', async () => {
    state.profile = MARIANA
    state.insertError = { code: '23503', message: 'fk' }
    const r = await post('/cobros', { cobro: { cliente_id: 2 }, medios: [{ forma: 'efectivo', importe: 100 }], adjuntos: [ADJ] })
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.cobro.id).toBe(9)
    expect(body.adjuntos_error).toEqual([expect.objectContaining({ indice: 1, nombre_archivo: 'transferencia.pdf' })])
  })
})

describe('adjuntos del cobro — schema y auditoría', () => {
  it('tipo cerrado', () => {
    expect(AdjuntoCobroSchema.safeParse(ADJ).success).toBe(true)
    expect(AdjuntoCobroSchema.safeParse({ ...ADJ, tipo: 'factura' }).success).toBe(false)
  })

  it.each([
    ['POST',   '/api/facturacion/cobros/adjuntos/upload-url',          { accion: 'subir adjunto' }],
    ['POST',   '/api/facturacion/cobros/adjuntos/descartar-pendiente', { accion: 'descartar adjunto pendiente' }],
    ['POST',   '/api/facturacion/cobros/9/adjuntos',                   { accion: 'crear', entidadId: '9' }],
    ['DELETE', '/api/facturacion/cobros/adjuntos/50',                  { accion: 'eliminar', entidadId: '50' }],
  ])('%s %s', (method, path, esperado) => {
    expect(parseRoute(path, method)).toEqual({ modulo: 'facturacion', entidad: 'adjunto del cobro', ...esperado })
  })
})
