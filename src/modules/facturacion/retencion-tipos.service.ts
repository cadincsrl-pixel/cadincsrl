/**
 * Tipos de retención sufrida (tanda 6, ítem 5; base 20260929g) y la
 * configuración de Ventas (`ventas_config`: `retencion_tipo_default` y, desde
 * 20260929j, los valores por defecto de la factura y la leyenda de la FCE).
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

/**
 * La leyenda de la FCE MiPyME, calcada del modelo de ARCA. Es la que imprime
 * el PDF cuando `ventas_config.leyenda_fce` es null; espejo de `LEYENDA_FCE`
 * en el `facturaPdf.ts` del frontend (20260929j).
 */
export const LEYENDA_FCE_ARCA =
  'Luego de su aceptación tácita o expresa, esta Factura de Crédito Electrónica MiPyMEs será transmitida a ' +
  'El Sistema de Circulación Abierta para Facturas de Crédito Electrónicas MiPyMEs, para su circulación y ' +
  'negociación, incluso en los Mercados de Valores, en este caso, a través de un Agente de Depósito Colectivo ' +
  'o agentes que cumplan similares funciones.'

/** Los valores de siempre (lo que estaba escrito en el formulario): semilla y respaldo. */
export const VENTAS_CONFIG_DEFAULTS = {
  retencion_tipo_default: 'iibb',
  condicion_pago_default: 'Cc Clientes',
  provincia_default: 'Tucuman',
  unidad_default: 'Unidades',
} as const

export interface VentasConfig {
  retencion_tipo_default: string
  condicion_pago_default: string
  provincia_default: string
  unidad_default: string
  /** null = la de ARCA (`leyenda_fce_default`). */
  leyenda_fce: string | null
  leyenda_fce_default: string
}

const txt = (v: unknown, def: string) => (typeof v === 'string' && v.trim() ? v : def)

/** Pura: lo que devolvió `ventas_config_json` → la respuesta, con los defaults de siempre. */
export function ventasConfigDesdeJson(raw: unknown): VentasConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const D = VENTAS_CONFIG_DEFAULTS
  return {
    retencion_tipo_default: txt(r.retencion_tipo_default, D.retencion_tipo_default),
    condicion_pago_default: txt(r.condicion_pago_default, D.condicion_pago_default),
    provincia_default: txt(r.provincia_default, D.provincia_default),
    unidad_default: txt(r.unidad_default, D.unidad_default),
    leyenda_fce: typeof r.leyenda_fce === 'string' && r.leyenda_fce.trim() ? r.leyenda_fce : null,
    leyenda_fce_default: LEYENDA_FCE_ARCA,
  }
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
