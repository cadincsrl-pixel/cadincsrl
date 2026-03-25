// src/middleware/auth.ts
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { jwtVerify, createRemoteJWKSet } from 'jose'

const SUPABASE_URL = process.env.SUPABASE_URL!
const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
const JWKS = createRemoteJWKSet(new URL(JWKS_URL))

export type AuthUser = {
  id: string
  email: string
  role: string
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
    accessToken: string
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const authorization = c.req.header('Authorization')

  if (!authorization || !authorization.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Token requerido' })
  }

  const token = authorization.slice(7)

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
    })

    c.set('user', {
      id: payload.sub!,
      email: payload.email as string,
      role: payload.role as string,
    })

    // Guardamos el token para usarlo en los servicios
    c.set('accessToken', token)

    await next()
  } catch {
    throw new HTTPException(401, { message: 'Token inválido o expirado' })
  }
})