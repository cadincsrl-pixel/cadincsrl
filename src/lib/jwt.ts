/**
 * Utilidades mínimas de JWT para el backend. La verificación de firma la hace
 * authMiddleware (JWKS); acá solo se lee el payload de un token ya verificado.
 */

/** Header con el que el backend le dice a la base quién es el usuario del request. */
export const HEADER_USUARIO = 'x-cadinc-user'

/**
 * `sub` del JWT sin verificar la firma. Devuelve null si el string no es un
 * JWT o el payload no trae `sub`.
 */
export function subDelJwt(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { sub?: unknown }
    return typeof json.sub === 'string' && json.sub ? json.sub : null
  } catch {
    return null
  }
}
