import type { ItemEntregaDto } from './ropa.schema.js'

/**
 * Las filas a insertar para un trabajador. Una prenda repetida en el mismo
 * pedido se cuenta una vez (la primera): mandar dos veces «Botines» es un
 * doble click, no dos pares — para dos pares está la cantidad.
 */
export function filasDeEntrega(
  leg: string, items: ItemEntregaDto[], fecha: string, obs: string | null | undefined, userId: string,
) {
  const vistas = new Set<number>()
  const filas = []
  for (const it of items) {
    if (vistas.has(it.categoria_id)) continue
    vistas.add(it.categoria_id)
    filas.push({
      leg,
      categoria_id:  it.categoria_id,
      cantidad:      it.cantidad ?? 1,
      talle:         (it.talle ?? '').trim(),
      fecha_entrega: fecha,
      obs:           obs?.trim() || null,
      created_by:    userId,
    })
  }
  return filas
}
