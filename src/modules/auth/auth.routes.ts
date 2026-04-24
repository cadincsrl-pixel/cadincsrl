import { Hono } from 'hono'
import { authMiddleware } from '../../middleware/auth.js'
import { supabase } from '../../lib/supabase.js'  // ← cliente admin puro

const auth = new Hono()
auth.use('*', authMiddleware)

auth.get('/profile', async (c) => {
  const userId = c.get('user').id

  const { data, error } = await supabase
    .from('profiles')
    .select('id, nombre, rol, modulos, activo, permisos')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('[GET /auth/profile] db error for user', userId, error.message)
    return c.json({ error: error.message }, 500)
  }
  if (!data)  return c.json({ error: 'Perfil no encontrado' }, 404)
  if (!data.activo) return c.json({ error: 'Usuario inactivo' }, 403)

  return c.json(data)
})

// GET /api/auth/perfiles — nombres de todos los usuarios activos (cualquier usuario autenticado)
auth.get('/perfiles', async (c) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, nombre')
    .eq('activo', true)
    .order('nombre')

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

export default auth