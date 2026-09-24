/**
 * Conceptos de compra (`pagos_conceptos`, 20260925i): la lista con que se
 * clasifica cada factura (Combustible, Materiales de obra, …). UNO por
 * factura; la `descripcion` libre sigue siendo el detalle.
 *
 * La lista la ajusta el contador desde el sistema:
 *   - Sin DELETE: un concepto se da de baja con `activo=false` (las facturas
 *     viejas lo siguen mostrando; en el alta sólo se ofrecen los activos, y
 *     la RPC rebota uno inactivo con CONCEPTO_INVALIDO).
 *   - No se puede dar de baja el último activo: sin ninguno no se podría
 *     cargar una factura (el concepto es obligatorio).
 *   - `nombre_norm` lo arma un trigger. El nombre repetido (normalizado)
 *     choca con `pagos_conceptos_nombre_norm_key` → 409 CONCEPTO_DUPLICADO.
 */
import { createSupabaseClient } from '../../lib/supabase.js'
import { PagosHttpError } from './pagos.errors.js'
import { esBoolQ, type CreateConceptoDto, type ListConceptosQuery, type UpdateConceptoDto } from './pagos.schema.js'

const COLS = 'id, nombre, orden, activo'

export interface PagosConcepto { id: number; nombre: string; orden: number | null; activo: boolean }

/** unique_violation del nombre → 409; lo demás, 500. */
function errorDeEscritura(error: { code?: string; message?: string }, nombre?: string): PagosHttpError {
  if (error.code === '23505') return new PagosHttpError(409, 'CONCEPTO_DUPLICADO', { campo: 'nombre', nombre })
  if (error.code === '23514') return new PagosHttpError(400, 'CONCEPTO_INVALIDO', { campo: 'nombre', dbMessage: error.message })
  return new PagosHttpError(500, 'DB_ERROR', error.message)
}

export const conceptosService = {

  /** En el orden de la pantalla (`orden`, después id). Por defecto sólo los activos. */
  async listar(f: ListConceptosQuery, token: string): Promise<PagosConcepto[]> {
    const sb = createSupabaseClient(token)
    let q = sb.from('pagos_conceptos').select(COLS)
    if (!esBoolQ(f.incluir_inactivos)) q = q.eq('activo', true)
    const { data, error } = await q.order('orden', { ascending: true, nullsFirst: false }).order('id')
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    return (data ?? []) as PagosConcepto[]
  },

  /** Sin `orden`, va al final de la lista. */
  async crear(dto: CreateConceptoDto, userId: string, token: string): Promise<PagosConcepto> {
    const sb = createSupabaseClient(token)
    let orden = dto.orden ?? null
    if (orden == null) {
      const { data: ult } = await sb.from('pagos_conceptos').select('orden')
        .not('orden', 'is', null).order('orden', { ascending: false }).limit(1).maybeSingle()
      orden = Number((ult as { orden?: number } | null)?.orden ?? 0) + 1
    }
    const { data, error } = await sb.from('pagos_conceptos')
      .insert({ nombre: dto.nombre, orden, activo: true, created_by: userId, updated_by: userId })
      .select(COLS).single()
    if (error) throw errorDeEscritura(error, dto.nombre)
    return data as PagosConcepto
  },

  async editar(id: number, dto: UpdateConceptoDto, userId: string, token: string): Promise<PagosConcepto> {
    const sb = createSupabaseClient(token)
    const { data: actual, error: e0 } = await sb.from('pagos_conceptos').select(COLS).eq('id', id).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new PagosHttpError(404, 'CONCEPTO_NO_EXISTE', { concepto_id: id })
    const a = actual as PagosConcepto

    if (dto.activo === false && a.activo) {
      const { count, error: e1 } = await sb.from('pagos_conceptos').select('id', { count: 'exact', head: true })
        .eq('activo', true).neq('id', id)
      if (e1) throw new PagosHttpError(500, 'DB_ERROR', e1.message)
      if ((count ?? 0) === 0) throw new PagosHttpError(409, 'CONCEPTO_ULTIMO_ACTIVO', { campo: 'activo', concepto_id: id })
    }

    const cambios: Record<string, unknown> = { updated_by: userId }
    if (dto.nombre !== undefined) cambios.nombre = dto.nombre
    if (dto.orden !== undefined) cambios.orden = dto.orden
    if (dto.activo !== undefined) cambios.activo = dto.activo
    const { data, error } = await sb.from('pagos_conceptos').update(cambios).eq('id', id).select(COLS).single()
    if (error) throw errorDeEscritura(error, dto.nombre)
    return data as PagosConcepto
  },
}
