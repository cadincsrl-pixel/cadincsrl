/**
 * Mapeos contables y configuración del motor de asientos (fase 3, 20260927d).
 *
 * Un mapeo dice qué cuenta usa cada concepto de compra, alícuota, tributo,
 * producto de venta, medio de cobro… (`cont_mapeos`, clave + subclave). El
 * catálogo de claves con sus rubros y auxiliares permitidos, las subclaves
 * fijas y las que aparecen en los datos, y cuántos orígenes usan cada una lo
 * arma la base (`cont_mapeos_listar`). Guardar pasa por `cont_guardar_mapeos`
 * (null en `cuenta_id` = borrar), que valida cuenta activa, imputable y
 * compatible con la clave, y vuelve a chequear el flag `editar_mapeos`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ContabilidadHttpError } from './contabilidad.errors.js'
import { rpc } from './comun.js'
import { automaticosService, configDeFilas, type CtbConfig } from './automaticos.service.js'
import type { ConfigDto, GuardarMapeosDto } from './contabilidad.schema.js'

/**
 * El error de una fila del PUT apunta a su selector de cuenta:
 * `detail.indice` → `campo = 'mapeos.<i>.cuenta_id'` (contrato de la spec).
 */
export function conCampoDeMapeo(err: unknown): unknown {
  if (!(err instanceof ContabilidadHttpError)) return err
  const d = err.detail as { indice?: unknown } | undefined
  if (d && typeof d === 'object' && typeof d.indice === 'number' && Number.isInteger(d.indice)) {
    err.extra = { ...(err.extra ?? {}), campo: `mapeos.${d.indice}.cuenta_id` }
  }
  return err
}

export const mapeosService = {
  async listar(db: SupabaseClient = supabase): Promise<unknown> {
    const r = await rpc<unknown>(db, 'cont_mapeos_listar', {})
    return r ?? { claves: [] }
  },

  async guardar(dto: GuardarMapeosDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    try {
      const r = await rpc<unknown>(db, 'cont_guardar_mapeos', {
        p_mapeos: dto.mapeos.map((m) => ({ clave: m.clave, subclave: m.subclave, cuenta_id: m.cuenta_id })),
        p_user_id: userId,
      })
      const borrados = dto.mapeos.filter((m) => m.cuenta_id == null).length
      console.info(`[contabilidad] mapeos guardados por ${userId}: ${dto.mapeos.length - borrados} asignados, ${borrados} quitados`)
      return r ?? (await this.listar(db))
    } catch (e) {
      throw conCampoDeMapeo(e)
    }
  },

  async guardarConfig(dto: ConfigDto, userId: string, db: SupabaseClient = supabase): Promise<CtbConfig> {
    const cambios: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) cambios[k] = v
    const r = await rpc<unknown>(db, 'cont_guardar_config', { p_cambios: cambios, p_user_id: userId })
    console.info(`[contabilidad] config contable por ${userId}: ${JSON.stringify(cambios)}`)
    // La RPC devuelve la config; si viniera en filas o vacía, se relee.
    if (r && typeof r === 'object' && !Array.isArray(r) && 'automaticos_desde' in (r as object)) {
      return configDeFilas(Object.entries(r as Record<string, unknown>).map(([clave, valor]) => ({ clave, valor })))
    }
    return automaticosService.config(db)
  },
}
