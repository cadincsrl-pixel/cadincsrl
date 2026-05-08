import { HTTPException } from 'hono/http-exception'
import { supabase as supabaseAdmin } from './supabase.js'

/**
 * Resuelve qué obras puede ver/operar un usuario.
 *
 * Regla:
 * - rol='admin' → null (sin restricción, ve todo).
 * - tipo_usuario en TIPOS_OBRAS_RESTRINGIDAS (capataz, jefe_obra) → restringido
 *   por usuario_obras SIEMPRE (incluso si está vacío → ve cero).
 * - Otros tipos (administrativo, compras, personalizado, null) → restringido
 *   SOLO si tiene al menos una fila en usuario_obras. Si no tiene → null
 *   (ve todo, comportamiento "global").
 *
 * Esto permite que un admin asigne obras puntuales a un user "personalizado"
 * (ej. jefe de obra editado a mano) y el sistema lo respete sin tener que
 * cambiar tipo_usuario.
 *
 * Endpoints que listan deben aplicar `.in('obra_cod', codes)` cuando el
 * resultado NO es null. Endpoints que mutan deben rechazar `obra_cod`
 * fuera del array (404/403).
 */
const TIPOS_OBRAS_RESTRINGIDAS = new Set(['capataz', 'jefe_obra', 'jefe_obra_supervisor'])

export async function getObrasDelUsuario(userId: string): Promise<string[] | null> {
  const { data: profile, error: errProf } = await supabaseAdmin
    .from('profiles')
    .select('rol, tipo_usuario')
    .eq('id', userId)
    .maybeSingle()
  if (errProf) throw new Error(errProf.message)
  if (!profile) throw new Error('SIN_PERFIL')

  if (profile.rol === 'admin') return null

  // Leemos usuario_obras siempre. Decidimos si filtrar según tipo + presencia.
  const { data, error } = await supabaseAdmin
    .from('usuario_obras')
    .select('obra_cod')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  const obras = (data ?? []).map(r => r.obra_cod)

  // Tipos restringidos: SIEMPRE filtran (aunque obras esté vacío → ve cero).
  const tipoRestringido = profile.tipo_usuario && TIPOS_OBRAS_RESTRINGIDAS.has(profile.tipo_usuario)
  if (tipoRestringido) return obras

  // Otros tipos: solo filtran SI hay obras asignadas. Si no, ven todo.
  if (obras.length > 0) return obras
  return null
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
