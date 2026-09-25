/**
 * Montos de ARCA con vigencia (tanda 6, ítem 4; base 20260929e).
 *
 * `ventas_parametros` guarda, con su fecha de vigencia, el monto mínimo de la
 * FCE MiPyME y el tope desde el que un consumidor final se identifica. La
 * base es la autoridad: `ventas_guardar_borrador` y el trigger
 * `fn_ventas_cf_identificado` usan el valor vigente a la FECHA DEL
 * COMPROBANTE. Este servicio lo espeja para los chequeos previos a la RPC
 * (`resolverTipo`, `exigirTipoFce`) y para la pantalla.
 *
 * La tabla no se edita en el lugar: un valor nuevo es una fila nueva con su
 * `vigente_desde`. Solo se borra una vigencia futura (PARAMETRO_YA_VIGENTE).
 *
 * Cache: 60 s por fecha, invalidado en cada escritura de este proceso (otra
 * instancia tarda ≤ 60 s). Si la base no contesta, `vigentes` cae a las
 * constantes de `reglas.ts` (los valores de antes) y no lanza: un chequeo
 * previo nunca puede tirar abajo la carga de una factura; la base vuelve a
 * validar igual.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { rpc } from './comun.js'
import { MONTO_MINIMO_FCE, TOPE_CF_IDENTIFICACION, hoyAr } from './reglas.js'
import type { ParametroCreateDto } from './facturacion.schema.js'

export const CLAVES_PARAMETRO = ['monto_minimo_fce', 'tope_cf_identificacion'] as const
export type ClaveParametro = (typeof CLAVES_PARAMETRO)[number]

export interface Parametro {
  id: number
  clave: ClaveParametro
  valor: number
  vigente_desde: string
  fuente: string
  obs: string
  created_at: string
  created_by: string | null
  /** Respecto de hoy: la que rige, una que ya no, o una que todavía no. */
  estado: 'vigente' | 'historico' | 'futuro'
}

export interface ParametrosVigentes {
  fecha: string
  monto_minimo_fce: number
  tope_cf_identificacion: number
}

/** Los valores de antes de 20260929e: fallback si la base no contesta. */
export function parametrosFallback(fecha: string): ParametrosVigentes {
  return { fecha, monto_minimo_fce: MONTO_MINIMO_FCE, tope_cf_identificacion: TOPE_CF_IDENTIFICACION }
}

/** Pura: ¿lo que devolvió la RPC sirve? (números > 0). */
export function normalizarVigentes(raw: unknown, fecha: string): ParametrosVigentes | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const m = Number(r.monto_minimo_fce)
  const t = Number(r.tope_cf_identificacion)
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(t) || t <= 0) return null
  return { fecha: typeof r.fecha === 'string' ? r.fecha : fecha, monto_minimo_fce: m, tope_cf_identificacion: t }
}

const TTL_MS = 60_000
const MAX_FECHAS = 200
const cache = new Map<string, { at: number; valor: ParametrosVigentes }>()

export const parametrosService = {
  async listar(clave: ClaveParametro | null | undefined, db: SupabaseClient = supabase): Promise<Parametro[]> {
    return (await rpc<Parametro[] | null>(db, 'ventas_parametros_json', { p_clave: clave ?? null })) ?? []
  },

  /**
   * Los valores vigentes a una fecha (YYYY-MM-DD; default hoy en AR). Nunca
   * lanza: ante un error de la base, las constantes (y no se cachea).
   */
  async vigentes(fecha?: string | null, db: SupabaseClient = supabase): Promise<ParametrosVigentes> {
    const f = fecha && /^\d{4}-\d{2}-\d{2}/.test(fecha) ? fecha.slice(0, 10) : hoyAr()
    const c = cache.get(f)
    if (c && Date.now() - c.at < TTL_MS) return c.valor
    try {
      const valor = normalizarVigentes(await rpc<unknown>(db, 'ventas_parametros_vigentes', { p_fecha: f }), f)
      if (!valor) return parametrosFallback(f)
      if (cache.size >= MAX_FECHAS) cache.clear()
      cache.set(f, { at: Date.now(), valor })
      return valor
    } catch (e) {
      console.error('[facturacion] no se pudieron leer los montos de ARCA; uso las constantes:', e instanceof Error ? e.message : e)
      return parametrosFallback(f)
    }
  },

  olvidarCache(): void {
    cache.clear()
  },

  async crear(dto: ParametroCreateDto, userId: string, db: SupabaseClient = supabase): Promise<Parametro> {
    const { forzar, ...p } = dto
    const r = await rpc<Parametro>(db, 'ventas_guardar_parametro', { p, p_user_id: userId, p_forzar: forzar ?? false })
    this.olvidarCache()
    return r
  },

  async borrar(id: number, userId: string, db: SupabaseClient = supabase): Promise<Omit<Parametro, 'estado'>> {
    const r = await rpc<Omit<Parametro, 'estado'>>(db, 'ventas_borrar_parametro', { p_id: id, p_user_id: userId })
    this.olvidarCache()
    return r
  },
}
