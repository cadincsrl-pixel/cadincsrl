// El reparto de lo pagado sobre lo facturable: primero lo viejo, ítems
// enteros, y lo que no entra se saltea sin frenar al resto.
import { describe, it, expect, vi } from 'vitest'

// El service importa el cliente de Supabase, que explota sin env: acá solo se
// testea la función pura de reparto, así que el cliente es de mentira.
vi.mock('../../../src/lib/supabase.js', () => ({ supabase: {}, createSupabaseClient: () => ({}) }))

import { asignarImputaciones, type ItemImputable } from '../../../src/modules/cuenta-cliente/cuenta-cliente.service.js'

const item = (tipo: ItemImputable['tipo'], clave: string, fecha: string, monto: number): ItemImputable =>
  ({ tipo, clave, fecha, monto })

describe('asignarImputaciones', () => {
  it('primero lo viejo: reparte en orden de fecha, no de llegada', () => {
    const { asignados } = asignarImputaciones(
      [item('material', 'B', '2026-08-01', 100), item('material', 'A', '2026-05-01', 100)],
      [{ id: 1, capacidad: 150 }],
    )
    expect(asignados.map(a => a.clave)).toEqual(['A'])
  })

  it('a igual fecha van primero los jornales, después contratistas, después materiales', () => {
    const { asignados } = asignarImputaciones(
      [item('material', 'm1', '2026-06-05', 10), item('operarios', '2026-06-05', '2026-06-05', 10),
       item('contratistas', '2026-06-05', '2026-06-05', 10)],
      [{ id: 1, capacidad: 25 }],
    )
    expect(asignados.map(a => a.tipo)).toEqual(['operarios', 'contratistas'])
  })

  it('nunca parte un ítem entre dos pagos: si no entra entero, se saltea', () => {
    const { asignados, sinCubrir } = asignarImputaciones(
      [item('operarios', 's1', '2026-05-15', 900), item('material', 'm1', '2026-06-01', 300)],
      [{ id: 1, capacidad: 500 }, { id: 2, capacidad: 500 }],
    )
    expect(sinCubrir.map(x => x.clave)).toEqual(['s1'])
    expect(asignados).toEqual([{ ...item('material', 'm1', '2026-06-01', 300), cobro_id: 1 }])
  })

  it('llena los pagos en orden y pasa al siguiente cuando no alcanza', () => {
    const { asignados } = asignarImputaciones(
      [item('material', 'a', '2026-05-01', 400), item('material', 'b', '2026-05-02', 400),
       item('material', 'c', '2026-05-03', 400)],
      [{ id: 1, capacidad: 500 }, { id: 2, capacidad: 900 }],
    )
    expect(asignados.map(a => [a.clave, a.cobro_id])).toEqual([['a', 1], ['b', 2], ['c', 2]])
  })

  it('con plata de sobra cubre todo y no queda nada sin cubrir', () => {
    const { asignados, sinCubrir } = asignarImputaciones(
      [item('operarios', 's1', '2026-05-15', 700), item('contratistas', 's1', '2026-05-15', 200),
       item('material', 'm', '2026-07-01', 50)],
      [{ id: 1, capacidad: 9000 }],
    )
    expect(asignados).toHaveLength(3)
    expect(sinCubrir).toHaveLength(0)
  })
})

describe('reubicación: el ítem grande que no entra por fragmentación', () => {
  it('mueve un ítem chico para hacerle lugar al grande (el caso Bercovich)', () => {
    // El viejo de 450 cae al pago grande y deja resto 550; el nuevo de 900 no
    // entra ni ahí (550) ni en el otro (500). Moviendo el de 450 al segundo
    // pago, el primero libera 1000 y el grande entra.
    const { asignados, sinCubrir } = asignarImputaciones(
      [item('material', 'viejo', '2026-05-01', 450), item('material', 'nuevo-grande', '2026-09-01', 900)],
      [{ id: 1, capacidad: 1000 }, { id: 2, capacidad: 500 }],
    )
    expect(sinCubrir).toHaveLength(0)
    const porClave = Object.fromEntries(asignados.map(a => [a.clave, a.cobro_id]))
    expect(porClave['nuevo-grande']).toBe(1)
    expect(porClave['viejo']).toBe(2)
  })

  it('si ni moviendo alcanza, lo deja sin cubrir y no rompe nada', () => {
    const { asignados, sinCubrir } = asignarImputaciones(
      [item('material', 'v1', '2026-05-01', 400), item('material', 'grande', '2026-09-01', 2000)],
      [{ id: 1, capacidad: 500 }, { id: 2, capacidad: 500 }],
    )
    expect(sinCubrir.map(x => x.clave)).toEqual(['grande'])
    expect(asignados.map(a => a.clave)).toEqual(['v1'])
  })
})

describe('cuando la plata alcanza para todo, se empaqueta todo', () => {
  it('resuelve el caso Belén real: sobra poco y el ítem más nuevo es el más grande', () => {
    // Réplica en miniatura: pagos fragmentados por lo viejo, y un ítem nuevo
    // grande que solo entra si el empaquetado es inteligente.
    const { asignados, sinCubrir } = asignarImputaciones(
      [item('operarios', 's1', '2026-05-15', 700), item('operarios', 's2', '2026-05-22', 400),
       item('material', 'm1', '2026-06-01', 180), item('material', 'bercovich', '2026-09-08', 1390)],
      [{ id: 1, capacidad: 300 }, { id: 2, capacidad: 1500 }, { id: 3, capacidad: 1100 }],
    )
    expect(sinCubrir).toHaveLength(0)
    expect(asignados).toHaveLength(4)
  })
})
