import { describe, it, expect } from 'vitest'
import { DevolverItemSchema } from '../../../src/modules/solicitudes/solicitudes.schema.js'

// Devolver material de la obra al deposito (20260913k). La cantidad es lo que
// VUELVE, no lo que queda: asi lo dice quien recibe en el galpon.
describe('DevolverItemSchema', () => {
  it('acepta una devolucion parcial con motivo', () => {
    const r = DevolverItemSchema.safeParse({ cantidad: 15, motivo: 'Sobro en obra' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.cantidad).toBe(15)
      expect(r.data.motivo).toBe('Sobro en obra')
    }
  })

  it('el motivo es opcional', () => {
    expect(DevolverItemSchema.safeParse({ cantidad: 1 }).success).toBe(true)
  })

  it('rechaza cantidades que no son una devolucion', () => {
    expect(DevolverItemSchema.safeParse({ cantidad: 0 }).success).toBe(false)
    expect(DevolverItemSchema.safeParse({ cantidad: -5 }).success).toBe(false)
    expect(DevolverItemSchema.safeParse({}).success).toBe(false)
    expect(DevolverItemSchema.safeParse({ cantidad: '15' }).success).toBe(false)
  })

  it('admite fracciones: vuelven 2,5 lts de una lata', () => {
    const r = DevolverItemSchema.safeParse({ cantidad: 2.5 })
    expect(r.success && r.data.cantidad).toBe(2.5)
  })

  it('recorta el motivo y corta los que no entran', () => {
    const r = DevolverItemSchema.safeParse({ cantidad: 1, motivo: '  volvio entero  ' })
    expect(r.success && r.data.motivo).toBe('volvio entero')
    expect(DevolverItemSchema.safeParse({ cantidad: 1, motivo: 'x'.repeat(301) }).success).toBe(false)
  })
})
