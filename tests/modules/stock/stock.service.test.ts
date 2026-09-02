/**
 * Tests del catálogo de materiales:
 *  - `normMaterial` / `trigramas` / `similitud` son el espejo en TS de
 *    `public.norm_material()` + `similarity()` de pg_trgm. Los números de acá
 *    se verificaron contra la base viva (`show_trgm`, 733 nombres reales del
 *    catálogo, 0 diferencias). Si alguien toca esas funciones, esto avisa.
 *  - `createMaterial` corta con 409 antes de sumar un duplicado al catálogo.
 *  - `UpdateMaterialSchema` NO aplica defaults (si vuelve a aplicarlos, un
 *    PATCH sin `alias` borraría los sinónimos).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type FilaLite = { id: number; nombre: string; unidad: string | null; alias: string[] }

const { estado } = vi.hoisted(() => ({
  estado: {
    materiales: [] as FilaLite[],
    insert:  null as { data: unknown; error: unknown } | null,
    update:  null as { data: unknown; error: unknown } | null,
    ultimoInsert: null as any,
    ultimoUpdate: null as any,
  },
}))

vi.mock('../../../src/lib/supabase.js', () => {
  function tabla() {
    let modo: 'select' | 'insert' | 'update' = 'select'
    let rango: [number, number] = [0, 999]
    function resolver() {
      if (modo === 'insert') return estado.insert ?? { data: { id: 99 }, error: null }
      if (modo === 'update') return estado.update ?? { data: { id: 99 }, error: null }
      return { data: estado.materiales.slice(rango[0], rango[1] + 1), error: null }
    }
    const obj: any = {
      select: () => obj,
      eq:     () => obj,
      order:  () => obj,
      range:  (a: number, b: number) => { rango = [a, b]; return obj },
      insert: (v: any) => { modo = 'insert'; estado.ultimoInsert = v; return obj },
      update: (v: any) => { modo = 'update'; estado.ultimoUpdate = v; return obj },
      single:      () => Promise.resolve(resolver()),
      maybeSingle: () => Promise.resolve(resolver()),
      then: (f: any) => Promise.resolve(resolver()).then(f),
    }
    return obj
  }
  const cliente = { from: () => tabla() }
  return { createSupabaseClient: () => cliente, supabase: cliente }
})

import {
  stockService, StockHttpError,
  normMaterial, trigramas, similitud, normalizarAlias,
} from '../../../src/modules/stock/stock.service.js'
import { CreateMaterialSchema, UpdateMaterialSchema } from '../../../src/modules/stock/stock.schema.js'

const TOKEN = 'jwt-mock'
const USER  = 'user-uuid'

function material(id: number, nombre: string, alias: string[] = []): FilaLite {
  return { id, nombre, unidad: 'unid', alias }
}

beforeEach(() => {
  estado.materiales   = []
  estado.insert       = null
  estado.update       = null
  estado.ultimoInsert = null
  estado.ultimoUpdate = null
})

// ── Normalización ───────────────────────────────────────────────────────
describe('normMaterial', () => {
  it('baja a minúsculas, saca tildes y ñ, y colapsa espacios', () => {
    expect(normMaterial('  Caño   PVC 40MM  ')).toBe('cano pvc 40mm')
    expect(normMaterial('Prolongación 10m')).toBe('prolongacion 10m')
    expect(normMaterial('Lija al agua N°150')).toBe('lija al agua n°150')
  })

  it('devuelve string vacío para input en blanco', () => {
    expect(normMaterial('   ')).toBe('')
  })
})

// ── Trigramas (espejo de pg_trgm) ───────────────────────────────────────
describe('trigramas', () => {
  it('rellena cada palabra con 2 espacios adelante y 1 atrás', () => {
    expect([...trigramas('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'])
  })

  it('parte por caracteres no alfanuméricos', () => {
    // Verificado contra show_trgm('disco flap 4 1/2') en la base: 17 trigramas.
    expect(trigramas('disco flap 4 1/2').size).toBe(17)
  })

  it('no toma los superíndices como dígito (igual que pg_trgm)', () => {
    // "1.5mm²" corta la palabra antes del ²: hay "mm " y no "mm²".
    const t = trigramas('Cable unipolar 1.5mm²')
    expect(t.has('mm ')).toBe(true)
    expect(t.has('mm²')).toBe(false)
  })
})

describe('similitud', () => {
  it('reproduce los números de similarity() de Postgres', () => {
    expect(similitud('disco flap 4 1/2', 'Disco flap 115mm')).toBeCloseTo(0.545, 3)
    expect(similitud('lija 150', 'Lija al agua N°150')).toBeCloseTo(0.5, 3)
  })

  it('es 1 para el mismo nombre escrito distinto', () => {
    expect(similitud('CAÑO pvc  40mm', 'caño PVC 40mm')).toBe(1)
  })

  it('es 0 contra vacío', () => {
    expect(similitud('', 'lija')).toBe(0)
  })
})

describe('normalizarAlias', () => {
  it('normaliza, saca vacíos y deduplica', () => {
    expect(normalizarAlias(['T1', ' t1 ', 'Plástico Negro', '  ', 'Alargue']))
      .toEqual(['t1', 'plastico negro', 'alargue'])
  })

  it('tolera null/undefined', () => {
    expect(normalizarAlias(null)).toEqual([])
    expect(normalizarAlias(undefined)).toEqual([])
  })
})

// ── buscarParecidos ─────────────────────────────────────────────────────
describe('buscarParecidos', () => {
  it('encuentra por alias exacto aunque el nombre no se parezca', async () => {
    estado.materiales = [
      material(1, 'Tornillo T1 autoperforante', ['t1']),
      material(2, 'Cemento Portland x 50kg'),
    ]
    const cs = await stockService.buscarParecidos('T1', TOKEN)
    expect(cs.map(c => c.id)).toEqual([1])
    expect(cs[0].por_alias).toBe(true)
  })

  it('encuentra por similitud de nombre sobre el umbral', async () => {
    estado.materiales = [
      material(1, 'Lija al agua N°150'),
      material(2, 'Cemento Portland x 50kg'),
    ]
    const cs = await stockService.buscarParecidos('lija 150', TOKEN)
    expect(cs.map(c => c.id)).toEqual([1])
    expect(cs[0].sim).toBeGreaterThan(0.45)
    expect(cs[0].por_alias).toBe(false)
  })

  it('pone primero los de alias y corta en 5', async () => {
    estado.materiales = [
      material(1, 'Lija al agua N°60'),
      material(2, 'Lija al agua N°80'),
      material(3, 'Lija al agua N°100'),
      material(4, 'Lija al agua N°120'),
      material(5, 'Lija al agua N°220'),
      material(6, 'Papel de vidrio grano 180', ['Lija al agua N°180']),
    ]
    const cs = await stockService.buscarParecidos('Lija al agua N°180', TOKEN)
    expect(cs).toHaveLength(5)
    expect(cs[0].id).toBe(6)
    expect(cs[0].por_alias).toBe(true)
  })

  it('no devuelve nada si no hay nada parecido', async () => {
    estado.materiales = [material(1, 'Cemento Portland x 50kg')]
    expect(await stockService.buscarParecidos('Cinta de peligro', TOKEN)).toEqual([])
  })

  it('excluye el propio material cuando se pasa excluirId', async () => {
    estado.materiales = [material(1, 'Lija al agua N°150')]
    expect(await stockService.buscarParecidos('Lija al agua N°150', TOKEN, 1)).toEqual([])
  })
})

// ── createMaterial ──────────────────────────────────────────────────────
describe('createMaterial', () => {
  const dtoBase = CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Lija al agua N°180' })

  it('corta con 409 MATERIAL_PARECIDO antes de insertar', async () => {
    estado.materiales = [material(7, 'Lija al agua N°150')]
    const err = await stockService.createMaterial(dtoBase, TOKEN, USER).catch(e => e)
    expect(err).toBeInstanceOf(StockHttpError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('MATERIAL_PARECIDO')
    expect((err.extra.candidatos as Array<{ id: number }>)[0].id).toBe(7)
    expect(estado.ultimoInsert).toBeNull() // no llegó a insertar
  })

  it('con forzar:true saltea el chequeo e inserta', async () => {
    estado.materiales = [material(7, 'Lija al agua N°150')]
    const dto = CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Lija al agua N°180', forzar: true })
    await stockService.createMaterial(dto, TOKEN, USER)
    expect(estado.ultimoInsert.nombre).toBe('Lija al agua N°180')
  })

  it('guarda los alias normalizados', async () => {
    const dto = CreateMaterialSchema.parse({
      rubro_id: 1, nombre: 'Prolongación 10m', alias: ['Alargue', ' ALARGUE ', 'zapatilla'],
    })
    await stockService.createMaterial(dto, TOKEN, USER)
    expect(estado.ultimoInsert.alias).toEqual(['alargue', 'zapatilla'])
    expect(estado.ultimoInsert.forzar).toBeUndefined() // no es columna
  })

  it('mapea el 23505 del índice único a 409 MATERIAL_DUPLICADO', async () => {
    estado.insert = {
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "stock_materiales_nombre_norm_uidx"',
        details: null,
      },
    }
    const dto = CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Cemento Portland x 50kg', forzar: true })
    const err = await stockService.createMaterial(dto, TOKEN, USER).catch(e => e)
    expect(err).toBeInstanceOf(StockHttpError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('MATERIAL_DUPLICADO')
    expect(err.message).toContain('Cemento Portland x 50kg')
  })
})

// ── updateMaterial ──────────────────────────────────────────────────────
describe('updateMaterial', () => {
  it('normaliza los alias que vienen en el body', async () => {
    await stockService.updateMaterial(5, UpdateMaterialSchema.parse({ alias: ['Taco 8', 'TARUGO'] }), TOKEN, USER)
    expect(estado.ultimoUpdate.alias).toEqual(['taco 8', 'tarugo'])
  })

  it('no toca alias si no vino en el body', async () => {
    await stockService.updateMaterial(5, UpdateMaterialSchema.parse({ precio_ref: 1200 }), TOKEN, USER)
    expect(estado.ultimoUpdate).not.toHaveProperty('alias')
  })

  it('mapea el 23505 a 409 MATERIAL_DUPLICADO', async () => {
    estado.update = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "stock_materiales_nombre_norm_uidx"', details: null },
    }
    const err = await stockService.updateMaterial(5, { nombre: 'Fratacho' }, TOKEN, USER).catch(e => e)
    expect(err).toBeInstanceOf(StockHttpError)
    expect(err.code).toBe('MATERIAL_DUPLICADO')
  })
})

// ── Schemas ─────────────────────────────────────────────────────────────
describe('schemas de material', () => {
  it('UpdateMaterialSchema no aplica defaults (un PATCH parcial no pisa nada)', () => {
    expect(UpdateMaterialSchema.parse({ nombre: 'Fratacho' })).toEqual({ nombre: 'Fratacho' })
  })

  it('CreateMaterialSchema sí aplica los defaults', () => {
    expect(CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Fratacho' })).toEqual({
      rubro_id: 1, nombre: 'Fratacho', unidad: 'unid', stock_minimo: 0,
      precio_ref: 0, proveedor_id: null, obs: '', alias: [], forzar: false,
      // Default false: un material nace sin color y hay que tildarlo en el ABM.
      usa_color: false,
      clase: 'material',
    })
  })

  it('usa_color es seteable en alta y en PATCH', () => {
    // Regresion: `usa_color` no estaba en `materialFields`, asi que zod lo
    // descartaba en silencio y TODO material nuevo nacia en false para siempre,
    // sin forma de marcarlo desde el ABM.
    expect(CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Latex', usa_color: true }).usa_color).toBe(true)
    expect(UpdateMaterialSchema.parse({ usa_color: true })).toEqual({ usa_color: true })
  })

  it('clase es seteable en alta y en PATCH, y default material', () => {
    // Misma regresion que usa_color: si no esta en materialFields, zod lo descarta
    // en silencio y el espejo del catalogo queda inerte.
    expect(CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Tenaza', clase: 'herramienta' }).clase).toBe('herramienta')
    expect(CreateMaterialSchema.parse({ rubro_id: 1, nombre: 'Cemento' }).clase).toBe('material')
    expect(UpdateMaterialSchema.parse({ clase: 'herramienta' })).toEqual({ clase: 'herramienta' })
    expect(CreateMaterialSchema.safeParse({ rubro_id: 1, nombre: 'X', clase: 'otra' }).success).toBe(false)
  })

  it('rechaza alias vacíos', () => {
    expect(CreateMaterialSchema.safeParse({ rubro_id: 1, nombre: 'X', alias: ['  '] }).success).toBe(false)
  })
})
