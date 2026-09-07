import { createClient } from '@supabase/supabase-js'
import { HEADER_USUARIO, subDelJwt } from './jwt.js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Faltan variables de entorno de Supabase')
}

// Cliente admin — service role, saltea RLS completamente
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

// Cliente por request. Hasta 2026-09-07 mandaba el JWT del usuario en
// Authorization: PostgREST resolvía el rol por ese JWT (`authenticated`) y la
// base tenía que dejar escribir a `authenticated`, o sea a cualquier usuario
// logueado con la anon key, sin pasar por el backend. Ahora el backend opera
// siempre como service_role (es el único escritor legítimo) y le dice a la
// base quién es el usuario con el header x-cadinc-user, que lee
// `usuario_actual()` (migración 20260906q) para atribuir la auditoría.
// El JWT ya fue verificado por authMiddleware; acá solo se lee su `sub`.
export function createSupabaseClient(accessToken: string) {
  const userId = subDelJwt(accessToken)
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: userId ? { [HEADER_USUARIO]: userId } : {},
    },
  })
}