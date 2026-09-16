/**
 * Una herramienta (y un servicio) no llevan stock de depósito — migración
 * 20260916c.
 *
 * El candado real está en la base: `trg_stock_solo_materiales` descarta la fila
 * de `stock_movimientos` en silencio y `trg_stock_congelado_sin_deposito` deja
 * `stock_actual` quieto, así que ningún camino (RPC, legacy, recibo de remito)
 * puede volver a mover el saldo de una herramienta.
 *
 * Lo que se prueba acá es la otra mitad: la carga MANUAL desde la pantalla de
 * Stock. El insert del service pide `.single()`, y una fila descartada por el
 * trigger devuelve 0 filas → el usuario vería "JSON object requested, 0 rows".
 * El chequeo previo convierte eso en una frase que dice dónde va lo que está
 * cargando.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { estado } = vi.hoisted(() => ({
  estado: {
    ficha: null as { clase: string; nombre: string } | null,
    inserts: [] as any[],
  },
}))

vi.mock('../../../src/middleware/permission.js', () => ({
  puedeActualizarCatalogo: async () => true,
}))

vi.mock('../../../src/lib/supabase.js', () => {
  function tabla(nombre: string) {
    let modo: 'select' | 'insert' | 'update' = 'select'
    function resolver() {
      if (modo === 'insert') return { data: { id: 1, ...estado.inserts.at(-1) }, error: null }
      if (modo === 'update') return { data: { id: 1 }, error: null }
      if (nombre === 'stock_materiales') return { data: estado.ficha, error: null }
      return { data: null, error: null }
    }
    const obj: any = {
      select: () => obj,
      eq:     () => obj,
      order:  () => obj,
      insert: (v: any) => { modo = 'insert'; estado.inserts.push(v); return obj },
      update: () => { modo = 'update'; return obj },
      single:      () => Promise.resolve(resolver()),
      maybeSingle: () => Promise.resolve(resolver()),
      then: (f: any) => Promise.resolve(resolver()).then(f),
    }
    return obj
  }
  const cliente: any = { from: (t: string) => tabla(t) }
  cliente.rpc = async () => ({ data: null, error: null })
  return { createSupabaseClient: () => cliente, supabase: cliente }
})

import { stockService } from '../../../src/modules/stock/stock.service.js'

const dto: any = { material_id: 1131, tipo: 'entrada', cantidad: 3, motivo: 'compra' }

describe('createMovimiento: quién puede tener saldo de depósito', () => {
  beforeEach(() => { estado.ficha = null; estado.inserts = [] })

  it('rechaza la herramienta y manda al pañol', async () => {
    estado.ficha = { clase: 'herramienta', nombre: 'Cuerpo de andamio tubular (marco armado)' }
    await expect(stockService.createMovimiento(dto, 'jwt', 'u1')).rejects.toThrow(/pañol/i)
    expect(estado.inserts).toHaveLength(0)
  })

  it('nombra la ficha en el mensaje, para que se entienda cuál es', async () => {
    estado.ficha = { clase: 'herramienta', nombre: 'Taladro percutor' }
    await expect(stockService.createMovimiento(dto, 'jwt', 'u1')).rejects.toThrow(/Taladro percutor/)
  })

  it('rechaza el servicio: se entrega cuando se compra', async () => {
    estado.ficha = { clase: 'servicio', nombre: 'Flete / envío' }
    await expect(stockService.createMovimiento(dto, 'jwt', 'u1')).rejects.toThrow(/se entrega cuando se compra/i)
    expect(estado.inserts).toHaveLength(0)
  })

  it('el material sigue entrando igual (control)', async () => {
    estado.ficha = { clase: 'material', nombre: 'Sikadur 31 (adhesivo epoxi)' }
    await stockService.createMovimiento(dto, 'jwt', 'u1')
    expect(estado.inserts).toHaveLength(1)
    expect(estado.inserts[0].material_id).toBe(1131)
  })

  it('el EPP también, que no es lo mismo que una herramienta', async () => {
    estado.ficha = { clase: 'epp', nombre: 'Guante de tela' }
    await stockService.createMovimiento(dto, 'jwt', 'u1')
    expect(estado.inserts).toHaveLength(1)
  })
})
