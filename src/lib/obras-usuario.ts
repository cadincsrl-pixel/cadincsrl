import { supabase as supabaseAdmin } from './supabase.js'

/**
 * Resuelve qué obras puede ver/operar un usuario.
 *
 * - rol = 'admin' → null (sin restricción, ve todo).
 * - rol != 'admin' con filas en usuario_obras → array de cods asignados.
 * - rol != 'admin' SIN filas en usuario_obras → array vacío (regla estricta).
 *
 * Endpoints que listan deben aplicar `.in('obra_cod', codes)` cuando el
 * resultado NO es null. Endpoints que mutan deben rechazar `obra_cod`
 * fuera del array (404/403).
 *
 * Cachear el resultado por request si necesitás múltiples chequeos
 * (este helper hace 2 queries cada vez).
 */
export async function getObrasDelUsuario(userId: string): Promise<string[] | null> {
  // Obtenemos el rol con el cliente service-role para evitar dependencia
  // del token JWT del request (este helper se llama desde middlewares y
  // services internos donde el token puede no estar disponible).
  const { data: profile, error: errProf } = await supabaseAdmin
    .from('profiles')
    .select('rol')
    .eq('id', userId)
    .maybeSingle()
  if (errProf) throw new Error(errProf.message)
  if (!profile) throw new Error('SIN_PERFIL')

  if (profile.rol === 'admin') return null

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
