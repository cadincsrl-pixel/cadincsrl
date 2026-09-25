/**
 * Tipos de retención sufrida (tanda 6, ítem 5; base 20260929g) y la
 * configuración de Ventas (`ventas_config`: por ahora solo
 * `retencion_tipo_default`).
 *
 * Todo pasa por las RPC: `ventas_retencion_tipos_json` (lectura, con
 * `retenciones` y `mapeado`), `ventas_guardar_retencion_tipo` (única puerta;
 * vuelve a chequear `facturacion.configurar`), `ventas_config_json` y
 * `ventas_guardar_config`. Sin DELETE: los tipos se desactivan.
 *
 * El impuesto `iva` es reservado y único (IMPUESTO_IVA_RESERVADO): lo leen
 * lid-compras.service (.eq('tipo','iva')) y el asiento mensual de IVA.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { rpc } from './comun.js'
import type { RetencionTipoCreateDto, RetencionTipoUpdateDto, VentasConfigPatch } from './facturacion.schema.js'

export interface RetencionTipo {
  clave: string
  nombre: string
  corto: string
  impuesto: 'iva' | 'ganancias' | 'iibb' | 'suss' | 'municipal' | 'otro'
  pide_jurisdiccion: boolean
  jurisdiccion_default_id: number | null
  jurisdiccion_default_nombre: string | null
  sistema: boolean
  activo: boolean
  orden: number
  /** Retenciones cargadas con este tipo. */
  retenciones: number
  /** ¿Tiene cuenta en Contabilidad › Mapeos (cobros.retencion)? */
  mapeado: boolean
}

export interface VentasConfig {
  retencion_tipo_default: string
}

/** Pura: lo que devolvió `ventas_config_json` → la respuesta (default 'iibb'). */
export function ventasConfigDesdeJson(raw: unknown): VentasConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const t = typeof r.retencion_tipo_default === 'string' && r.retencion_tipo_default ? r.retencion_tipo_default : 'iibb'
  return { retencion_tipo_default: t }
}

export const retencionTiposService = {
  async listar(incluirInactivos: boolean, db: SupabaseClient = supabase): Promise<RetencionTipo[]> {
    return (await rpc<RetencionTipo[] | null>(db, 'ventas_retencion_tipos_json', { p_incluir_inactivos: incluirInactivos })) ?? []
  },

  async crear(dto: RetencionTipoCreateDto, userId: string, db: SupabaseClient = supabase): Promise<RetencionTipo> {
    return rpc<RetencionTipo>(db, 'ventas_guardar_retencion_tipo', { p: dto, p_user_id: userId, p_clave: null })
  },

  async editar(clave: string, dto: RetencionTipoUpdateDto, userId: string, db: SupabaseClient = supabase): Promise<RetencionTipo> {
    return rpc<RetencionTipo>(db, 'ventas_guardar_retencion_tipo', { p: dto, p_user_id: userId, p_clave: clave })
  },
}

export const ventasConfigService = {
  async obtener(db: SupabaseClient = supabase): Promise<VentasConfig> {
    return ventasConfigDesdeJson(await rpc<unknown>(db, 'ventas_config_json', {}))
  },

  async guardar(cambios: VentasConfigPatch, userId: string, db: SupabaseClient = supabase): Promise<VentasConfig> {
    return ventasConfigDesdeJson(await rpc<unknown>(db, 'ventas_guardar_config', { p_cambios: cambios, p_user_id: userId }))
  },
}
