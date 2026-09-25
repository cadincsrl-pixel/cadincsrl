/**
 * Montos de ARCA con vigencia (tanda 6, 20260929e): guardias, lo que llega a
 * las RPC, cache y fallback a las constantes, y que los chequeos previos a la
 * RPC (CF_REQUIERE_IDENTIFICACION, FCE) usen el valor vigente a la fecha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Fila | null,
    rpcs: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
    error: null as { message: string; details?: string } | null,
    vigentes: null as unknown,
    vigentesFalla: false,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

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
    from: (t: string) => chain(
      t === 'profiles' ? state.profile
        : t === 'ventas_clientes' ? { id: 1, doc_tipo: 99, doc_nro: '0', condicion_iva_id: 5 }
          : null),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      if (fn === 'ventas_parametros_vigentes') {
        if (state.vigentesFalla) return { data: null, error: { message: 'connection refused' } }
        return { data: state.vigentes, error: null }
      }
      if (state.error) return { data: null, error: state.error }
      if (fn === 'ventas_parametros_json') return { data: [{ id: 1, clave: 'monto_minimo_fce', valor: 5549862, estado: 'vigente' }], error: null }
      if (fn === 'ventas_guardar_parametro') return { data: { id: 9, ...(args?.p as Fila), estado: 'futuro' }, error: null }
      if (fn === 'ventas_borrar_parametro') return { data: { id: args?.p_id }, error: null }
      return { data: null, error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import fact from '../../../src/modules/facturacion/facturacion.routes.js'
import { parametrosService, normalizarVigentes } from '../../../src/modules/facturacion/parametros.service.js'
import { resolverTipo } from '../../../src/modules/facturacion/facturas.service.js'
import { supabase } from '../../../src/lib/supabase.js'
import { MONTO_MINIMO_FCE, TOPE_CF_IDENTIFICACION } from '../../../src/modules/facturacion/reglas.js'

const perfil = (p: Fila | null, rol = 'operador'): Fila => ({ rol, activo: true, rol_base: null, permisos: p ? { facturacion: p } : {} })
const LECTOR = perfil({ lectura: true, tabs: ['facturas'] })
const CON_TAB_SIN_FLAG = perfil({ lectura: true, tabs: ['configuracion'] })
const CONFIGURADOR = perfil({ lectura: true, tabs: ['configuracion'], configurar: true })

const enviar = (method: 'POST' | 'DELETE', path: string, body?: unknown) =>
  fact.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

beforeEach(() => {
  state.rpcs.length = 0
  state.error = null
  state.vigentes = { fecha: '2026-09-25', monto_minimo_fce: 5549862, tope_cf_identificacion: 10000000 }
  state.vigentesFalla = false
  parametrosService.olvidarCache()
})

describe('normalizarVigentes (pura)', () => {
  it('acepta números > 0 y rechaza lo demás', () => {
    expect(normalizarVigentes({ fecha: '2026-01-01', monto_minimo_fce: '5549862.00', tope_cf_identificacion: 1e7 }, 'x'))
      .toEqual({ fecha: '2026-01-01', monto_minimo_fce: 5549862, tope_cf_identificacion: 1e7 })
    expect(normalizarVigentes(null, 'x')).toBeNull()
    expect(normalizarVigentes({ monto_minimo_fce: 0, tope_cf_identificacion: 1 }, 'x')).toBeNull()
    expect(normalizarVigentes({ monto_minimo_fce: 1 }, 'x')).toBeNull()
  })
})

describe('GET /parametros y /parametros/vigentes', () => {
  it('con lectura alcanza (sin tab); la clave y la fecha llegan a la RPC', async () => {
    state.profile = LECTOR
    let r = await fact.request('/parametros?clave=monto_minimo_fce')
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_parametros_json', args: { p_clave: 'monto_minimo_fce' } })
    r = await fact.request('/parametros/vigentes?fecha=2026-12-01')
    expect(r.status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_parametros_vigentes', args: { p_fecha: '2026-12-01' } })
    expect(await r.json()).toMatchObject({ monto_minimo_fce: 5549862, tope_cf_identificacion: 10000000 })
  })

  it('clave o fecha inválidas → 400', async () => {
    state.profile = LECTOR
    expect((await fact.request('/parametros?clave=otra')).status).toBe(400)
    expect((await fact.request('/parametros/vigentes?fecha=25/09/2026')).status).toBe(400)
  })

  it('sin lectura → 403', async () => {
    state.profile = perfil(null)
    expect((await fact.request('/parametros')).status).toBe(403)
  })
})

describe('vigentes: cache y fallback', () => {
  it('cachea por fecha; una escritura lo invalida', async () => {
    await parametrosService.vigentes('2026-09-25', supabase)
    await parametrosService.vigentes('2026-09-25', supabase)
    expect(state.rpcs.filter((x) => x.fn === 'ventas_parametros_vigentes')).toHaveLength(1)
    await parametrosService.crear({ clave: 'monto_minimo_fce', valor: 6e6, vigente_desde: '2026-12-01', forzar: false }, 'u-1', supabase)
    await parametrosService.vigentes('2026-09-25', supabase)
    expect(state.rpcs.filter((x) => x.fn === 'ventas_parametros_vigentes')).toHaveLength(2)
  })

  it('la base falla o devuelve basura → las constantes, sin lanzar y sin cachear', async () => {
    state.vigentesFalla = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await parametrosService.vigentes('2026-09-25', supabase))
      .toEqual({ fecha: '2026-09-25', monto_minimo_fce: MONTO_MINIMO_FCE, tope_cf_identificacion: TOPE_CF_IDENTIFICACION })
    err.mockRestore()
    state.vigentesFalla = false
    state.vigentes = null
    expect((await parametrosService.vigentes('2026-09-25', supabase)).monto_minimo_fce).toBe(MONTO_MINIMO_FCE)
    state.vigentes = { fecha: '2026-09-25', monto_minimo_fce: 7e6, tope_cf_identificacion: 2e7 }
    expect((await parametrosService.vigentes('2026-09-25', supabase)).monto_minimo_fce).toBe(7e6)
  })
})

describe('POST /parametros', () => {
  it('sin tab / sin flag → 403 y no llama a la RPC', async () => {
    state.profile = LECTOR
    const body = { clave: 'monto_minimo_fce', valor: 6000000, vigente_desde: '2026-12-01' }
    expect((await enviar('POST', '/parametros', body)).status).toBe(403)
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('POST', '/parametros', body)).status).toBe(403)
    expect(state.rpcs.find((x) => x.fn === 'ventas_guardar_parametro')).toBeUndefined()
  })

  it('201; forzar va como p_forzar y no dentro de p', async () => {
    state.profile = CONFIGURADOR
    const r = await enviar('POST', '/parametros', { clave: 'tope_cf_identificacion', valor: '15000000', vigente_desde: '2026-12-01', fuente: ' RG 9999 ', forzar: true })
    expect(r.status).toBe(201)
    expect(state.rpcs).toContainEqual({
      fn: 'ventas_guardar_parametro',
      args: { p: { clave: 'tope_cf_identificacion', valor: 15000000, vigente_desde: '2026-12-01', fuente: 'RG 9999' }, p_user_id: 'u-1', p_forzar: true },
    })
  })

  it('validación → 400 PARAMETRO_INVALIDO con el campo', async () => {
    state.profile = CONFIGURADOR
    let r = await enviar('POST', '/parametros', { clave: 'otra', valor: 1, vigente_desde: '2026-12-01' })
    expect(await r.json()).toMatchObject({ error: 'PARAMETRO_INVALIDO', campo: 'clave' })
    r = await enviar('POST', '/parametros', { clave: 'monto_minimo_fce', valor: 0, vigente_desde: '2026-12-01' })
    expect(await r.json()).toMatchObject({ error: 'PARAMETRO_INVALIDO', campo: 'valor' })
    r = await enviar('POST', '/parametros', { clave: 'monto_minimo_fce', valor: 1.234, vigente_desde: '2026-12-01' })
    expect(await r.json()).toMatchObject({ error: 'PARAMETRO_INVALIDO', campo: 'valor' })
    r = await enviar('POST', '/parametros', { clave: 'monto_minimo_fce', valor: 1, vigente_desde: '2026-12-01', id: 3 })
    expect(await r.json()).toMatchObject({ error: 'PARAMETRO_INVALIDO', campo: 'id' })
  })

  it('retroactivo y duplicado de la base → 409 con el detalle', async () => {
    state.profile = CONFIGURADOR
    state.error = { message: 'PARAMETRO_RETROACTIVO', details: '{"campo":"vigente_desde","facturas":5}' }
    let r = await enviar('POST', '/parametros', { clave: 'monto_minimo_fce', valor: 6e6, vigente_desde: '2026-09-01' })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'PARAMETRO_RETROACTIVO', detail: { facturas: 5 } })
    state.error = { message: 'PARAMETRO_DUPLICADO' }
    r = await enviar('POST', '/parametros', { clave: 'monto_minimo_fce', valor: 6e6, vigente_desde: '2026-12-01' })
    expect(r.status).toBe(409)
  })
})

describe('DELETE /parametros/:id', () => {
  it('guardias, RPC y 409 PARAMETRO_YA_VIGENTE', async () => {
    state.profile = CON_TAB_SIN_FLAG
    expect((await enviar('DELETE', '/parametros/3')).status).toBe(403)
    state.profile = CONFIGURADOR
    expect((await enviar('DELETE', '/parametros/3')).status).toBe(200)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_borrar_parametro', args: { p_id: 3, p_user_id: 'u-1' } })
    state.error = { message: 'PARAMETRO_YA_VIGENTE' }
    expect((await enviar('DELETE', '/parametros/1')).status).toBe(409)
  })
})

describe('resolverTipo usa el tope vigente a la fecha del comprobante', () => {
  const renglones = [{ descripcion: 'x', cantidad: 1, precio_unit: 10_000_000 / 1.21, alicuota_id: 5 }]
  const factura = (fecha_cbte?: string) => ({ cliente_id: 1, fecha_cbte, producto: 'AVANCE DE OBRA' }) as any

  it('con el tope de hoy (10 M) un CF de ~10 M se rechaza; con un tope mayor a esa fecha, pasa', async () => {
    await expect(resolverTipo(factura('2026-09-25'), renglones as any, supabase)).rejects.toMatchObject({ code: 'CF_REQUIERE_IDENTIFICACION' })
    state.vigentes = { fecha: '2027-01-10', monto_minimo_fce: 5549862, tope_cf_identificacion: 20_000_000 }
    expect(await resolverTipo(factura('2027-01-10'), renglones as any, supabase)).toBe(6)
    expect(state.rpcs).toContainEqual({ fn: 'ventas_parametros_vigentes', args: { p_fecha: '2027-01-10' } })
  })
})
