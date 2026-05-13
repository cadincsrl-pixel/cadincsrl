import { HTTPException } from 'hono/http-exception'
import { supabase as supabaseAdmin } from './supabase.js'

// Whitelist de módulos válidos. Tiene que coincidir con el CHECK constraint
// `usuario_obras_modulo_chk` en DB. Validar acá evita filter injection en
// `.or()` y typos silenciosos en `permisos.<modulo>` del JSONB.
const MODULOS_VALIDOS = new Set([
  'tarja', 'logistica', 'certificaciones', 'herramientas',
  'caja', 'ropa', 'prestamos', 'admin', 'configuracion', 'flota',
])

/**
 * Resuelve qué obras puede ver/operar un usuario en un módulo dado.
 *
 * Modelo v2.1 (con override de scope POR MÓDULO):
 *
 * 1) Resolución del scope efectivo:
 *    - rol='admin'                                            → null (ve todo)
 *    - permisos.<modulo>.obras_scope = 'todas'                → null (ve todo)
 *    - permisos.<modulo>.obras_scope = 'asignadas'            → filtra
 *    - sin override → cae al `profiles.obras_scope` global    → null o filtra
 *    - sin nada seteado → fallback legacy por tipo_usuario
 *
 * 2) Cuando el scope efectivo es 'asignadas':
 *    - Lee `usuario_obras` filtrando por user_id.
 *    - Si se pasó `modulo`, devuelve rows donde `modulo = X OR modulo IS NULL`.
 *      (NULL = aplica a todos los módulos, sirve para perfiles legacy y
 *      para usuarios cuyo set de obras no varía entre módulos.)
 *    - Si no se pasó `modulo`, devuelve TODAS las rows (cualquier módulo).
 *
 * 3) Endpoints que listan deben aplicar `.in('obra_cod', codes)` cuando el
 *    resultado NO es null. Endpoints que mutan deben rechazar `obra_cod`
 *    fuera del array (403). Idealmente cada caller pasa su módulo para
 *    que el override por módulo se respete.
 */

interface PermisoFlags {
  obras_scope?: 'todas' | 'asignadas'
}
type PermisosShape = Record<string, PermisoFlags | undefined>

const TIPOS_OBRAS_RESTRINGIDAS_LEGACY = new Set([
  'capataz', 'capataz_supervisor',
  'jefe_obra', 'jefe_obra_supervisor',
])

export async function getObrasDelUsuario(
  userId: string,
  modulo?: string,
): Promise<string[] | null> {
  // Defensa en profundidad: si el caller pasa un módulo desconocido,
  // tratamos como si no hubiera pasado. Evita filter injection en .or()
  // y previene que un caller mal escrito acceda a otro contexto por typo.
  const moduloSeguro = modulo && MODULOS_VALIDOS.has(modulo) ? modulo : undefined

  const { data: profile, error: errProf } = await supabaseAdmin
    .from('profiles')
    .select('rol, tipo_usuario, obras_scope, permisos')
    .eq('id', userId)
    .maybeSingle()
  if (errProf) throw new Error(errProf.message)
  if (!profile) throw new Error('SIN_PERFIL')

  if (profile.rol === 'admin') return null

  // 1) Scope efectivo: override por módulo > scope global > fallback legacy.
  const permisos = (profile.permisos ?? {}) as PermisosShape
  const overrideModulo = moduloSeguro ? permisos[moduloSeguro]?.obras_scope : undefined
  const scopeGlobal = profile.obras_scope as 'todas' | 'asignadas' | null | undefined

  let scopeEfectivo: 'todas' | 'asignadas' | null = null
  if (overrideModulo === 'todas' || overrideModulo === 'asignadas') {
    scopeEfectivo = overrideModulo
  } else if (scopeGlobal === 'todas' || scopeGlobal === 'asignadas') {
    scopeEfectivo = scopeGlobal
  }

  if (scopeEfectivo === 'todas') return null

  if (scopeEfectivo === 'asignadas') {
    let query = supabaseAdmin
      .from('usuario_obras')
      .select('obra_cod, modulo')
      .eq('user_id', userId)
    if (moduloSeguro) {
      // PostgREST `.or()` interpola en string así que normalmente sería
      // riesgo de filter injection. Acá es seguro porque `moduloSeguro`
      // ya pasó por MODULOS_VALIDOS (set hardcodeado de literales sin
      // metacaracteres). NO sustituir esto por concatenación arbitraria
      // de input externo. PostgREST no soporta NULL en `.in()` así que
      // `.or()` es la única forma compacta de hacer "modulo=X OR NULL".
      query = query.or(`modulo.eq.${moduloSeguro},modulo.is.null`)
    }
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return Array.from(new Set((data ?? []).map(r => r.obra_cod)))
  }

  // Fallback legacy (perfil sin obras_scope ni override).
  const { data, error } = await supabaseAdmin
    .from('usuario_obras')
    .select('obra_cod, modulo')
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
