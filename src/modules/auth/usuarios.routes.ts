import { Hono } from 'hono'
import { z }    from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { supabase } from '../../lib/supabase.js'
import { createClient } from '@supabase/supabase-js'

const usuarios = new Hono()

// Cliente admin para gestionar auth.users
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// ── Middlewares ──
usuarios.use('*', authMiddleware)

usuarios.use('*', async (c, next) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('rol')
    .eq('id', c.get('user').id)
    .single()

  if (profile?.rol !== 'admin') {
    return c.json({ error: 'Sin permisos' }, 403)
  }
  await next()
})

// ── GET /api/usuarios — listar todos ──
usuarios.get('/', async (c) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('nombre')

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// ── GET /api/usuarios/modulos ──
usuarios.get('/modulos', async (c) => {
  const { data, error } = await supabase
    .from('modulos')
    .select('*')
    .eq('activo', true)
    .order('orden')

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// ── POST /api/usuarios — crear usuario ──
const PermisosSchema = z.record(
  z.string(),
  z.object({
    lectura:      z.boolean().optional(),
    creacion:     z.boolean().optional(),
    actualizacion: z.boolean().optional(),
    eliminacion:  z.boolean().optional(),
  })
)

const CreateUsuarioSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
  nombre:   z.string().min(1),
  rol:      z.enum(['admin', 'operador']),
  modulos:  z.array(z.string()),
  permisos: PermisosSchema.optional(),
})

usuarios.post('/', zValidator('json', CreateUsuarioSchema), async (c) => {
  const { email, password, nombre, rol, modulos, permisos } = c.req.valid('json')

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  console.log('authData:', authData)
  console.log('authError:', authError)

  if (authError) return c.json({ error: authError.message }, 500)
  if (!authData.user) return c.json({ error: 'No se pudo crear el usuario' }, 500)

  const { data, error } = await supabase
    .from('profiles')
    .update({ nombre, rol, modulos, permisos: permisos ?? {} })
    .eq('id', authData.user.id)
    .select()
    .single()

  console.log('profile data:', data)
  console.log('profile error:', error)

  if (error) return c.json({ error: error.message }, 500)

  return c.json(data, 201)
})

// ── PATCH /api/usuarios/:id — actualizar perfil ──
const UpdateSchema = z.object({
  nombre:   z.string().min(1).optional(),
  rol:      z.enum(['admin', 'operador']).optional(),
  modulos:  z.array(z.string()).optional(),
  activo:   z.boolean().optional(),
  permisos: PermisosSchema.optional(),
})

usuarios.patch('/:id', zValidator('json', UpdateSchema), async (c) => {
  const id  = c.req.param('id')
  const dto = c.req.valid('json')

  const { data, error } = await supabase
    .from('profiles')
    .update(dto)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// ── DELETE /api/usuarios/:id — eliminar usuario ──
usuarios.delete('/:id', async (c) => {
  const id = c.req.param('id')

  if (id === c.get('user').id) {
    return c.json({ error: 'No podés eliminarte a vos mismo' }, 400)
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ success: true })
})

export default usuarios