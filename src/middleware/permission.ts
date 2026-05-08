import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { supabase } from '../lib/supabase.js'

export type Accion = 'lectura' | 'creacion' | 'actualizacion' | 'eliminacion'

async function fetchPermisos(userId: string) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('rol, permisos')
    .eq('id', userId)
    .single()
  return profile
}

export function requirePermiso(modulo: string, accion: Accion) {
  return createMiddleware(async (c, next) => {
    const profile = await fetchPermisos(c.get('user').id)
    if (!profile) throw new HTTPException(403, { message: 'Sin perfil' })
    if (profile.rol === 'admin') return next()

    const permisos = profile.permisos as Record<string, Record<string, boolean>> | null
    if (permisos?.[modulo]?.[accion] !== true) {
      throw new HTTPException(403, {
        message: `Sin permiso para ${accion} en módulo ${modulo}`,
      })
    }
    return next()
  })
}

// Permite acceso si el usuario tiene AL MENOS UNO de los permisos indicados
export function requirePermisoOr(combos: Array<{ modulo: string; accion: Accion }>) {
  return createMiddleware(async (c, next) => {
    const profile = await fetchPermisos(c.get('user').id)
    if (!profile) throw new HTTPException(403, { message: 'Sin perfil' })
    if (profile.rol === 'admin') return next()

    const permisos = profile.permisos as Record<string, Record<string, boolean>> | null
    const tieneAlguno = combos.some(({ modulo, accion }) => permisos?.[modulo]?.[accion] === true)
    if (!tieneAlguno) {
      throw new HTTPException(403, { message: 'Sin permiso' })
    }
    return next()
  })
}

/**
 * Valida que `permisos.<modulo>.<flag>` sea exactamente igual a `expected`.
 *
 * Útil para flags booleanos extra del esquema de permisos (no son acciones
 * CRUD estándar). Ej.: `solo_carga_horas`, `ver_costos`, `forzar_despacho`.
 *
 * - Admin (`rol='admin'`) hace bypass siempre.
 * - Si el flag no coincide con `expected` → 403 con
 *   `{ error: 'SIN_PERMISO', detail: { flag } }`.
 *
 * Notar que la **ausencia** del flag se trata como `false`. Si esperás
 * `expected=false`, un usuario sin el flag pasa (consistente con la
 * semántica "el flag NO está activado").
 */
export function requireFlag(modulo: string, flag: string, expected: boolean = true) {
  return createMiddleware(async (c, next) => {
    const profile = await fetchPermisos(c.get('user').id)
    if (!profile) throw new HTTPException(403, { message: 'Sin perfil' })
    if (profile.rol === 'admin') return next()

    const permisos = profile.permisos as Record<string, Record<string, unknown>> | null
    const actual = permisos?.[modulo]?.[flag] === true
    if (actual !== expected) {
      return c.json(
        { error: 'SIN_PERMISO', detail: { flag } },
        403,
      )
    }
    return next()
  })
}
