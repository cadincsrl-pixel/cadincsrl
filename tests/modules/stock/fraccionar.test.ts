import { describe, it, expect } from 'vitest'
import { FraccionarSchema } from '../../../src/modules/stock/stock.schema.js'

// Fraccionar un bulto (20260913n): la cantidad es EN UNIDADES DE ORIGEN
// —cuántos tambores se abren, no cuántos litros salen— porque quien lo hace
// esta parado frente al tambor, no frente a los litros.
describe('FraccionarSchema', () => {
  it('abre un bulto entero', () => {
    const r = FraccionarSchema.safeParse({ cantidad: 1 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.cantidad).toBe(1)
  })

  it('abre varios de una', () => {
    expect(FraccionarSchema.safeParse({ cantidad: 3 }).success).toBe(true)
  })

  it('admite medio bulto: media tonelada de arena son 20 bolsas', () => {
    const r = FraccionarSchema.safeParse({ cantidad: 0.5 })
    expect(r.success && r.data.cantidad).toBe(0.5)
  })

  it('rechaza lo que no es abrir nada', () => {
    expect(FraccionarSchema.safeParse({ cantidad: 0 }).success).toBe(false)
    expect(FraccionarSchema.safeParse({ cantidad: -1 }).success).toBe(false)
    expect(FraccionarSchema.safeParse({}).success).toBe(false)
    expect(FraccionarSchema.safeParse({ cantidad: '1' }).success).toBe(false)
  })

  it('la obs es opcional, se recorta y tiene tope', () => {
    expect(FraccionarSchema.safeParse({ cantidad: 1 }).success).toBe(true)
    const r = FraccionarSchema.safeParse({ cantidad: 1, obs: '  tambor nuevo  ' })
    expect(r.success && r.data.obs).toBe('tambor nuevo')
    expect(FraccionarSchema.safeParse({ cantidad: 1, obs: 'x'.repeat(301) }).success).toBe(false)
  })
})
