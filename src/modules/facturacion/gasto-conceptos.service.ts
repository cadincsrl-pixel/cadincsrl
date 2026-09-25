/**
 * Conceptos de gastos que el cliente descuenta al pagar (20260930k): Recupero
 * Ley 25413, seguro de carga, pago de playa… Se editan en Ventas ›
 * Configuración (mismo molde que los tipos de retención) y los usan el cobro
 * (`gastos`) y la carga de la liquidación, que reconoce cada renglón por el
 * nombre o por los sinónimos (`alias`, guardados en norm_txt).
 *
 * Todo pasa por las RPC: `ventas_cobro_gasto_conceptos_json` (con `gastos` y
 * `mapeado` en Contabilidad › Mapeos, clave `cobros.gasto`) y
 * `ventas_guardar_cobro_gasto_concepto` (única puerta; vuelve a chequear
 * `facturacion.configurar`). Sin DELETE: se desactivan.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { rpc } from './comun.js'
import type { GastoConceptoCreateDto, GastoConceptoUpdateDto } from './facturacion.schema.js'

export interface GastoConcepto {
  id: number
  nombre: string
  /** En norm_txt (minúsculas, sin acentos ni signos). */
  alias: string[]
  activo: boolean
  orden: number
  /** Renglones de gasto cargados con este concepto. */
  gastos: number
  /** ¿Tiene cuenta en Contabilidad › Mapeos (cobros.gasto)? */
  mapeado: boolean
}

export const gastoConceptosService = {
  async listar(incluirInactivos: boolean, db: SupabaseClient = supabase): Promise<GastoConcepto[]> {
    return (await rpc<GastoConcepto[] | null>(db, 'ventas_cobro_gasto_conceptos_json', { p_incluir_inactivos: incluirInactivos })) ?? []
  },

  async crear(dto: GastoConceptoCreateDto, userId: string, db: SupabaseClient = supabase): Promise<GastoConcepto> {
    return rpc<GastoConcepto>(db, 'ventas_guardar_cobro_gasto_concepto', { p: dto, p_user_id: userId, p_id: null })
  },

  async editar(id: number, dto: GastoConceptoUpdateDto, userId: string, db: SupabaseClient = supabase): Promise<GastoConcepto> {
    return rpc<GastoConcepto>(db, 'ventas_guardar_cobro_gasto_concepto', { p: dto, p_user_id: userId, p_id: id })
  },
}
