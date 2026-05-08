import { HTTPException } from 'hono/http-exception'
import { supabase as supabaseAdmin } from './supabase.js'

/**
 * Resuelve qué obras puede ver/operar un usuario.
 *
 * - rol = 'admin' → null (sin restricción, ve todo).
 * - tipo_usuario que NO esté en TIPOS_OBRAS_RESTRINGIDAS → null (también ve
 *   todo). Ej: administrativo, compras, encargado_deposito, personalizado, null.
 * - tipo_usuario en TIPOS_OBRAS_RESTRINGIDAS (capataz, jefe_obra) con filas
 *   en usuario_obras → array de cods asignados.
 * - tipo_usuario restringido SIN filas en usuario_obras → array vacío
 *   (regla estricta: ve cero obras).
 *
 * Endpoints que listan deben aplicar `.in('obra_cod', codes)` cuando el
 * resultado NO es null. Endpoints que mutan deben rechazar `obra_cod`
 * fuera del array (404/403).
 */
const TIPOS_OBRAS_RESTRINGIDAS = new Set(['capataz', 'jefe_obra'])

export async function getObrasDelUsuario(userId: string): Promise<string[] | null> {
  // Obtenemos rol + tipo_usuario con el cliente service-role para evitar
  // dependencia del token JWT del request (este helper se llama desde
  // middlewares y services internos).
  const { data: profile, error: errProf } = await supabaseAdmin
    .from('profiles')
    .select('rol, tipo_usuario')
    .eq('id', userId)
    .maybeSingle()
  if (errProf) throw new Error(errProf.message)
  if (!profile) throw new Error('SIN_PERFIL')

  if (profile.rol === 'admin') return null

  // Solo los tipos cuya plantilla declara obras_restringidas:true tienen
  // filtro estricto. Los administrativos / compras / encargado de depósito /
  // personalizado / sin tipo → ven todas las obras.
  if (!profile.tipo_usuario || !TIPOS_OBRAS_RESTRINGIDAS.has(profile.tipo_usuario)) {
    return null
  }

  const { data, error } = await supabaseAdmin
    .from('usuario_obras')
    .select('obra_cod')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)

  return (data ?? []).map(r => r.obra_cod)
}

/**
 * Igual que getObrasDelUsuario pero con cache por user_id en memoria.
 * El TTL es chico (60s) — si el admin cambia las obras, el user va a
 * verlas reflejadas en máximo un minuto sin tener que cerrar sesión.
 */
const cache = new Map<string, { codes: string[] | null; until: number }>()
const TTL_MS = 60_000

export async function getObrasDelUsuarioCached(userId: string): Promise<string[] | null> {
  const now = Date.now()
  const hit = cache.get(userId)
  if (hit && hit.until > now) return hit.codes
  const codes = await getObrasDelUsuario(userId)
  cache.set(userId, { codes, until: now + TTL_MS })
  return codes
}

export function invalidarCacheObrasUsuario(userId: string): void {
  cache.delete(userId)
}

/**
 * Valida que `obraCod` esté entre las obras del usuario.
 *
 * - Admin (allowed === null) pasa siempre.
 * - Usuario no admin con `obraCod` no incluido → lanza
 *   `HTTPException(403)` con `message='OBRA_SIN_ACCESO'`.
 *
 * El handler que llame a este helper puede usar `HTTPException` directamente
 * (Hono lo serializa como `{ message }`) o capturarlo y devolver el shape
 * que ya esté usando ese módulo.
 */
export async function validarObraDelUsuario(userId: string, obraCod: string): Promise<void> {
  const allowed = await getObrasDelUsuarioCached(userId)
  if (allowed != null && !allowed.includes(obraCod)) {
    throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  }
}
