/**
 * Jurisdicciones (tanda 6, ítem 6; base 20260929f): tipos y funciones puras.
 *
 * `resolverJurisdiccion` es el espejo de `public._jurisdiccion_resolver()`:
 * normaliza con `normTxt` (espejo exacto de norm_txt) y busca por nombre o
 * alias entre las ACTIVAS; un único match → la jurisdicción, si no null. Lo
 * usa la lectura IA de facturas de compra para proponer el id; la base lo
 * vuelve a resolver igual al guardar (trigger fn_jurisdiccion_normalizar).
 */
import { normTxt } from '../../lib/norm-txt.js'

export const TIPOS_JURISDICCION = ['nacional', 'provincial', 'municipal'] as const
export type TipoJurisdiccion = (typeof TIPOS_JURISDICCION)[number]

export interface Jurisdiccion {
  id: number
  nombre: string
  tipo: TipoJurisdiccion
  provincia_id: number | null
  provincia_nombre: string | null
  codigo_comarb: string | null
  codigo_arca: number | null
  alias: string[]
  activo: boolean
  usos: { tributos: number; retenciones: number }
  created_at?: string
  updated_at?: string
  created_by?: string | null
  updated_by?: string | null
}

/** Lo mínimo para resolver un texto. */
export type JurisdiccionResoluble = Pick<Jurisdiccion, 'id' | 'nombre' | 'alias' | 'activo'>

export function resolverJurisdiccion<T extends JurisdiccionResoluble>(
  texto: string | null | undefined,
  lista: readonly T[],
): T | null {
  const t = normTxt(texto ?? '')
  if (!t) return null
  const hits = lista.filter((j) => j.activo && (normTxt(j.nombre) === t || (j.alias ?? []).some((a) => normTxt(a) === t)))
  return hits.length === 1 ? hits[0]! : null
}
