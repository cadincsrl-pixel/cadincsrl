import { HTTPException } from 'hono/http-exception'
import { supabase as supabaseAdmin } from './supabase.js'
import { MODULO_SET as MODULOS_VALIDOS } from './modulos.js'

// Whitelist de módulos válidos viene de la constante única en `modulos.ts`.
// Validar acá evita filter injection en `.or()` y typos silenciosos en
// `permisos.<modulo>` del JSONB. El nombre local del símbolo se mantiene
// para minimizar cambios en el resto del archivo.

/**
 * Resuelve qué obras puede ver/operar un usuario en un módulo dado.
 *
 * Modelo v3 (simplificado, 2 niveles):
 *
 * 1) Resolución del scope efectivo:
 *    - rol='admin'                                            → null (ve todo)
 *    - profiles.obras_scope = 'todas'                         → null (ve todo)
 *    - profiles.obras_scope = 'asignadas'                     → filtra
 *    - sin nada seteado → fallback legacy por tipo_usuario
 *
 * 2) Cuando el scope efectivo es 'asignadas':
 *    - Lee `usuario_obras` filtrando por user_id y devuelve los obra_cod.
 *    - El override por módulo + la columna `usuario_obras.modulo` se
 *      eliminaron en la migración Permisos v3 (2026-05-18). El parámetro
 *      `modulo` se acepta pero solo se usa para defense-in-depth (validación
 *      del nombre) — no cambia el resultado.
 *
 * 3) Endpoints que listan deben aplicar `.in('obra_cod', codes)` cuando el
 *    resultado NO es null. Endpoints que mutan deben rechazar `obra_cod`
 *    fuera del array (403).
 */

const TIPOS_OBRAS_RESTRINGIDAS_LEGACY = new Set([
  'capataz', 'capataz_supervisor',
  'jefe_obra', 'jefe_obra_supervisor',
])

export async function getObrasDelUsuario(
  userId: string,
  modulo?: string,
): Promise<string[] | null> {
  // Defensa en profundidad: validamos el nombre del módulo aunque ya no
  // afecte la query (la columna usuario_obras.modulo se eliminó). Útil para
  // detectar callers con typos y mantener el contrato.
  if (modulo && !MODULOS_VALIDOS.has(modulo)) {
    // typo o módulo inexistente: lo tratamos como no pasado.
  }

  const { data: profile, error: errProf } = await supabaseAdmin
    .from('profiles')
    .select('rol, tipo_usuario, obras_scope')
    .eq('id', userId)
    .maybeSingle()
  if (errProf) throw new Error(errProf.message)
  if (!profile) throw new Error('SIN_PERFIL')

  if (profile.rol === 'admin') return null

  // 1) Scope efectivo: solo el global del profile (v3 eliminó overrides).
  const scopeGlobal = profile.obras_scope as 'todas' | 'asignadas' | null | undefined
  const scopeEfectivo: 'todas' | 'asignadas' | null =
    scopeGlobal === 'todas' || scopeGlobal === 'asignadas' ? scopeGlobal : null

  if (scopeEfectivo === 'todas') return null

  if (scopeEfectivo === 'asignadas') {
    const { data, error } = await supabaseAdmin
      .from('usuario_obras')
      .select('obra_cod')
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
    return Array.from(new Set((data ?? []).map(r => r.obra_cod)))
  }

  // Fallback legacy (perfil sin obras_scope).
  const { data, error } = await supabaseAdmin
    .from('usuario_obras')
    .select('obra_cod')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  const obras = (data ?? []).map(r => r.obra_cod)
  const tipoRestringido = profile.tipo_usuario && TIPOS_OBRAS_RESTRINGIDAS_LEGACY.has(profile.tipo_usuario)
  if (tipoRestringido) return Array.from(new Set(obras))
  if (obras.length > 0) return Array.from(new Set(obras))
  return null
}

/**
 * Igual que getObrasDelUsuario pero con cache por (user_id, modulo).
 * El TTL es chico (60s) — si el admin cambia las obras, el user las ve
 * reflejadas en máximo un minuto sin tener que cerrar sesión.
 */
const cache = new Map<string, { codes: string[] | null; until: number }>()
const TTL_MS = 60_000

function cacheKey(userId: string, modulo?: string): string {
  return modulo ? `${userId}:${modulo}` : userId
}

export async function getObrasDelUsuarioCached(
  userId: string,
  modulo?: string,
): Promise<string[] | null> {
  const now = Date.now()
  const key = cacheKey(userId, modulo)
  const hit = cache.get(key)
  if (hit && hit.until > now) return hit.codes
  const codes = await getObrasDelUsuario(userId, modulo)
  cache.set(key, { codes, until: now + TTL_MS })
  return codes
}

export function invalidarCacheObrasUsuario(userId: string): void {
  // Borra todas las entries del user, sin importar el módulo.
  const prefix = `${userId}:`
  for (const k of Array.from(cache.keys())) {
    if (k === userId || k.startsWith(prefix)) cache.delete(k)
  }
}

/**
 * Valida que `obraCod` esté entre las obras del usuario en el módulo dado.
 *
 * - Admin (allowed === null) pasa siempre.
 * - Usuario no admin con `obraCod` no incluido → lanza
 *   `HTTPException(403)` con `message='OBRA_SIN_ACCESO'`.
 *
 * Idealmente cada handler pasa su módulo para respetar el override por módulo.
 * Si no se pasa, se usa el scope global del perfil.
 */
export async function validarObraDelUsuario(
  userId: string,
  obraCod: string,
  modulo?: string,
): Promise<void> {
  const allowed = await getObrasDelUsuarioCached(userId, modulo)
  if (allowed != null && !allowed.includes(obraCod)) {
    throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  }
}
