/**
 * Productos de venta (tanda 6, ítem 2; base 20260929b). Catálogo editable
 * desde Ventas › Configuración: cada producto define el concepto ARCA (1/2/3),
 * si la factura pide obra y si pide período de servicio.
 *
 * Todo pasa por las RPC: `ventas_productos_json` (lectura, con `facturas` y
 * `mapeado`) y `ventas_guardar_producto` (única puerta de escritura; vuelve a
 * chequear el flag `facturacion.configurar`). Sin DELETE: se desactivan.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { rpc } from './comun.js'
import type { ProductoCreateDto, ProductoUpdateDto } from './facturacion.schema.js'

export interface ProductoVenta {
  id: number
  nombre: string
  descripcion: string
  concepto_arca: 1 | 2 | 3
  pide_obra: boolean
  pide_periodo: boolean
  activo: boolean
  orden: number
  /** Facturas (no descartadas) que lo usan. */
  facturas: number
  /** ¿Tiene cuenta en Contabilidad › Mapeos (ventas.producto)? */
  mapeado: boolean
  created_at?: string
  updated_at?: string
  created_by?: string | null
  updated_by?: string | null
}

export const productosService = {
  async listar(incluirInactivos: boolean, db: SupabaseClient = supabase): Promise<ProductoVenta[]> {
    return (await rpc<ProductoVenta[] | null>(db, 'ventas_productos_json', { p_incluir_inactivos: incluirInactivos })) ?? []
  },

  async crear(dto: ProductoCreateDto, userId: string, db: SupabaseClient = supabase): Promise<ProductoVenta> {
    return rpc<ProductoVenta>(db, 'ventas_guardar_producto', { p: dto, p_user_id: userId })
  },

  async editar(id: number, dto: ProductoUpdateDto, userId: string, db: SupabaseClient = supabase): Promise<ProductoVenta> {
    return rpc<ProductoVenta>(db, 'ventas_guardar_producto', { p: { ...dto, id }, p_user_id: userId })
  },
}
