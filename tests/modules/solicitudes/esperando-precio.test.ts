import { describe, it, expect } from 'vitest'
import { ComprarItemSchema, EditarItemSchema } from '../../../src/modules/solicitudes/solicitudes.schema.js'

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
