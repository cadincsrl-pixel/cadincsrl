import { Hono } from 'hono'
import { z }    from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { supabase } from '../../lib/supabase.js'
import { invalidarCacheObrasUsuario } from '../../lib/obras-usuario.js'
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

// ── GET /api/usuarios — listar todos (con email) ──
usuarios.get('/', async (c) => {
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('*')
    .order('nombre')

  if (error) return c.json({ error: error.message }, 500)

  // Traer emails de auth.users
  const { data: { users } } = await supabaseAdmin.auth.admin.listUsers()
  const emailMap = new Map(users.map(u => [u.id, u.email]))

  const result = (profiles ?? []).map(p => ({
    ...p,
    email: emailMap.get(p.id) ?? null,
  }))

  return c.json(result)
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
// Permite tabs[] y flags conocidos por módulo. IMPORTANTE: zod hace strip
// de claves no listadas, así que cualquier flag nuevo debe agregarse acá
// o se perderá silenciosamente al guardar (causó pérdida de
// solo_carga_horas en perfiles tipo capataz).
const PermisosSchema = z.record(
  z.string(),
  z.object({
    lectura:          z.boolean().optional(),
    creacion:         z.boolean().optional(),
    actualizacion:    z.boolean().optional(),
    eliminacion:      z.boolean().optional(),
    tabs:             z.array(z.string()).optional(),
    ver_costos:       z.boolean().optional(),
    solo_carga_horas: z.boolean().optional(),
    resolver_items:   z.boolean().optional(),
    forzar_despacho:  z.boolean().optional(),
  }),
)

const CreateUsuarioSchema = z.object({
  email:        z.string().email(),
  password:     z.string().min(6, 'Mínimo 6 caracteres'),
  nombre:       z.string().min(1),
  rol:          z.enum(['admin', 'operador']),
  modulos:      z.array(z.string()),
  permisos:     PermisosSchema.optional(),
  tipo_usuario: z.string().nullable().optional(),
})

usuarios.post('/', zValidator('json', CreateUsuarioSchema), async (c) => {
  const { email, password, nombre, rol, modulos, permisos, tipo_usuario } = c.req.valid('json')

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (authError) {
    console.error('[POST /usuarios] auth.admin.createUser failed:', authError.message)
    return c.json({ error: authError.message }, 500)
  }
  if (!authData.user) return c.json({ error: 'No se pudo crear el usuario' }, 500)

  const { data, error } = await supabase
    .from('profiles')
    .update({ nombre, rol, modulos, permisos: permisos ?? {}, tipo_usuario: tipo_usuario ?? null })
    .eq('id', authData.user.id)
    .select()
    .single()

  if (error) {
    console.error('[POST /usuarios] profile update failed for', authData.user.id, error.message)
    return c.json({ error: error.message }, 500)
  }

  return c.json(data, 201)
})

// ── PATCH /api/usuarios/:id — actualizar perfil ──
const UpdateSchema = z.object({
  nombre:       z.string().min(1).optional(),
  email:        z.string().email().optional(),
  rol:          z.enum(['admin', 'operador']).optional(),
  modulos:      z.array(z.string()).optional(),
  activo:       z.boolean().optional(),
  permisos:     PermisosSchema.optional(),
  tipo_usuario: z.string().nullable().optional(),
})

usuarios.patch('/:id', zValidator('json', UpdateSchema), async (c) => {
  const id  = c.req.param('id')
  const { email, ...profileDto } = c.req.valid('json')

  // Actualizar email en auth.users si se envía
  if (email) {
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email })
    if (authErr) return c.json({ error: authErr.message }, 500)
  }

  // Actualizar perfil solo si hay campos de perfil
  if (Object.keys(profileDto).length > 0) {
    const { data, error } = await supabase
      .from('profiles')
      .update(profileDto)
      .eq('id', id)
      .select()
      .single()
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ...data, email })
  }

  return c.json({ success: true })
})

// ── POST /api/usuarios/:id/reset-password — cambiar contraseña ──
const ResetPasswordSchema = z.object({
  password: z.string().min(6, 'Mínimo 6 caracteres'),
})

usuarios.post('/:id/reset-password', zValidator('json', ResetPasswordSchema), async (c) => {
  const id = c.req.param('id')
  const { password } = c.req.valid('json')

  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password })
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ success: true })
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

// ── GET /api/usuarios/:id/obras — obras asignadas al usuario ──
usuarios.get('/:id/obras', async (c) => {
  const id = c.req.param('id')
  const { data, error } = await supabase
    .from('usuario_obras')
    .select('obra_cod, obras(cod, nom, dir)')
    .eq('user_id', id)
    .order('obra_cod')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// ── PUT /api/usuarios/:id/obras — reemplaza el set de obras asignadas ──
// Body: { obras: ['cod1', 'cod2', ...] } (array vacío = quitar todas).
const UpdateObrasSchema = z.object({
  obras: z.array(z.string().min(1)),
})

usuarios.put('/:id/obras', zValidator('json', UpdateObrasSchema), async (c) => {
  const id = c.req.param('id')
  const { obras } = c.req.valid('json')
  const userId = c.get('user').id

  // Validar que el usuario destino exista.
  const { data: target, error: errProf } = await supabase
    .from('profiles').select('id, rol').eq('id', id).maybeSingle()
  if (errProf) return c.json({ error: errProf.message }, 500)
  if (!target) return c.json({ error: 'Usuario no existe' }, 404)

  // Validar que los códigos de obra existan (evitar FK errors confusos).
  if (obras.length > 0) {
    const { data: encontradas, error: errO } = await supabase
      .from('obras').select('cod').in('cod', obras)
    if (errO) return c.json({ error: errO.message }, 500)
    const set = new Set((encontradas ?? []).map(o => o.cod))
    const invalidas = obras.filter(c => !set.has(c))
    if (invalidas.length > 0) {
      return c.json({ error: 'OBRAS_INEXISTENTES', detail: invalidas }, 400)
    }
  }

  // Reemplazo atómico: borro las que ya no están + inserto las nuevas.
  const { error: errDel } = await supabase
    .from('usuario_obras').delete().eq('user_id', id)
  if (errDel) return c.json({ error: errDel.message }, 500)

  if (obras.length > 0) {
    const rows = obras.map(cod => ({ user_id: id, obra_cod: cod, created_by: userId }))
    const { error: errIns } = await supabase.from('usuario_obras').insert(rows)
    if (errIns) return c.json({ error: errIns.message }, 500)
  }

  // Refrescar cache para que los próximos requests del user vean los cambios.
  invalidarCacheObrasUsuario(id)

  return c.json({ success: true, count: obras.length })
})

export default usuarios