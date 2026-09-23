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

import { aNumero, aFecha, compararLectura } from '../../../src/modules/pagos/control.service.js'

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

describe('aFecha: el papel argentino es día/mes/año', () => {
  it('ISO y dd/mm/aaaa dan lo mismo', () => {
    expect(aFecha('2026-09-18')).toBe('2026-09-18')
    expect(aFecha('18/09/2026')).toBe('2026-09-18')
    expect(aFecha('18-09-2026')).toBe('2026-09-18')
    expect(aFecha('18.09.26')).toBe('2026-09-18')
  })
  it('el día va primero: 03/10 es 3 de octubre, no 10 de marzo', () => {
    expect(aFecha('03/10/2026')).toBe('2026-10-03')
  })
  it('una fecha que no existe no pasa', () => {
    expect(aFecha('31/02/2026')).toBeNull()
    expect(aFecha('2026-13-01')).toBeNull()
    expect(aFecha('no se lee')).toBeNull()
    expect(aFecha(null)).toBeNull()
  })
})

describe('compararLectura: la fecha de emisión (20260923a)', () => {
  const papel = { legible: true, numero: '08837-00004557', total: 152609.59 }

  it('el caso real de Cencosud: el papel dice 18/09 y se cargó el día de carga', () => {
    const r = compararLectura({ ...papel, fecha: '18/09/2026' }, '08837-00004557', 152609.59, '2026-09-21')
    expect(r.estado).toBe('difiere')
    expect(r.fecha_ok).toBe(false)
    expect(r.fecha_leida).toBe('2026-09-18')
    expect(r.numero_ok).toBe(true)
    expect(r.total_ok).toBe(true)
    expect(r.nota).toContain('emitida el 18/09/2026 y está cargada el 21/09/2026')
  })

  it('misma fecha: coincide', () => {
    const r = compararLectura({ ...papel, fecha: '2026-09-18' }, '08837-00004557', 152609.59, '2026-09-18')
    expect(r.estado).toBe('coincide')
    expect(r.fecha_ok).toBe(true)
    expect(r.nota).toBe('')
  })

  it('la fecha que no se leyó se dice, pero no convierte en difiere', () => {
    const r = compararLectura({ ...papel, fecha: null }, '08837-00004557', 152609.59, '2026-09-18')
    expect(r.estado).toBe('coincide')
    expect(r.fecha_ok).toBeNull()
    expect(r.nota).toContain('no se pudo leer la fecha')
  })

  it('sin facturaFecha no se compara la fecha (los controles viejos)', () => {
    const r = compararLectura({ ...papel, fecha: '2026-01-01' }, '08837-00004557', 152609.59)
    expect(r.estado).toBe('coincide')
    expect(r.fecha_ok).toBeNull()
    expect(r.nota).toBe('')
  })

  it('número y fecha mal a la vez: los dos en la nota', () => {
    const r = compararLectura({ ...papel, fecha: '18/09/2026' }, '08837-00004558', 152609.59, '2026-09-21')
    expect(r.estado).toBe('difiere')
    expect(r.nota).toContain('N° 08837-00004557')
    expect(r.nota).toContain('emitida el 18/09/2026')
  })

  it('si sólo se leyó la fecha, no es ilegible', () => {
    const r = compararLectura({ legible: true, numero: null, total: null, fecha: '18/09/2026' }, null, 1, '2026-09-18')
    expect(r.estado).toBe('coincide')
    expect(r.nota).toContain('no se pudo leer el número ni el total')
  })
})
