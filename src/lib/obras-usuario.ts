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
 *    - permisos.<modulo>.obras_scope (si se pasó `modulo`)    → manda sobre el global
 *    - profiles.obras_scope = 'todas'                         → null (ve todo)
 *    - profiles.obras_scope = 'asignadas'                     → filtra
 *    - sin nada seteado → fallback legacy por tipo_usuario
 *
 *    El override por módulo lo escribe el wizard (y el addon "cargar horas
 *    propias"); entre permisos v3 (2026-05-18) y el 2026-09-06 se aceptaba
 *    pero no se leía, así que un depósito con `tarja: 'asignadas'` veía la
 *    tarja de todas las obras.
 *
 * 2) Cuando el scope efectivo es 'asignadas':
 *    - Lee `usuario_obras` filtrando por user_id y devuelve los obra_cod.
 *      Es UNA lista por usuario (la columna `usuario_obras.modulo` se
 *      eliminó en v3): el módulo solo decide si la lista aplica o no.
 *
 * 3) Endpoints que listan deben aplicar `.in('obra_cod', codes)` cuando el
 *    resultado NO es null. Endpoints que mutan deben rechazar `obra_cod`
 *    fuera del array (403).
 */

/**
 * Tipos de usuario que, en el modelo viejo (pre-v3), implicaban scope
 * restringido a las obras asignadas. Hoy esto es solo fallback defensivo:
 * la migración `20260518_permisos_v3_cleanup.sql` setea `obras_scope` y
 * `rol_base` para todos los profiles, así que este fallback no debería
 * ejecutarse en perfiles vigentes. Exportada para que `personal.routes.ts`
 * y otros sitios usen la misma lista en vez de duplicar el array.
 */
export const TIPOS_LEGACY_RESTRINGIDOS = new Set([
  'capataz', 'capataz_supervisor',
  'jefe_obra', 'jefe_obra_supervisor',
])

export async function getObrasDelUsuario(
  userId: string,
  modulo?: string,
): Promise<string[] | null> {
  // Un módulo con typo o inexistente se trata como no pasado.
  const moduloValido = modulo && MODULOS_VALIDOS.has(modulo) ? modulo : undefined

  const { data: profile, error: errProf } = await supabaseAdmin
    .from('profiles')
    .select('rol, tipo_usuario, obras_scope, permisos')
    .eq('id', userId)
    .maybeSingle()
  if (errProf) throw new Error(errProf.message)
  if (!profile) throw new Error('SIN_PERFIL')

  if (profile.rol === 'admin') return null

  // 1) Scope efectivo: el override del módulo manda; si no, el global.
  const esScope = (v: unknown): v is 'todas' | 'asignadas' => v === 'todas' || v === 'asignadas'
  const permisos = (profile.permisos ?? {}) as Record<string, { obras_scope?: unknown } | null | undefined>
  const override = moduloValido ? permisos[moduloValido]?.obras_scope : undefined
  const scopeGlobal = profile.obras_scope
  const scopeEfectivo: 'todas' | 'asignadas' | null =
    esScope(override) ? override : esScope(scopeGlobal) ? scopeGlobal : null

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
  const tipoRestringido = profile.tipo_usuario && TIPOS_LEGACY_RESTRINGIDOS.has(profile.tipo_usuario)
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

/**
 * Valida el alcance por obra de un registro que ya existe (PATCH/DELETE por
 * id, movimientos de un ítem, comprobante de un remito): busca su `obra_cod`
 * y aplica la misma regla que validarObraDelUsuario.
 *
 * - `viaSolicitud`: la tabla no tiene obra_cod propio sino `solicitud_id`
 *   (solicitud_compra_item): se lee `solicitud_compra(obra_cod)`.
 * - Admin / scope 'todas' → no consulta nada.
 * - Registro inexistente → 404 `NO_EXISTE` (el handler no llega a ejecutarse).
 */
export async function validarObraDeRegistro(
  userId: string,
  modulo: string,
  tabla: string,
  id: number | string,
  opts: { viaSolicitud?: boolean } = {},
): Promise<void> {
  const allowed = await getObrasDelUsuarioCached(userId, modulo)
  if (allowed == null) return
  const { data, error } = await supabaseAdmin
    .from(tabla)
    .select(opts.viaSolicitud ? 'solicitud_compra(obra_cod)' : 'obra_cod')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new HTTPException(404, { message: 'NO_EXISTE' })
  const fila = data as Record<string, unknown>
  const obraCod = opts.viaSolicitud
    ? (fila.solicitud_compra as { obra_cod?: string } | null | undefined)?.obra_cod
    : (fila.obra_cod as string | null | undefined)
  if (!obraCod || !allowed.includes(obraCod)) {
    throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
  }
}

/** true si el usuario tiene alcance por obras pero ninguna obra asignada: los listados devuelven vacío sin consultar. */
export function sinObras(allowed: string[] | null): boolean {
  return allowed != null && allowed.length === 0
}
