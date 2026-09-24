/**
 * Datos del cliente desde el padrón de ARCA (fase 7, 2026-09-23).
 *
 * - `consultar(cuit)`: lo que dice ARCA, listo para precargar el alta del
 *   cliente. NO guarda nada.
 * - `actualizarCliente(id, { todo })`: pisa domicilio y provincia con los de
 *   ARCA; razón social y condición de IVA solo si están vacías o con `todo`.
 *   Guarda lo que vino en `padron_json` / `padron_consultado_at`.
 *
 * La condición de IVA de ARCA es una DEDUCCIÓN (ver `lib/arca/padron.ts`):
 * sin `todo` nunca pisa la cargada, solo la informa en `diferencias`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ArcaError, consultarPersona, type PersonaPadron } from '../../lib/arca/index.js'
import {
  domicilioDePadron, errorDePadron, padronJson, precargaPadron, provinciaDePadron, type PrecargaPadron,
} from '../../lib/arca/padron-datos.js'
import { cuitValido } from '../pagos/pagos.util.js'
import { FacturacionHttpError, errorArca, mapRpcError, type PgError } from './facturacion.errors.js'
import { CONDICIONES_IVA_IDS, letraDe } from './reglas.js'
import { clientesService, type VentasCliente } from './clientes.service.js'

export type { PrecargaPadron }
export { provinciaDePadron, domicilioDePadron, padronJson }

export interface ResultadoPadron {
  cuit: string
  precarga: PrecargaPadron
  padron: PersonaPadron
  consultado_at: string
}

export function errorPadron(e: unknown, cuit: string): FacturacionHttpError {
  const m = errorDePadron(e)
  if (m && e instanceof ArcaError) {
    const [status, code] = m
    return new FacturacionHttpError(status, code, {
      campo: 'doc_nro', cuit, mensaje: e.message, ...(e.errores.length ? { errores: e.errores.map((x) => x.msg) } : {}),
    })
  }
  return errorArca(e, { cuit })
}

export function precargaDe(p: PersonaPadron): PrecargaPadron {
  return precargaPadron(p, CONDICIONES_IVA_IDS)
}

/**
 * Qué campos del cliente cambian con el padrón. Domicilio y provincia
 * siempre (si ARCA los trae); razón social y condición de IVA solo si están
 * vacías o con `todo`. La condición no se toca si con ella el cliente se
 * quedaría sin letra (ej. monotributo sin CUIT no pasa, pero acá siempre hay
 * CUIT) — igual se valida.
 */
export function cambiosDesdePadron(
  actual: Record<string, unknown>,
  p: PersonaPadron,
  todo: boolean,
): { upd: Record<string, unknown>; diferencias: Array<{ campo: string; actual: unknown; arca: unknown; aplicado: boolean }> } {
  const pre = precargaDe(p)
  const upd: Record<string, unknown> = {}
  const diferencias: Array<{ campo: string; actual: unknown; arca: unknown; aplicado: boolean }> = []
  const str = (v: unknown) => (v == null ? '' : String(v).trim())

  for (const k of ['domicilio', 'provincia'] as const) {
    if (pre[k] && pre[k] !== str(actual[k])) {
      upd[k] = pre[k]
      diferencias.push({ campo: k, actual: str(actual[k]), arca: pre[k], aplicado: true })
    }
  }
  if (pre.razon_social && pre.razon_social !== str(actual.razon_social)) {
    const aplicar = todo || !str(actual.razon_social)
    if (aplicar) upd.razon_social = pre.razon_social
    diferencias.push({ campo: 'razon_social', actual: str(actual.razon_social), arca: pre.razon_social, aplicado: aplicar })
  }
  const condActual = actual.condicion_iva_id == null ? null : Number(actual.condicion_iva_id)
  if (pre.condicion_iva_id !== condActual) {
    const aplicar = (todo || condActual == null) && !!letraDe(Number(actual.doc_tipo ?? 80), pre.condicion_iva_id)
    if (aplicar) upd.condicion_iva_id = pre.condicion_iva_id
    diferencias.push({ campo: 'condicion_iva_id', actual: condActual, arca: pre.condicion_iva_id, aplicado: aplicar })
  }
  return { upd, diferencias }
}

export const padronService = {
  async consultar(cuitCrudo: string): Promise<ResultadoPadron> {
    const cuit = String(cuitCrudo ?? '').replace(/\D/g, '')
    if (!/^\d{11}$/.test(cuit) || !cuitValido(cuit)) {
      throw new FacturacionHttpError(400, 'CUIT_INVALIDO', { campo: 'doc_nro', cuit })
    }
    let p: PersonaPadron
    try {
      p = await consultarPersona(cuit)
    } catch (e) {
      throw errorPadron(e, cuit)
    }
    return { cuit, precarga: precargaDe(p), padron: p, consultado_at: new Date().toISOString() }
  },

  async actualizarCliente(
    id: number,
    opts: { todo?: boolean },
    userId: string,
    db: SupabaseClient = supabase,
  ): Promise<{ cliente: VentasCliente; diferencias: ReturnType<typeof cambiosDesdePadron>['diferencias']; padron: PersonaPadron }> {
    const actual = await clientesService.detalle(id, db)
    if (Number(actual.doc_tipo) !== 80 && Number(actual.doc_tipo) !== 86) {
      throw new FacturacionHttpError(400, 'PADRON_SOLO_CUIT', { campo: 'doc_tipo', cliente_id: id })
    }
    const r = await this.consultar(String(actual.doc_nro))
    const { upd, diferencias } = cambiosDesdePadron(actual, r.padron, !!opts.todo)
    const { error } = await db.from('ventas_clientes').update({
      ...upd,
      padron_json: padronJson(r.padron, r.consultado_at),
      padron_consultado_at: r.consultado_at,
      updated_by: userId,
    }).eq('id', id)
    if (error) {
      if ((error as PgError).code === '23514') throw new FacturacionHttpError(400, 'CLIENTE_INVALIDO', { dbMessage: error.message })
      throw mapRpcError(error as PgError)
    }
    return { cliente: await clientesService.detalle(id, db), diferencias, padron: r.padron }
  },
}
