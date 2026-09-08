// El resolutor de catálogo para pedidos dictados al asistente.
//
// Lo que se fija acá es lo que separa un pedido bien cargado de uno que ensucia
// la cuenta de una obra durante semanas:
//   · cuando hay varias fichas posibles NUNCA elige una, devuelve la lista
//   · marca cuando la unidad que dijo la persona no es la de la ficha
//   · baja el catálogo UNA sola vez aunque le pidan seis materiales
//
// El catálogo de prueba son fichas REALES de la base (nombres, unidades y
// precios de 2026-09-08), porque los casos difíciles de este sistema son
// concretos: cinco cintas aisladoras que se diferencian por metros, un alambre
// que va por kilo y otro por rollo, una masa que es herramienta.
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Fila = Record<string, unknown>

const { estado } = vi.hoisted(() => ({
  estado: { filas: [] as Fila[], descargas: 0 },
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: {},
  createSupabaseClient: () => ({
    from: () => {
      let desde = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        eq:     () => b,
        order:  () => b,
        range:  (d: number) => { desde = d; return b },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if (desde === 0) estado.descargas++
          const pagina = desde === 0 ? estado.filas : []
          return Promise.resolve({ data: pagina, error: null }).then(res, rej)
        },
      }
      return b
    },
  }),
}))

const { stockService } = await import('../../../src/modules/stock/stock.service.js')

/** Ficha del catálogo con los defaults que no importan al caso. */
function ficha(f: Partial<Fila> & { id: number; nombre: string }): Fila {
  return {
    unidad: 'unid', alias: [], clase: 'material', rubro_id: 1, precio_ref: 0,
    usa_color: false, stock_actual: 0,
    stock_materiales_rubro_id_fkey: { nombre: 'Ferretería general' },
    ...f,
  }
}

const CATALOGO: Fila[] = [
  ficha({ id: 1, nombre: 'Cemento Portland x 25kg', unidad: 'bolsa', precio_ref: 6982, alias: ['portland'] }),
  ficha({ id: 2, nombre: 'Cemento de albañilería x 25kg', unidad: 'bolsa', precio_ref: 6628, alias: ['plasticor'] }),
  ficha({ id: 3, nombre: 'Alambre de atar N°18', unidad: 'kg', precio_ref: 4500 }),
  ficha({ id: 4, nombre: 'Alambre MIG 0.8mm x 5kg', unidad: 'rollo', precio_ref: 133000 }),
  ficha({ id: 5, nombre: 'Maza de acero 3kg', unidad: 'unid', clase: 'herramienta', alias: ['masa'] }),
  ficha({ id: 6, nombre: 'Cinta aisladora 3M 175 negra 20m', unidad: 'unid', precio_ref: 4996 }),
  ficha({ id: 7, nombre: 'Cinta aisladora 3M Super 33+', unidad: 'unid', precio_ref: 9320 }),
  ficha({ id: 8, nombre: 'Cinta aisladora sin especificar', unidad: 'unid', precio_ref: 1428 }),
]

beforeEach(() => { estado.filas = CATALOGO; estado.descargas = 0 })

const buscar = (consultas: { texto: string; unidad_dicha?: string | null; solo_herramientas?: boolean }[]) =>
  stockService.buscarParaPedido(consultas, 'token-de-mentira')

describe('buscarParaPedido', () => {
  it('baja el catálogo UNA sola vez aunque le pidan seis materiales', async () => {
    await buscar([
      { texto: 'cemento' }, { texto: 'alambre' }, { texto: 'masa' },
      { texto: 'cinta aisladora' }, { texto: 'portland' }, { texto: 'plasticor' },
    ])
    expect(estado.descargas).toBe(1)
  })

  it('con varias fichas posibles no elige: devuelve "varios" con la lista', async () => {
    const [r] = await buscar([{ texto: 'cemento' }])
    expect(r.resolucion).toBe('varios')
    expect(r.candidatos.map(c => c.material_id).sort()).toEqual([1, 2])
    // El precio y la unidad viajan, que es lo que permite preguntar
    // "¿Portland ($6.982) o plasticor ($6.628)?" con los datos a la vista.
    expect(r.candidatos.every(c => c.unidad === 'bolsa' && c.precio_ref > 0)).toBe(true)
  })

  it('un alias exacto resuelve solo, y gana por encima del parecido de nombre', async () => {
    const [r] = await buscar([{ texto: 'plasticor' }])
    expect(r.resolucion).toBe('unico')
    expect(r.candidatos[0].material_id).toBe(2)
    expect(r.candidatos[0].motivo).toBe('alias')
  })

  it('marca la unidad en disputa: "3 rollos de alambre" cuando el de atar va por kilo', async () => {
    const [r] = await buscar([{ texto: 'alambre', unidad_dicha: 'rollos' }])
    expect(r.resolucion).toBe('varios')
    const atar = r.candidatos.find(c => c.material_id === 3)!
    const mig  = r.candidatos.find(c => c.material_id === 4)!
    expect(atar.coincide_unidad).toBe(false)  // dijo rollos y va por kg
    expect(mig.coincide_unidad).toBe(true)
    // La diferencia de precio es de 30×: elegir mal acá es el error caro.
    expect(mig.precio_ref).toBeGreaterThan(atar.precio_ref * 10)
  })

  it('sin unidad dicha, coincide_unidad queda en null y no en false', async () => {
    const [r] = await buscar([{ texto: 'cemento' }])
    expect(r.candidatos.every(c => c.coincide_unidad === null)).toBe(true)
  })

  it('reconoce las presentaciones en plural y en singular', async () => {
    const [plural]   = await buscar([{ texto: 'portland', unidad_dicha: 'bolsas' }])
    const [singular] = await buscar([{ texto: 'portland', unidad_dicha: 'bolsa' }])
    expect(plural.candidatos[0].coincide_unidad).toBe(true)
    expect(singular.candidatos[0].coincide_unidad).toBe(true)
  })

  it('una palabra que no es unidad no se inventa como unidad', async () => {
    const [r] = await buscar([{ texto: 'portland', unidad_dicha: 'cositas' }])
    expect(r.candidatos[0].coincide_unidad).toBeNull()
  })

  it('avisa que la masa es herramienta, para que no vaya a la cuenta del cliente', async () => {
    const [r] = await buscar([{ texto: 'masa' }])
    expect(r.resolucion).toBe('unico')
    expect(r.candidatos[0].clase).toBe('herramienta')
  })

  it('las tres cintas aisladoras vuelven juntas, con lo que las diferencia', async () => {
    const [r] = await buscar([{ texto: 'cinta aisladora' }])
    expect(r.resolucion).toBe('varios')
    expect(r.candidatos).toHaveLength(3)
    const precios = r.candidatos.map(c => c.precio_ref).sort((a, b) => a - b)
    expect(precios).toEqual([1428, 4996, 9320])
  })

  it('lo que no está en el catálogo se declara sin resultados, no se aproxima', async () => {
    const [r] = await buscar([{ texto: 'puerta placa 80 a medida' }])
    expect(r.resolucion).toBe('sin_resultados')
    expect(r.candidatos).toEqual([])
  })

  it('devuelve un resultado por consulta y en el mismo orden', async () => {
    const rs = await buscar([{ texto: 'plasticor' }, { texto: 'nada de nada' }, { texto: 'masa' }])
    expect(rs.map(r => r.texto)).toEqual(['plasticor', 'nada de nada', 'masa'])
    expect(rs.map(r => r.resolucion)).toEqual(['unico', 'sin_resultados', 'unico'])
  })

  it('solo_herramientas descarta los materiales', async () => {
    const [r] = await buscar([{ texto: 'masa', solo_herramientas: true }])
    expect(r.candidatos.every(c => c.clase === 'herramienta')).toBe(true)
  })
})
