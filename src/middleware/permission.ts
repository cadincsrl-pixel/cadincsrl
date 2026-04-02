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
