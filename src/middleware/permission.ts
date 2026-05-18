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
 * CRUD estándar). Ej.: `ver_costos`, `ver_pii`, `forzar_despacho`,
 * `administrar_obras`, `resolver_items`.
 *
 * - Admin (`rol='admin'`) hace bypass siempre.
 * - Si el flag no está definido en el JSONB, se usa `defaultActual` como
 *   valor presunto. Esto permite back-compat: un flag "permisivo" como
 *   `ver_costos` puede pedirse con `defaultActual=true` y todos los users
 *   sin el flag explícito pasan; los que lo tengan en `false` rebotan.
 *
 * @param expected      valor que debe tener el flag para pasar.
 * @param defaultActual valor a asumir cuando el flag no está definido.
 */
export function requireFlag(
  modulo: string,
  flag: string,
  expected: boolean = true,
  defaultActual: boolean = false,
) {
  return createMiddleware(async (c, next) => {
    const profile = await fetchPermisos(c.get('user').id)
    if (!profile) throw new HTTPException(403, { message: 'Sin perfil' })
    if (profile.rol === 'admin') return next()

    const permisos = profile.permisos as Record<string, Record<string, unknown>> | null
    const v = permisos?.[modulo]?.[flag]
    const actual = v === undefined ? defaultActual : Boolean(v)
    if (actual !== expected) {
      return c.json(
        { error: 'SIN_PERMISO', detail: { flag } },
        403,
      )
    }
    return next()
  })
}
