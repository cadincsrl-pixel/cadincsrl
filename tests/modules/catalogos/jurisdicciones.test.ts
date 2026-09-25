/**
 * Jurisdicciones (tanda 6, 20260929f): el resolver puro (espejo de
 * _jurisdiccion_resolver), las guardias de /api/catalogos (lectura en
 * cualquiera de los tres módulos; escribir con `configurar` en pagos O en
 * facturacion), lo que llega a la RPC, la cache y la resolución de la
 * lectura IA de facturas de compra.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    rpcs: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
    error: null as { message: string; details?: string } | null,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

const LISTA = [
  { id: 24, nombre: 'Tucumán', tipo: 'provincial', alias: ['tucuman'], activo: true },
  { id: 25, nombre: 'San Miguel de Tucumán', tipo: 'municipal', alias: ['smt', 'san miguel'], activo: true },
  { id: 1, nombre: 'Ciudad Autónoma de Buenos Aires', tipo: 'provincial', alias: ['caba', 'capital federal'], activo: true },
  { id: 2, nombre: 'Buenos Aires', tipo: 'provincial', alias: [], activo: true },
  { id: 90, nombre: 'San Martín', tipo: 'municipal', alias: [], activo: true },
  { id: 91, nombre: 'San Martín', tipo: 'municipal', alias: [], activo: true },
  { id: 92, nombre: 'Vieja', tipo: 'provincial', alias: [], activo: false },
]

function chain(data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit']) obj[m] = () => obj
  obj.single = () => Promise.resolve({ data, error: null })
  obj.maybeSingle = () => Promise.resolve({ data, error: null })
  obj.then = (ok: any, ko: any) => Promise.resolve({ data, error: null }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => chain(t === 'profiles' ? state.profile : null),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      if (state.error) return { data: null, error: state.error }
      if (fn === 'jurisdicciones_json') return { data: LISTA.filter((j) => j.activo || args?.p_incluir_inactivas), error: null }
      if (fn === 'jurisdicciones_sin_normalizar') return { data: [{ texto: 'Pcia X', tabla: 'pagos_factura_tributos', filas: 2 }], error: null }
      if (fn === 'jurisdiccion_guardar') return { data: { id: 77, ...(args?.p as Fila) }, error: null }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import cat from '../../../src/modules/catalogos/catalogos.routes.js'
import { jurisdiccionesService } from '../../../src/modules/catalogos/catalogos.service.js'
import { resolverJurisdiccion } from '../../../src/modules/catalogos/jurisdicciones.js'
import { resolverJurisdiccionesTributos } from '../../../src/modules/pagos/lectura.service.js'
import type { TributoPropuesto } from '../../../src/modules/pagos/lectura/fusion.js'

const perfil = (permisos: Fila, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos })
const enviar = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  cat.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
  jurisdiccionesService.olvidarCache()
})

describe('resolverJurisdiccion (pura)', () => {
  it('por nombre o alias, sin tildes ni mayúsculas', () => {
    expect(resolverJurisdiccion('TUCUMAN', LISTA as any)?.id).toBe(24)
    expect(resolverJurisdiccion('  Tucumán ', LISTA as any)?.id).toBe(24)
    expect(resolverJurisdiccion('San Miguel de Tucumán', LISTA as any)?.id).toBe(25)
    expect(resolverJurisdiccion('Capital Federal', LISTA as any)?.id).toBe(1)
    expect(resolverJurisdiccion('Buenos Aires', LISTA as any)?.id).toBe(2)
  })
  it('ambiguo, inactivo, vacío o desconocido → null', () => {
    expect(resolverJurisdiccion('San Martín', LISTA as any)).toBeNull()
    expect(resolverJurisdiccion('Vieja', LISTA as any)).toBeNull()
    expect(resolverJurisdiccion('', LISTA as any)).toBeNull()
    expect(resolverJurisdiccion(null, LISTA as any)).toBeNull()
    expect(resolverJurisdiccion('Pcia. de Tucumán', LISTA as any)).toBeNull()
  })
})

describe('GET /jurisdicciones', () => {
  it('lectura de pagos, facturacion o contabilidad alcanza', async () => {
    for (const m of ['pagos', 'facturacion', 'contabilidad']) {
      state.profile = perfil({ [m]: { lectura: true } })
      expect((await cat.request('/jurisdicciones')).status).toBe(200)
    }
    expect(state.rpcs).toContainEqual({ fn: 'jurisdicciones_json', args: { p_incluir_inactivas: false } })
  })
  it('incluir_inactivas=1 llega a la RPC; sin-normalizar responde la lista', async () => {
    state.profile = perfil({ pagos: { lectura: true } })
    await cat.request('/jurisdicciones?incluir_inactivas=1')
    expect(state.rpcs).toContainEqual({ fn: 'jurisdicciones_json', args: { p_incluir_inactivas: true } })
    const r = await cat.request('/jurisdicciones/sin-normalizar')
    expect(await r.json()).toEqual([{ texto: 'Pcia X', tabla: 'pagos_factura_tributos', filas: 2 }])
  })
  it('sin lectura en ninguno → 403', async () => {
    state.profile = perfil({ tarja: { lectura: true } })
    expect((await cat.request('/jurisdicciones')).status).toBe(403)
  })
})

describe('POST / PATCH /jurisdicciones', () => {
  const alta = { nombre: 'Yerba Buena', tipo: 'municipal', provincia_id: 24, alias: ['YB'] }

  it('sin configurar → 403 SIN_PERMISO y no llama a la RPC', async () => {
    state.profile = perfil({ pagos: { lectura: true }, facturacion: { lectura: true } })
    const r = await enviar('POST', '/jurisdicciones', alta)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'SIN_PERMISO', detail: { flag: 'configurar' } })
    expect(state.rpcs.find((x) => x.fn === 'jurisdiccion_guardar')).toBeUndefined()
  })

  it('configurar en pagos O en facturacion alcanza; el body llega entero', async () => {
    state.profile = perfil({ pagos: { lectura: true, configurar: true } })
    expect((await enviar('POST', '/jurisdicciones', alta)).status).toBe(201)
    state.profile = perfil({ facturacion: { lectura: true, configurar: true } })
    expect((await enviar('PATCH', '/jurisdicciones/25', { activo: false })).status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'jurisdiccion_guardar', args: { p: alta, p_user_id: 'u-1' } })
    expect(state.rpcs).toContainEqual({ fn: 'jurisdiccion_guardar', args: { p: { activo: false, id: 25 }, p_user_id: 'u-1' } })
  })

  it('validación → 400 JURISDICCION_INVALIDA con el campo', async () => {
    state.profile = perfil({}, 'admin')
    let r = await enviar('POST', '/jurisdicciones', { nombre: 'X', tipo: 'provincial' })
    expect(await r.json()).toMatchObject({ error: 'JURISDICCION_INVALIDA', campo: 'nombre' })
    r = await enviar('POST', '/jurisdicciones', { nombre: 'Xx', tipo: 'pais' })
    expect(await r.json()).toMatchObject({ error: 'JURISDICCION_INVALIDA', campo: 'tipo' })
    r = await enviar('POST', '/jurisdicciones', { nombre: 'Xx', tipo: 'provincial', codigo_comarb: '9x1' })
    expect(await r.json()).toMatchObject({ error: 'JURISDICCION_INVALIDA', campo: 'codigo_comarb' })
    r = await enviar('PATCH', '/jurisdicciones/3', { id: 4 })
    expect(await r.json()).toMatchObject({ error: 'JURISDICCION_INVALIDA', campo: 'id' })
    r = await enviar('PATCH', '/jurisdicciones/abc', { activo: true })
    expect(r.status).toBe(400)
  })

  it('errores de la base → su status con el detalle', async () => {
    state.profile = perfil({}, 'admin')
    state.error = { message: 'JURISDICCION_DUPLICADA', details: '{"campo":"alias","existente_id":25}' }
    let r = await enviar('POST', '/jurisdicciones', alta)
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'JURISDICCION_DUPLICADA', campo: 'alias', detail: { existente_id: 25 } })
    state.error = { message: 'JURISDICCION_POR_DEFECTO' }
    r = await enviar('PATCH', '/jurisdicciones/24', { activo: false })
    expect(r.status).toBe(409)
  })
})

describe('cache de activas y lectura IA', () => {
  it('cachea; una escritura la invalida', async () => {
    await jurisdiccionesService.activas()
    await jurisdiccionesService.activas()
    expect(state.rpcs.filter((x) => x.fn === 'jurisdicciones_json')).toHaveLength(1)
    await jurisdiccionesService.editar(24, { alias: ['tucu'] }, 'u-1')
    await jurisdiccionesService.activas()
    expect(state.rpcs.filter((x) => x.fn === 'jurisdicciones_json')).toHaveLength(2)
  })

  it('la base falla → lista vacía, sin lanzar', async () => {
    state.error = { message: 'connection refused' }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await jurisdiccionesService.activas()).toEqual([])
    err.mockRestore()
  })

  it('resolverJurisdiccionesTributos: id + nombre canónico si resuelve; si no, queda el texto', async () => {
    const t = (jurisdiccion: string | null): TributoPropuesto =>
      ({ tipo: 'percepcion_iibb', jurisdiccion, descripcion: '', alicuota: null, base_imp: null, importe: 1 })
    const trib = [t('TUCUMAN'), t('Pcia. rara'), t(null)]
    await resolverJurisdiccionesTributos(trib)
    expect(trib.map((x) => [x.jurisdiccion, x.jurisdiccion_id])).toEqual([['Tucumán', 24], ['Pcia. rara', null], [null, null]])
  })
})
