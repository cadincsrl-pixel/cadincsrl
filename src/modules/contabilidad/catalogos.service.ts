/**
 * Catálogos que usa la carga de asientos: obras (una línea puede ir a una
 * obra) y auxiliares (cliente de Ventas, proveedor de Pagos o cuenta de
 * tesorería, según `cont_cuentas.auxiliar`). Contabilidad es la integradora
 * por diseño: es el único módulo que lee los padrones de Ventas y de Pagos.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { mapRpcError, type PgError } from './contabilidad.errors.js'
import type { AuxiliaresQuery } from './contabilidad.schema.js'

export interface CtbAuxiliar { id: number; nombre: string; doc: string | null; activo: boolean }
export interface CtbObra { cod: string; nom: string; archivada: boolean }

const MAX_SIN_IDS = 30
const MAX_IDS = 500

/** Texto de búsqueda seguro para un `ilike` (sin comodines ni separadores de PostgREST). */
export function limpiarBusqueda(q: string | undefined): string {
  return normTxt(q ?? '').replace(/[%_,()]/g, ' ').trim()
}

export function idsDeCsv(ids: string | undefined): number[] {
  if (!ids) return []
  return [...new Set(ids.split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS)
}

export const catalogosService = {
  async obras(db: SupabaseClient = supabase): Promise<CtbObra[]> {
    return todasLasFilas<CtbObra>((d, h) =>
      db.from('obras').select('cod, nom, archivada').order('cod').range(d, h))
  },

  /**
   * Sin `ids`: hasta 30 activos que matcheen `q`. Con `ids`: esos (activos o
   * no), para mostrar el nombre de los auxiliares de un asiento ya cargado.
   */
  async auxiliares(f: AuxiliaresQuery, db: SupabaseClient = supabase): Promise<CtbAuxiliar[]> {
    const ids = idsDeCsv(f.ids)
    const busq = limpiarBusqueda(f.q)
    const digitos = (f.q ?? '').replace(/\D/g, '')

    if (f.tipo === 'tesoreria') {
      let q = db.from('tesoreria_cuentas').select('id, nombre, cbu, activo')
      if (ids.length) q = q.in('id', ids)
      else q = q.eq('activo', true)
      const { data, error } = await q.order('nombre').order('id')
      if (error) throw mapRpcError(error as PgError)
      const filas = (data ?? []) as Array<{ id: number; nombre: string; cbu: string | null; activo: boolean }>
      return filas
        .filter((t) => ids.length > 0 || !busq || normTxt(t.nombre).includes(busq))
        .slice(0, ids.length ? MAX_IDS : MAX_SIN_IDS)
        .map((t) => ({ id: t.id, nombre: t.nombre, doc: t.cbu, activo: t.activo }))
    }

    const tabla = f.tipo === 'cliente' ? 'ventas_clientes' : 'pagos_proveedores'
    const colDoc = f.tipo === 'cliente' ? 'doc_nro' : 'cuit'
    let q = db.from(tabla).select(`id, razon_social, ${colDoc}, activo`)
    if (ids.length) {
      q = q.in('id', ids)
    } else {
      q = q.eq('activo', true)
      if (digitos.length >= 3 && digitos.length === (f.q ?? '').replace(/[\s.\-/]/g, '').length) q = q.ilike(colDoc, `%${digitos}%`)
      else if (busq) q = q.ilike('razon_social_norm', `%${busq}%`)
      q = q.limit(MAX_SIN_IDS)
    }
    const { data, error } = await q.order('razon_social_norm').order('id')
    if (error) throw mapRpcError(error as PgError)
    return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id), nombre: String(r.razon_social ?? ''), doc: (r[colDoc] as string | null) ?? null, activo: Boolean(r.activo),
    }))
  },
}
