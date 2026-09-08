/**
 * Contrato HTTP de los endpoints de materiales del catálogo.
 * Lo consume el frontend (modal "¿no será este?" del alta de material), así
 * que el shape de la respuesta 409 está fijado acá a propósito.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type FilaLite = { id: number; nombre: string; unidad: string | null; alias: string[] }

const { estado } = vi.hoisted(() => ({
  estado: {
    materiales: [] as FilaLite[],
    ultimoInsert: null as any,
    filtros: [] as Array<[string, unknown]>,
    // Fila de v_catalogo_materiales para el PATCH de precio (20260911).
    catalogoFila: null as any,
    rpcLlamadas: [] as Array<{ fn: string; args: any }>,
    puedeCatalogo: true,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-uuid', email: 'u@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso:   () => async (_c: any, next: any) => next(),
  requirePermisoOr: () => async (_c: any, next: any) => next(),
  requireTab:       () => async (_c: any, next: any) => next(),
  puedeActualizarCatalogo: async () => estado.puedeCatalogo,
}))

vi.mock('../../../src/lib/supabase.js', () => {
  function tabla(nombre?: string) {
    let modo: 'select' | 'insert' | 'update' = 'select'
    let rango: [number, number] = [0, 999]
    function resolver() {
      if (nombre === 'v_catalogo_materiales') return { data: estado.catalogoFila, error: null }
      if (modo === 'insert') return { data: estado.ultimoInsert, error: null }
      if (modo === 'update') return { data: { id: 1 }, error: null }
      return { data: estado.materiales.slice(rango[0], rango[1] + 1), error: null }
    }
    const obj: any = {
      select: () => obj,
      eq:     (col: string, val: unknown) => { estado.filtros.push([col, val]); return obj },
      order:  () => obj,
      range:  (a: number, b: number) => { rango = [a, b]; return obj },
      insert: (v: any) => { modo = 'insert'; estado.ultimoInsert = v; return obj },
      update: (v: any) => { modo = 'update'; return obj },
      single:      () => Promise.resolve(resolver()),
      maybeSingle: () => Promise.resolve(resolver()),
      then: (f: any) => Promise.resolve(resolver()).then(f),
    }
    return obj
  }
  const cliente = {
    from: (t?: string) => tabla(t),
    storage: { from: () => ({}) },
    rpc: async (fn: string, args: any) => {
      estado.rpcLlamadas.push({ fn, args })
      if (fn === 'unidad_compatible') return { data: args.p_renglon === args.p_ficha, error: null }
      return { data: null, error: null }
    },
  }
  return { createSupabaseClient: () => cliente, supabase: cliente }
})

import stock from '../../../src/modules/stock/stock.routes.js'

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  estado.materiales   = []
  estado.ultimoInsert = null
  estado.filtros      = []
  estado.catalogoFila = null
  estado.rpcLlamadas  = []
  estado.puedeCatalogo = true
})

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// El precio del catalogo va por fijar_precio_ref (historial) y "usar ultima
// compra" exige que la unidad de esa compra sea la de la ficha (20260911).
describe('PATCH /materiales/:id — precio_ref', () => {
  it('rechaza 409 UNIDAD_DISTINTA cuando "usar ultima compra" viene de otra unidad', async () => {
    estado.catalogoFila = { unidad: 'lata', precio_ref: 247132, uc_precio: 14463, uc_unidad: 'lt', uc_unidad_ok: false }
    const res  = await stock.request('/materiales/799', patch({ precio_ref: 14463, precio_fuente: 'ultima_compra' }))
    const body = await res.json() as any
    expect(res.status).toBe(409)
    expect(body.code).toBe('UNIDAD_DISTINTA')
    expect(body).toMatchObject({ unidad_ficha: 'lata', unidad_compra: 'lt' })
    expect(estado.rpcLlamadas).toHaveLength(0)
  })

  it('sin precio_fuente, si el numero coincide con la ultima compra se trata igual', async () => {
    estado.catalogoFila = { unidad: 'lata', precio_ref: 247132, uc_precio: 14463, uc_unidad: 'lt', uc_unidad_ok: false }
    const res = await stock.request('/materiales/799', patch({ precio_ref: 14463 }))
    expect(res.status).toBe(409)
    expect(estado.rpcLlamadas).toHaveLength(0)
  })

  it('manual pasa por fijar_precio_ref con fuente manual, aunque la ultima compra este en otra unidad', async () => {
    estado.catalogoFila = { unidad: 'lata', precio_ref: 247132, uc_precio: 14463, uc_unidad: 'lt', uc_unidad_ok: false }
    const res = await stock.request('/materiales/799', patch({ precio_ref: 14463, precio_fuente: 'manual' }))
    expect(res.status).toBe(200)
    expect(estado.rpcLlamadas).toEqual([{ fn: 'fijar_precio_ref', args: {
      p_material_id: 799, p_precio: 14463, p_fuente: 'manual', p_item_id: null, p_user_id: 'user-uuid',
    } }])
  })

  // Hallazgo de la revision (2026-09-08): el modal de edicion manda el form
  // entero con el precio sin tocar. Eso es un no-op, no "usar ultima compra":
  // 7 fichas activas quedaban ineditables porque su precio ya era el de una
  // compra en otra unidad.
  it('el form entero con el precio sin cambiar es un no-op: 200 y sin RPC, aunque la ultima compra este en otra unidad', async () => {
    estado.catalogoFila = { unidad: 'unid', precio_ref: 8080.72, uc_precio: 8080.72, uc_unidad: 'bolsa', uc_unidad_ok: false }
    const res = await stock.request('/materiales/318', patch({ nombre: 'Espaciador autonivelante 2mm x 150u', precio_ref: 8080.72, alias: ['espaciadores'] }))
    expect(res.status).toBe(200)
    expect(estado.rpcLlamadas).toHaveLength(0)
  })

  it('en un form entero, un precio que coincide con la ultima compra es edicion manual, no "usar"', async () => {
    estado.catalogoFila = { unidad: 'lata', precio_ref: 247132, uc_precio: 14463, uc_unidad: 'lt', uc_unidad_ok: false }
    const res = await stock.request('/materiales/799', patch({ nombre: 'Loxon x 20 lts', precio_ref: 14463 }))
    expect(res.status).toBe(200)
    expect(estado.rpcLlamadas.map(r => r.fn)).toEqual(['fijar_precio_ref'])
    expect(estado.rpcLlamadas[0].args.p_fuente).toBe('manual')
  })

  it('cambiar la unidad y usar la ultima compra en el mismo PATCH se evalua contra la unidad NUEVA', async () => {
    estado.catalogoFila = { unidad: 'lata', precio_ref: 247132, uc_precio: 26620, uc_unidad: 'lt', uc_unidad_ok: false }
    const res = await stock.request('/materiales/788', patch({ unidad: 'lt', precio_ref: 26620, precio_fuente: 'ultima_compra' }))
    expect(res.status).toBe(200)
    expect(estado.rpcLlamadas.map(r => r.fn)).toEqual(['unidad_compatible', 'fijar_precio_ref'])
  })

  it('sin permiso de catalogo, cambiar el precio es 403 y no toca nada', async () => {
    estado.puedeCatalogo = false
    estado.catalogoFila = { unidad: 'bolsa', precio_ref: 11000, uc_precio: null, uc_unidad: null, uc_unidad_ok: false }
    const res = await stock.request('/materiales/12', patch({ precio_ref: 12000 }))
    const body = await res.json() as any
    expect(res.status).toBe(403)
    expect(body.code).toBe('SIN_PERMISO_CATALOGO')
    expect(estado.rpcLlamadas).toHaveLength(0)
  })

  it('"usar ultima compra" sin compra es 409 SIN_ULTIMA_COMPRA, no UNIDAD_DISTINTA', async () => {
    estado.catalogoFila = { unidad: 'bolsa', precio_ref: 11000, uc_precio: null, uc_unidad: null, uc_unidad_ok: false }
    const res = await stock.request('/materiales/12', patch({ precio_ref: 9000, precio_fuente: 'ultima_compra' }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).code).toBe('SIN_ULTIMA_COMPRA')
  })

  it('"usar ultima compra" con unidad compatible pasa con fuente ultima_compra', async () => {
    estado.catalogoFila = { unidad: 'bolsa', precio_ref: 11000, uc_precio: 12500, uc_unidad: 'bolsa', uc_unidad_ok: true }
    const res = await stock.request('/materiales/12', patch({ precio_ref: 12500, precio_fuente: 'ultima_compra' }))
    expect(res.status).toBe(200)
    expect(estado.rpcLlamadas[0]?.args?.p_fuente).toBe('ultima_compra')
  })
})

describe('GET /materiales', () => {
  it('filtra activo=true por defecto', async () => {
    await stock.request('/materiales')
    expect(estado.filtros).toContainEqual(['activo', true])
  })

  it('con ?incluir_inactivos=1 no filtra por activo', async () => {
    await stock.request('/materiales?incluir_inactivos=1')
    expect(estado.filtros).not.toContainEqual(['activo', true])
  })
})

describe('GET /materiales/parecidos', () => {
  it('devuelve los candidatos del "¿no será este?" sin crear nada', async () => {
    estado.materiales = [{ id: 122, nombre: 'Esmalte sintético x 4lts', unidad: 'lt', alias: ['cod 7055'] }]
    const res  = await stock.request('/materiales/parecidos?nombre=' + encodeURIComponent('pintura cod7055 x 4l'))
    const body = await res.json() as any
    expect(res.status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: 122, motivo: 'codigo', por_codigo: true })
    expect(estado.ultimoInsert).toBeNull()
  })

  it('rechaza un nombre de menos de 2 caracteres', async () => {
    const res = await stock.request('/materiales/parecidos?nombre=a')
    expect(res.status).toBe(400)
  })
})

describe('POST /materiales', () => {
  it('devuelve 409 MATERIAL_PARECIDO con los candidatos', async () => {
    estado.materiales = [{ id: 7, nombre: 'Lija al agua N°150', unidad: 'unid', alias: [] }]
    const res  = await stock.request('/materiales', json({ rubro_id: 1, nombre: 'Lija al agua N°180' }))
    const body = await res.json() as any

    expect(res.status).toBe(409)
    expect(body.code).toBe('MATERIAL_PARECIDO')
    expect(typeof body.error).toBe('string')
    expect(body.candidatos).toHaveLength(1)
    expect(body.candidatos[0]).toEqual({
      id: 7, nombre: 'Lija al agua N°150', unidad: 'unid',
      sim: expect.any(Number), por_alias: false, por_codigo: false,
      palabras: expect.any(Number), precision: expect.any(Number), motivo: 'nombre',
    })
  })

  it('devuelve 400 NOMBRE_ES_CODIGO si el nombre es solo un código', async () => {
    const res  = await stock.request('/materiales', json({ rubro_id: 1, nombre: 'cod 7055' }))
    const body = await res.json() as any
    expect(res.status).toBe(400)
    expect(body.code).toBe('NOMBRE_ES_CODIGO')
    expect(estado.ultimoInsert).toBeNull()
  })

  it('con forzar:true crea igual (201) y guarda alias normalizados', async () => {
    estado.materiales = [{ id: 7, nombre: 'Lija al agua N°150', unidad: 'unid', alias: [] }]
    const res = await stock.request('/materiales', json({
      rubro_id: 1, nombre: 'Lija al agua N°180', alias: ['Lija 180'], forzar: true,
    }))
    expect(res.status).toBe(201)
    expect(estado.ultimoInsert.alias).toEqual(['lija 180'])
  })
})
