/**
 * Contrato HTTP del catálogo de tipos de herramienta (/api/herramientas/tipos).
 * Lo consume HerrCatalogo.tsx del frontend: el 409 TIPO_DUPLICADO con
 * `candidatos`, la limpieza de sinónimos y la propagación del rename a pedidos
 * y pañol están fijados acá a propósito.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

type Tipo = { id: number; nombre: string; alias: string[] | null; clase: string; activo: boolean; obs?: string | null }

const { estado } = vi.hoisted(() => ({
  estado: {
    tipos: [] as Tipo[],
    updates: [] as Array<{ tabla: string; valores: Record<string, unknown>; filtros: Array<[string, unknown]> }>,
    inserts: [] as Array<{ tabla: string; valores: Record<string, unknown> }>,
    insertError: null as null | { code: string; message: string },
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpcResultado: { data: null as unknown, error: null as null | { message: string } },
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso:   () => async (_c: any, next: any) => next(),
  requirePermisoOr: () => async (_c: any, next: any) => next(),
}))

// Cliente Supabase de mentira: stock_materiales y v_herr_tipos leen de
// `estado.tipos` filtrando por los .eq() encadenados; insert/update quedan
// registrados (y aplicados en memoria) para poder asegurar sobre ellos.
vi.mock('../../../src/lib/supabase.js', () => {
  function tabla(nombre: string) {
    let modo: 'select' | 'insert' | 'update' = 'select'
    const filtros: Array<[string, unknown]> = []
    let valores: Record<string, unknown> = {}
    const pasa = (t: Tipo) => filtros.every(([col, val]) => (t as any)[col] === val)
    function filas() {
      if (nombre === 'stock_rubros')  return [{ id: 26, nombre: 'Herramientas y máquinas' }]
      if (nombre === 'herr_entregas') return []
      const base = nombre === 'v_herr_tipos' ? estado.tipos.filter(t => t.clase === 'herramienta') : estado.tipos
      // copias: la ruta compara lo leído antes con lo escrito después
      return base.filter(pasa).map(t => ({ ...t, alias: t.alias ? [...t.alias] : t.alias }))
    }
    function resolver(uno: boolean) {
      if (modo === 'insert') {
        if (estado.insertError) return { data: null, error: estado.insertError }
        const id = 899 + estado.inserts.length
        estado.tipos.push({ id, nombre: String(valores.nombre), alias: (valores.alias as string[]) ?? [], clase: 'herramienta', activo: true })
        return { data: { id }, error: null }
      }
      if (modo === 'update') {
        if (nombre === 'stock_materiales') for (const t of estado.tipos) if (pasa(t)) Object.assign(t, valores)
        return { data: null, error: null }
      }
      const f = filas()
      return { data: uno ? (f[0] ?? null) : f, error: null }
    }
    const obj: any = {
      select: () => obj,
      eq:     (col: string, val: unknown) => { filtros.push([col, val]); return obj },
      neq:    () => obj,
      order:  () => obj,
      limit:  () => obj,
      insert: (v: Record<string, unknown>) => { modo = 'insert'; valores = v; estado.inserts.push({ tabla: nombre, valores: v }); return obj },
      update: (v: Record<string, unknown>) => { modo = 'update'; valores = v; estado.updates.push({ tabla: nombre, valores: v, filtros }); return obj },
      single:      () => Promise.resolve(resolver(true)),
      maybeSingle: () => Promise.resolve(resolver(true)),
      then: (ok: any, ko?: any) => Promise.resolve(resolver(false)).then(ok, ko),
    }
    return obj
  }
  const cliente = {
    from: (n: string) => tabla(n),
    rpc:  (fn: string, args: Record<string, unknown>) => { estado.rpc.push({ fn, args }); return Promise.resolve(estado.rpcResultado) },
  }
  return { createSupabaseClient: () => cliente, supabase: cliente }
})

import tipos from '../../../src/modules/herramientas/tipos.routes.js'

// En producción el usuario lo pone authMiddleware en herramientas.routes.ts;
// acá lo simula un middleware mínimo.
const app = new Hono()
app.use('*', async (c, next) => { (c as any).set('user', { id: 'user-uuid', email: 'u@example.com' }); await next() })
app.route('/', tipos)

const json = (method: string, body: unknown) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const ids = (rows: Array<{ id: number }>) => rows.map(r => r.id)

beforeEach(() => {
  estado.tipos = [
    { id: 1, nombre: 'Prolongación 10m',         alias: ['alargue 10 m', 'prolongador'], clase: 'herramienta', activo: true },
    { id: 2, nombre: 'Amoladora angular 4 1/2"', alias: ['amoladora chica'],             clase: 'herramienta', activo: true },
    { id: 3, nombre: 'Alargue viejo',            alias: [],                              clase: 'herramienta', activo: false },
    { id: 4, nombre: 'Cemento x 50kg',           alias: ['cemento'],                     clase: 'material',    activo: true },
  ]
  estado.updates = []
  estado.inserts = []
  estado.insertError = null
  estado.rpc = []
  estado.rpcResultado = { data: null, error: null }
})

describe('GET /tipos', () => {
  it('solo activos por defecto; con ?inactivos=1 también los de baja', async () => {
    expect(ids(await (await app.request('/tipos')).json())).toEqual([1, 2])
    expect(ids(await (await app.request('/tipos?inactivos=1')).json())).toEqual([1, 2, 3])
  })

  it('busca por nombre o sinónimo sin tildes ni mayúsculas', async () => {
    expect(ids(await (await app.request('/tipos?q=ALARGUE')).json())).toEqual([1])
    expect(ids(await (await app.request('/tipos?q=prolongacion')).json())).toEqual([1])
    expect(ids(await (await app.request('/tipos?q=cemento')).json())).toEqual([])
  })
})

describe('POST /tipos', () => {
  it('409 TIPO_DUPLICADO con candidatos si el nombre choca con el sinónimo de otro tipo', async () => {
    const res = await app.request('/tipos', json('POST', { nombre: 'Alargue 10 M' }))
    expect(res.status).toBe(409)
    const b = await res.json()
    expect(b.error).toBe('TIPO_DUPLICADO')
    expect(b.candidatos).toEqual([{ id: 1, nombre: 'Prolongación 10m' }])
    expect(estado.inserts).toHaveLength(0)
  })

  it('un tipo dado de baja no bloquea el nombre', async () => {
    const res = await app.request('/tipos', json('POST', { nombre: 'alargue viejo' }))
    expect(res.status).toBe(201)
  })

  it('crea con sinónimos normalizados, sin repetidos, vacíos ni el propio nombre', async () => {
    const res = await app.request('/tipos', json('POST', {
      nombre: 'Martillo demoledor', alias: ['Martillo Demoledor', 'rompedor', 'ROMPEDOR ', '', 'demoledor eléctrico'],
    }))
    expect(res.status).toBe(201)
    const ins = estado.inserts[0]
    expect(ins.tabla).toBe('stock_materiales')
    expect(ins.valores).toMatchObject({
      nombre: 'Martillo demoledor', clase: 'herramienta', unidad: 'unid', precio_ref: 0, rubro_id: 26, created_by: 'user-uuid',
    })
    expect(ins.valores.alias).toEqual(['rompedor', 'demoledor electrico'])
    expect((await res.json()).id).toBe(900)
  })

  it('traduce el 23505 del índice único a TIPO_DUPLICADO', async () => {
    estado.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    const res = await app.request('/tipos', json('POST', { nombre: 'Algo nuevo' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('TIPO_DUPLICADO')
  })
})

describe('PATCH /tipos/:id', () => {
  it('404 si el id no es una herramienta', async () => {
    expect((await app.request('/tipos/4', json('PATCH', { nombre: 'Cemento' }))).status).toBe(404)
    expect((await app.request('/tipos/999', json('PATCH', { nombre: 'Nada' }))).status).toBe(404)
  })

  it('400 si no hay nada para cambiar', async () => {
    expect((await app.request('/tipos/1', json('PATCH', {}))).status).toBe(400)
  })

  it('409 si el nombre nuevo choca con otro tipo activo', async () => {
    const res = await app.request('/tipos/2', json('PATCH', { nombre: 'prolongador' }))
    expect(res.status).toBe(409)
    expect((await res.json()).candidatos).toEqual([{ id: 1, nombre: 'Prolongación 10m' }])
    expect(estado.updates).toHaveLength(0)
  })

  it('renombrar propaga a los renglones de pedido y al pañol que llevaban el nombre viejo', async () => {
    const res = await app.request('/tipos/1', json('PATCH', { nombre: 'Prolongación eléctrica 10m' }))
    expect(res.status).toBe(200)
    expect(estado.updates.map(u => u.tabla)).toEqual(['stock_materiales', 'solicitud_compra_item', 'herr_entregas'])

    const [, pedidos, panol] = estado.updates
    expect(pedidos.valores).toEqual({ descripcion: 'Prolongación eléctrica 10m' })
    expect(pedidos.filtros).toEqual([['material_id', 1], ['descripcion', 'Prolongación 10m']])
    expect(panol.valores).toMatchObject({ descripcion: 'Prolongación eléctrica 10m', descripcion_norm: 'prolongacion electrica 10m' })
    expect(panol.filtros).toEqual([['material_id', 1], ['descripcion', 'Prolongación 10m']])
    expect((await res.json()).nombre).toBe('Prolongación eléctrica 10m')
  })

  it('editar solo los sinónimos no toca pedidos ni pañol', async () => {
    const res = await app.request('/tipos/1', json('PATCH', { alias: ['Alargue', 'alargue', 'Prolongación 10m'] }))
    expect(res.status).toBe(200)
    expect(estado.updates.map(u => u.tabla)).toEqual(['stock_materiales'])
    expect(estado.updates[0].valores.alias).toEqual(['alargue'])
  })
})

describe('POST /tipos/:id/fusionar', () => {
  it('400 si origen y destino son el mismo', async () => {
    expect((await app.request('/tipos/1/fusionar', json('POST', { destino_id: 1 }))).status).toBe(400)
    expect(estado.rpc).toHaveLength(0)
  })

  it('llama a la RPC con origen, destino y usuario, y devuelve el resumen más el tipo destino', async () => {
    estado.rpcResultado = { data: { origen_id: 3, origen: 'Alargue viejo', destino_id: 1, destino: 'Prolongación 10m', renglones: 2, entregas: 5 }, error: null }
    const res = await app.request('/tipos/3/fusionar', json('POST', { destino_id: 1 }))
    expect(res.status).toBe(200)
    expect(estado.rpc).toEqual([{ fn: 'fusionar_tipo_herramienta', args: { p_origen: 3, p_destino: 1, p_user_id: 'user-uuid' } }])
    const b = await res.json()
    expect(b.renglones).toBe(2)
    expect(b.tipo.id).toBe(1)
  })

  it('traduce los errores de la RPC: 404 si alguno no es tipo, 409 si el destino está de baja', async () => {
    estado.rpcResultado = { data: null, error: { message: 'DESTINO_DE_BAJA' } }
    const r1 = await app.request('/tipos/1/fusionar', json('POST', { destino_id: 3 }))
    expect(r1.status).toBe(409)
    expect((await r1.json()).error).toBe('DESTINO_DE_BAJA')

    estado.rpcResultado = { data: null, error: { message: 'P0001: ORIGEN_NO_ES_TIPO' } }
    expect((await app.request('/tipos/4/fusionar', json('POST', { destino_id: 1 }))).status).toBe(404)
  })
})
