import { supabase as supabaseAdmin } from './supabase.js'

/**
 * Suma `delta` al stock de una ficha en UNA sentencia (RPC `sumar_stock`,
 * migración 20260924t) y devuelve el stock nuevo.
 *
 * Antes cada escritor leía `stock_actual`, sumaba en JS y escribía el valor
 * absoluto: dos movimientos a la vez se pisaban, y el «revertir» de aprobar
 * un ajuste escribía el valor viejo encima de un despacho concurrente
 * (revisión 23/09). Tira si la base falla: un stock que no se movió no puede
 * pasar como que sí.
 */
export async function sumarStock(materialId: number, delta: number, userId?: string | null): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('sumar_stock', {
    p_material_id: materialId,
    p_delta:       delta,
    p_user_id:     userId ?? null,
  })
  if (error) throw new Error(`No se pudo mover el stock de la ficha ${materialId}: ${error.message}`)
  return Number(data)
}
