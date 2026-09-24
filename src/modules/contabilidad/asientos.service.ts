/**
 * Asientos contables (`cont_asientos` + `cont_asiento_lineas`, 20260926a/d).
 *
 * Nada se escribe por tabla: las guardas `fn_cont_asiento_guard` y
 * `fn_cont_linea_guard` rechazan cualquier escritura que no venga de una RPC
 * (`ASIENTO_SOLO_RPC`). Las RPC chequean el flag `asientos_manuales`, el
 * período abierto y la partida doble; el trigger diferido la vuelve a mirar
 * al commit.
 *
 * Anular según el estado (decisión 2 de la spec): borrador → DELETE;
 * confirmado en período abierto → `anulado`; en período cerrado → contraasiento.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ContabilidadHttpError } from './contabilidad.errors.js'
import { aCentavos, pagina, rpc } from './comun.js'
import { chequearPartidaDoble, type GuardarAsientoDto, type ListAsientosQuery } from './contabilidad.schema.js'

export type CtbAsiento = Record<string, unknown> & { id: number; estado: string; periodo_estado: string }

/** Líneas como las espera la RPC: montos a centavos, `orden` implícito por posición. */
export function lineasParaRpc(lineas: GuardarAsientoDto['lineas']) {
  return lineas.map((l) => ({
    cuenta_id: l.cuenta_id,
    debe: aCentavos(l.debe ?? 0),
    haber: aCentavos(l.haber ?? 0),
    aux_id: l.aux_id ?? null,
    obra_cod: l.obra_cod ? l.obra_cod : null,
    glosa: (l.glosa ?? '').trim(),
  }))
}

export const asientosService = {
  async listar(f: ListAsientosQuery, db: SupabaseClient = supabase) {
    const r = await rpc<{ total: number; items: unknown[] } | null>(db, 'cont_listar_asientos', {
      p_desde: f.desde ?? null,
      p_hasta: f.hasta ?? null,
      p_estado: f.estado ?? 'todos',
      p_tipo: f.tipo ?? null,
      p_q: f.q?.trim() ? f.q.trim() : null,
      p_cuenta_id: f.cuenta_id ?? null,
      p_limit: f.limit,
      p_offset: f.offset,
    })
    return pagina(r?.items ?? [], Number(r?.total ?? 0), f.limit, f.offset)
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<CtbAsiento> {
    const a = await rpc<CtbAsiento | null>(db, '_cont_asiento_json', { p_id: id })
    if (!a || !a.id) throw new ContabilidadHttpError(404, 'ASIENTO_NO_EXISTE', { asiento_id: id })
    return a
  },

  /**
   * Alta (id null) o edición completa: las líneas se reemplazan todas. La
   * partida doble del confirmado se vuelve a chequear acá (el schema ya lo
   * hizo) para no depender de por dónde entró el dto.
   */
  async guardar(dto: GuardarAsientoDto, id: number | null, userId: string, db: SupabaseClient = supabase): Promise<CtbAsiento> {
    const lineas = lineasParaRpc(dto.lineas)
    if (dto.estado === 'confirmado') {
      const r = chequearPartidaDoble(lineas)
      if (r) throw new ContabilidadHttpError(r.code === 'MENOS_DE_DOS_LINEAS' ? 400 : 422, r.code, { campo: 'lineas', ...r.detail })
    }
    const pAsiento: Record<string, unknown> = {
      fecha: dto.fecha, tipo: dto.tipo, glosa: dto.glosa.trim(), estado: dto.estado,
    }
    if (id != null) pAsiento.id = id
    return rpc<CtbAsiento>(db, 'cont_guardar_asiento', { p_asiento: pAsiento, p_lineas: lineas, p_user_id: userId })
  },

  async borrar(id: number, userId: string, db: SupabaseClient = supabase): Promise<{ ok: true; id: number }> {
    await rpc(db, 'cont_borrar_asiento', { p_id: id, p_user_id: userId })
    return { ok: true, id }
  },

  async anular(id: number, motivo: string, fecha: string | undefined, userId: string, db: SupabaseClient = supabase) {
    return rpc<{ accion: 'anulado' | 'contraasiento'; asiento: CtbAsiento; contraasiento: CtbAsiento | null }>(
      db, 'cont_anular_asiento', { p_id: id, p_motivo: motivo.trim(), p_user_id: userId, p_fecha: fecha ?? null })
  },
}
