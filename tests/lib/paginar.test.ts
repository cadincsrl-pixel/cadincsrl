import { describe, it, expect } from 'vitest'
import { todasLasFilas, PAGINA } from '../../src/lib/paginar.js'

function tabla(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
}

describe('todasLasFilas', () => {
  it('junta todas las páginas y corta en la que viene incompleta', async () => {
    const filas = tabla(2345)
    const rangos: Array<[number, number]> = []
    const r = await todasLasFilas(async (d, h) => { rangos.push([d, h]); return { data: filas.slice(d, h + 1), error: null } })
    expect(r).toHaveLength(2345)
    expect(r[0]).toEqual({ id: 1 })
    expect(r[2344]).toEqual({ id: 2345 })
    expect(rangos).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('una tabla de exactamente N páginas pide una página más, vacía, y termina', async () => {
    const filas = tabla(PAGINA * 2)
    let llamadas = 0
    const r = await todasLasFilas(async (d, h) => { llamadas++; return { data: filas.slice(d, h + 1), error: null } })
    expect(r).toHaveLength(2000)
    expect(llamadas).toBe(3)
  })

  it('tabla vacía → []', async () => {
    expect(await todasLasFilas(async () => ({ data: [], error: null }))).toEqual([])
    expect(await todasLasFilas(async () => ({ data: null, error: null }))).toEqual([])
  })

  it('un error de PostgREST se propaga', async () => {
    await expect(todasLasFilas(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow('boom')
  })
})
