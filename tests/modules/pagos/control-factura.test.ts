/**
 * El control automático del comprobante contra lo tipeado (20260921j).
 *
 * Lo que estos tests cuidan es el VEREDICTO, que es donde está el criterio:
 * la llamada al modelo no se testea acá. Y sobre todo cuidan que «no pude
 * leerlo» nunca se confunda con «está bien».
 */
import { describe, it, expect, vi } from 'vitest'

// `control.service` arrastra el cliente de Supabase, que explota al importarse
// sin env. Acá sólo se testean funciones puras: alcanza con que el módulo cargue.
vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: { from: () => ({}), storage: { from: () => ({}) } },
  createSupabaseClient: () => ({}),
}))

import { aNumero, compararLectura } from '../../../src/modules/pagos/control.service.js'

describe('aNumero: el total puede venir de varias formas', () => {
  it('número, y string con punto o con coma', () => {
    expect(aNumero(24994.52)).toBe(24994.52)
    expect(aNumero('24994.52')).toBe(24994.52)
    expect(aNumero('24.994,52')).toBe(24994.52)
  })
  it('con símbolo y espacios', () => {
    expect(aNumero('$ 24.994,52')).toBe(24994.52)
  })
  it('lo que no es número es null', () => {
    expect(aNumero(null)).toBeNull()
    expect(aNumero('no se lee')).toBeNull()
    expect(aNumero('')).toBeNull()
  })
})

describe('compararLectura', () => {
  it('coincide cuando el papel dice lo mismo', () => {
    const r = compararLectura({ legible: true, numero: '0012-00402141', total: 138382.40 }, '0012-00402141', 138382.40)
    expect(r.estado).toBe('coincide')
    expect(r.numero_ok).toBe(true)
    expect(r.total_ok).toBe(true)
  })

  it('el número se compara NORMALIZADO: con espacio o con guion es lo mismo', () => {
    const r = compararLectura({ legible: true, numero: '0012 00402141', total: 138382.40 }, '0012-00402141', 138382.40)
    expect(r.estado).toBe('coincide')
  })

  it('el caso real de ABC: punto de venta cambiado', () => {
    const r = compararLectura({ legible: true, numero: '0012-00402141', total: 138382.40 }, '0013-00402141', 138382.40)
    expect(r.estado).toBe('difiere')
    expect(r.numero_ok).toBe(false)
    expect(r.total_ok).toBe(true)
    expect(r.nota).toContain('0012-00402141')
  })

  it('el caso real de Norte: 48 centavos de más en el total', () => {
    const r = compararLectura({ legible: true, numero: '00011-00000194', total: 24994.52 }, '00011-00000194', 24995)
    expect(r.estado).toBe('difiere')
    expect(r.total_ok).toBe(false)
    expect(r.numero_ok).toBe(true)
  })

  it('una factura cargada sin número difiere contra un papel que sí lo tiene', () => {
    const r = compararLectura({ legible: true, numero: '08839-00001908', total: 92410.21 }, null, 92410.21)
    expect(r.estado).toBe('difiere')
    expect(r.nota).toContain('sin número')
  })

  it('ILEGIBLE no es «está bien»', () => {
    const r = compararLectura({ legible: false, numero: null, total: null }, '0012-00402141', 138382.40)
    expect(r.estado).toBe('ilegible')
    expect(r.numero_ok).toBeNull()
    expect(r.total_ok).toBeNull()
  })

  it('sin ningún dato leído tampoco pasa por coincide', () => {
    const r = compararLectura({ legible: true, numero: null, total: null }, '0012-00402141', 138382.40)
    expect(r.estado).toBe('ilegible')
  })

  it('si leyó sólo uno de los dos, coincide pero lo dice', () => {
    const r = compararLectura({ legible: true, numero: '0012-00402141', total: null }, '0012-00402141', 138382.40)
    expect(r.estado).toBe('coincide')
    expect(r.total_ok).toBeNull()
    expect(r.nota).toContain('no se pudo leer el total')
  })

  it('los centavos se comparan en centavos, sin arrastrar el float', () => {
    const r = compararLectura({ legible: true, numero: '0012-1', total: 138382.400000001 }, '0012-00000001', 138382.40)
    expect(r.total_ok).toBe(true)
  })

  it('el total leído como texto con formato argentino también compara', () => {
    const r = compararLectura({ legible: true, numero: '0012-00402141', total: '138.382,40' }, '0012-00402141', 138382.40)
    expect(r.estado).toBe('coincide')
  })
})
