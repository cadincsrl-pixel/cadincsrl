/**
 * Ropa: talle y cantidad por prenda, y la entrega por obra (2026-09-23).
 */
import { describe, it, expect } from 'vitest'
import { filasDeEntrega } from '../../../src/modules/ropa/ropa.filas.js'
import {
  CreateEntregasLoteSchema, CreateEntregasTandaSchema,
} from '../../../src/modules/ropa/ropa.schema.js'

describe('filasDeEntrega', () => {
  it('lleva talle y cantidad; sin ellos, 1 unidad y sin talle', () => {
    const f = filasDeEntrega('101', [
      { categoria_id: 2, cantidad: 2, talle: ' 42 ' },
      { categoria_id: 1 },
    ], '2026-09-23', '  ', 'u1')
    expect(f).toEqual([
      { leg: '101', categoria_id: 2, cantidad: 2, talle: '42', fecha_entrega: '2026-09-23', obs: null, created_by: 'u1' },
      { leg: '101', categoria_id: 1, cantidad: 1, talle: '',   fecha_entrega: '2026-09-23', obs: null, created_by: 'u1' },
    ])
  })

  it('una prenda repetida es un doble click: queda la primera', () => {
    const f = filasDeEntrega('101', [
      { categoria_id: 2, talle: '42' }, { categoria_id: 2, talle: '43' },
    ], '2026-09-23', null, 'u1')
    expect(f).toHaveLength(1)
    expect(f[0]!.talle).toBe('42')
  })
})

describe('schemas', () => {
  const base = { leg: '101', fecha_entrega: '2026-09-23' }

  it('el lote acepta el formato viejo (categoria_ids) y el nuevo (items)', () => {
    expect(CreateEntregasLoteSchema.safeParse({ ...base, categoria_ids: [1, 2] }).success).toBe(true)
    expect(CreateEntregasLoteSchema.safeParse({ ...base, items: [{ categoria_id: 1, cantidad: 2, talle: 'XL' }] }).success).toBe(true)
    expect(CreateEntregasLoteSchema.safeParse(base).success).toBe(false)
  })

  it('cantidad entre 1 y 20, talle de hasta 12', () => {
    const it1 = (x: object) => CreateEntregasLoteSchema.safeParse({ ...base, items: [{ categoria_id: 1, ...x }] }).success
    expect(it1({ cantidad: 0 })).toBe(false)
    expect(it1({ cantidad: 21 })).toBe(false)
    expect(it1({ talle: 'x'.repeat(13) })).toBe(false)
  })

  it('la tanda exige al menos un trabajador con al menos una prenda', () => {
    expect(CreateEntregasTandaSchema.safeParse({ fecha_entrega: '2026-09-23', entregas: [] }).success).toBe(false)
    expect(CreateEntregasTandaSchema.safeParse({ fecha_entrega: '2026-09-23', entregas: [{ leg: '1', items: [] }] }).success).toBe(false)
    expect(CreateEntregasTandaSchema.safeParse({
      fecha_entrega: '2026-09-23', entregas: [{ leg: '1', items: [{ categoria_id: 1 }] }],
    }).success).toBe(true)
  })
})
