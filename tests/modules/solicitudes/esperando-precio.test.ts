import { describe, it, expect } from 'vitest'
import { ComprarItemSchema, DespacharItemSchema, EditarItemSchema } from '../../../src/modules/solicitudes/solicitudes.schema.js'

// "Esperando precio" (20260912c): la compra puede entrar en $0 solo con la marca.
describe('ComprarItemSchema · esperando_precio', () => {
  const base = { proveedor_id: 7 }

  it('sin marca, el precio sigue siendo obligatorio > 0', () => {
    expect(ComprarItemSchema.safeParse({ ...base, precio_unit: 0 }).success).toBe(false)
    expect(ComprarItemSchema.safeParse({ ...base, precio_unit: -1 }).success).toBe(false)
    expect(ComprarItemSchema.safeParse({ ...base, precio_unit: 1500 }).success).toBe(true)
  })

  it('con la marca, entra en 0 y la marca queda en el dto', () => {
    const r = ComprarItemSchema.safeParse({ ...base, precio_unit: 0, esperando_precio: true })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.esperando_precio).toBe(true)
      expect(r.data.precio_unit).toBe(0)
      expect(r.data.actualizar_catalogo).toBe(false)
    }
  })

  it('la marca por defecto es false', () => {
    const r = ComprarItemSchema.safeParse({ ...base, precio_unit: 100 })
    expect(r.success && r.data.esperando_precio).toBe(false)
  })
})

describe('EditarItemSchema · esperando_precio', () => {
  it('se puede prender o apagar a mano', () => {
    expect(EditarItemSchema.safeParse({ esperando_precio: false }).success).toBe(true)
    expect(EditarItemSchema.safeParse({ esperando_precio: 'si' }).success).toBe(false)
  })
})

// "Pasar el renglón a la unidad de la ficha" (fase 3): unidad y cantidad van juntas.
describe('EditarItemSchema · unidad + cantidad', () => {
  it('acepta las dos juntas', () => {
    expect(EditarItemSchema.safeParse({ unidad: 'rollo', cantidad: 0.3 }).success).toBe(true)
  })
  it('rechaza una sola, una cantidad en 0 o una unidad inventada', () => {
    expect(EditarItemSchema.safeParse({ unidad: 'rollo' }).success).toBe(false)
    expect(EditarItemSchema.safeParse({ cantidad: 2 }).success).toBe(false)
    expect(EditarItemSchema.safeParse({ unidad: 'rollo', cantidad: 0 }).success).toBe(false)
    expect(EditarItemSchema.safeParse({ unidad: 'caja', cantidad: 1 }).success).toBe(false)
  })
})

// El despacho tambien lleva la marca (20260913). Antes solo la llevaba la
// compra, y como el deposito casi siempre DESPACHA, para quien no tiene
// `precio_al_resolver` el flag no hacia nada: el renglon salia en $0 sin
// marcar y se mezclaba con los $0 viejos. Caso real: el pedido 726 de Sosa
// (10 de 10 renglones en $0, ninguno marcado).
describe('DespacharItemSchema · esperando_precio', () => {
  it('el despacho sigue admitiendo 0 sin la marca (lo tasan despues)', () => {
    const r = DespacharItemSchema.safeParse({ precio_unit: 0 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.esperando_precio).toBe(false)
  })

  it('acepta la marca y la deja en el dto', () => {
    const r = DespacharItemSchema.safeParse({ precio_unit: 0, esperando_precio: true })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.esperando_precio).toBe(true)
      expect(r.data.precio_unit).toBe(0)
    }
  })

  it('rechaza un precio negativo y una marca que no sea booleana', () => {
    expect(DespacharItemSchema.safeParse({ precio_unit: -1 }).success).toBe(false)
    expect(DespacharItemSchema.safeParse({ precio_unit: 0, esperando_precio: 'si' }).success).toBe(false)
  })

  it('con precio real la marca no se pide y queda apagada', () => {
    const r = DespacharItemSchema.safeParse({ precio_unit: 2500 })
    expect(r.success && r.data.esperando_precio).toBe(false)
  })
})
