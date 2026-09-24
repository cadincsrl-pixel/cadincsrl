/**
 * Factura de Crédito Electrónica MiPyME (fase 6, 2026-09-23): ¿a este
 * cliente, por este total, le corresponde FCE?
 *
 * Lo dice WSFECRED (`consultarMontoObligadoRecepcion`): si el CUIT está
 * obligado a recibir FCE y desde qué monto. La respuesta se cachea 30 días
 * en el cliente (`fce_obligado`, `fce_monto_desde`, `fce_consultado_at`).
 *
 * Reglas (las aplica `exigirTipoFce`, al guardar y al emitir):
 *   - obligado y total ≥ su monto → FCE (201). Emitir una Factura A (1) →
 *     CORRESPONDE_FCE.
 *   - no obligado, o total < monto (o < MONTO_MINIMO_FCE) → Factura A. Una
 *     201 → NO_CORRESPONDE_FCE.
 *   - WSFECRED no responde y no hay cache → NO se bloquea: el usuario elige
 *     (la UI muestra el aviso). El piso general de la 201 lo sigue frenando
 *     la base.
 *   - el admin puede forzar las dos (`forzar`).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ArcaError, consultarMontoObligadoRecepcion } from '../../lib/arca/index.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { MONTO_MINIMO_FCE, cacheVigente, correspondeFce, hoyAr, letraDe } from './reglas.js'

export interface InfoFce {
  cliente_id: number
  cuit: string
  /** true/false según ARCA; null = no se sabe. */
  obligado: boolean | null
  monto_desde: number | null
  consultado_at: string | null
  /** De dónde salió el dato. `no_aplica` = el cliente no es de letra A. */
  fuente: 'arca' | 'cache' | 'sin_datos' | 'no_aplica'
  /** Mínimo general de la FCE (espejo de la base). */
  minimo: number
  /** Si WSFECRED falló, por qué (la UI lo muestra como aviso). */
  error: string | null
}

type ClienteFce = {
  id: number; doc_tipo: number; doc_nro: string; condicion_iva_id: number
  fce_obligado: boolean | null; fce_monto_desde: number | string | null; fce_consultado_at: string | null
}

export const fceService = {
  /**
   * El dato de FCE del cliente: el cache si tiene menos de 30 días (salvo
   * `refrescar`), si no WSFECRED (y actualiza el cache). Nunca lanza por una
   * falla de ARCA: vuelve con `error` y lo que hubiera en cache.
   */
  async info(clienteId: number, opts: { refrescar?: boolean; fecha?: string } = {}, db: SupabaseClient = supabase): Promise<InfoFce> {
    const { data, error } = await db.from('ventas_clientes')
      .select('id, doc_tipo, doc_nro, condicion_iva_id, fce_obligado, fce_monto_desde, fce_consultado_at')
      .eq('id', clienteId).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { cliente_id: clienteId })
    const c = data as ClienteFce
    const base = {
      cliente_id: c.id, cuit: String(c.doc_nro), minimo: MONTO_MINIMO_FCE,
      obligado: c.fce_obligado, monto_desde: c.fce_monto_desde == null ? null : Number(c.fce_monto_desde),
      consultado_at: c.fce_consultado_at,
    }
    if (letraDe(Number(c.doc_tipo), Number(c.condicion_iva_id)) !== 'A') {
      return { ...base, obligado: false, fuente: 'no_aplica', error: null }
    }
    if (!opts.refrescar && cacheVigente(c.fce_consultado_at)) return { ...base, fuente: 'cache', error: null }

    try {
      const r = await consultarMontoObligadoRecepcion(String(c.doc_nro), opts.fecha ?? hoyAr())
      const ahora = new Date().toISOString()
      const { error: e2 } = await db.from('ventas_clientes')
        .update({ fce_obligado: r.obligado, fce_monto_desde: r.montoDesde, fce_consultado_at: ahora })
        .eq('id', c.id)
      if (e2) console.error(`[facturacion] no se pudo guardar el dato de FCE del cliente ${c.id}:`, e2.message)
      return { ...base, obligado: r.obligado, monto_desde: r.montoDesde, consultado_at: ahora, fuente: 'arca', error: null }
    } catch (e) {
      const msg = e instanceof ArcaError ? `${e.codigo}: ${e.message}` : e instanceof Error ? e.message : String(e)
      console.error(`[facturacion] WSFECRED no respondió para el cliente ${c.id}:`, msg)
      return { ...base, fuente: c.fce_consultado_at ? 'cache' : 'sin_datos', error: msg }
    }
  },

  /**
   * Frena el tipo que no corresponde (ver encabezado). Solo mira facturas A
   * (1 y 201); las NC heredan el tipo de su factura. `forzar` lo saltea (el
   * que llama ya verificó que es admin).
   */
  async exigirTipoFce(p: { clienteId: number; tipo: number; total: number; fecha?: string | null; forzar?: boolean }, db: SupabaseClient = supabase): Promise<InfoFce | null> {
    if (p.tipo !== 1 && p.tipo !== 201) return null
    const info = await this.info(p.clienteId, { fecha: p.fecha ?? undefined }, db)
    if (p.forzar) return info
    const corresponde = correspondeFce({ obligado: info.obligado, montoDesde: info.monto_desde }, p.total)
    const detalle = {
      campo: 'cbte_tipo', cliente_id: p.clienteId, total: p.total, obligado: info.obligado,
      monto_desde: info.monto_desde, minimo: MONTO_MINIMO_FCE, fuente: info.fuente,
    }
    if (p.tipo === 1 && corresponde === true) {
      throw new FacturacionHttpError(400, 'CORRESPONDE_FCE', detalle)
    }
    if (p.tipo === 201) {
      if (Math.round(p.total * 100) < MONTO_MINIMO_FCE * 100) {
        throw new FacturacionHttpError(400, 'NO_CORRESPONDE_FCE', { ...detalle, motivo: 'monto_minimo' })
      }
      if (corresponde === false) {
        throw new FacturacionHttpError(400, 'NO_CORRESPONDE_FCE', { ...detalle, motivo: info.obligado === false ? 'no_obligado' : 'monto_receptor' })
      }
    }
    return info
  },
}
