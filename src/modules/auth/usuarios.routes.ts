import { Hono } from 'hono'
import { z }    from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { supabase } from '../../lib/supabase.js'
import { invalidarCacheObrasUsuario } from '../../lib/obras-usuario.js'
import { ModuloSchema } from '../../lib/modulos.js'
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
// o se perderá silenciosamente al guardar.
// Whitelist de módulos: viene de la constante única en `lib/modulos.ts`.
// Si agregás un módulo nuevo, edita ese archivo y su gemelo en el frontend.
const ModuloKeySchema = ModuloSchema

const ModuloPermisosSchema = z.object({
  lectura:           z.boolean().optional(),
  creacion:          z.boolean().optional(),
  actualizacion:     z.boolean().optional(),
  eliminacion:       z.boolean().optional(),
  tabs:              z.array(z.string()).optional(),
  ver_costos:        z.boolean().optional(),
  ver_pii:           z.boolean().optional(),
  resolver_items:    z.boolean().optional(),
  forzar_despacho:   z.boolean().optional(),
  administrar_obras: z.boolean().optional(),
  // Alquiler: cargar/editar cobros sin ser admin (eliminar sigue admin-only).
  gestionar_cobros:  z.boolean().optional(),
  // Estos dos faltaban en el whitelist y el strip de zod los perdía en
  // silencio al guardar un usuario (2026-07-17): el gate de stock chequea
  // aprobar_ajustes_stock, y el wizard escribe obras_scope por módulo.
  aprobar_ajustes_stock: z.boolean().optional(),
  obras_scope:       z.enum(['todas', 'asignadas']).optional(),
})

// Validamos `permisos` como `z.record(ModuloKeySchema, ...)` PERO en zod v3
// el record con key enum no rechaza claves desconocidas — solo las tipa.
// Con superRefine forzamos que cada clave esté en la whitelist; las claves
// inválidas devuelven un error 400 al admin (en vez de pasar y polusionar
// el JSONB persistido en la DB).
const PermisosSchema = z
  .record(z.string(), ModuloPermisosSchema)
  .superRefine((obj, ctx) => {
    for (const k of Object.keys(obj)) {
      if (!ModuloKeySchema.safeParse(k).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [k],
          message: `Módulo desconocido: '${k}'. Esperado uno de ${ModuloKeySchema.options.join(', ')}.`,
        })
      }
    }
  })

const RolBaseSchema = z.enum([
  'administrativo', 'compras', 'deposito', 'jefe_obra', 'capataz',
]).nullable()
const ObrasScopeSchema = z.enum(['todas', 'asignadas'])

const CreateUsuarioSchema = z.object({
  email:        z.string().email(),
  password:     z.string().min(6, 'Mínimo 6 caracteres'),
  nombre:       z.string().min(1),
  rol:          z.enum(['admin', 'operador']),
  modulos:      z.array(z.string()),
  permisos:     PermisosSchema.optional(),
  tipo_usuario: z.string().nullable().optional(), // legacy
  rol_base:     RolBaseSchema.optional(),
  obras_scope:  ObrasScopeSchema.optional(),
})

usuarios.post('/', zValidator('json', CreateUsuarioSchema), async (c) => {
  const body = c.req.valid('json')

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
  })

  if (authError) {
    console.error('[POST /usuarios] auth.admin.createUser failed:', authError.message)
    return c.json({ error: authError.message }, 500)
  }
  if (!authData.user) return c.json({ error: 'No se pudo crear el usuario' }, 500)

  const updateData: any = {
    nombre:       body.nombre,
    rol:          body.rol,
    modulos:      body.modulos,
    permisos:     body.permisos ?? {},
    tipo_usuario: body.tipo_usuario ?? null,
  }
  if (body.rol_base !== undefined)    updateData.rol_base    = body.rol_base
  if (body.obras_scope !== undefined) updateData.obras_scope = body.obras_scope

  const { data, error } = await supabase
    .from('profiles')
    .update(updateData)
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
  tipo_usuario: z.string().nullable().optional(), // legacy
  rol_base:     RolBaseSchema.optional(),
  obras_scope:  ObrasScopeSchema.optional(),
})

// Cuenta admins activos. Se usa para evitar lockout total cuando el
// admin actual intenta auto-demote o demote del último admin restante.
async function countAdminsActivos(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('rol', 'admin')
    .eq('activo', true)
  if (error) throw new Error(error.message)
  return count ?? 0
}

usuarios.patch('/:id', zValidator('json', UpdateSchema), async (c) => {
  const id  = c.req.param('id')
  const { email, ...profileDto } = c.req.valid('json')
  const callerId = c.get('user').id

  // Lockout protection: si la operación pasa el rol de admin a operador
  // o desactiva un admin, verificamos que no sea el último. Sin esto un
  // admin puede dejar el sistema sin admins (auto-demote o desactivar
  // al único compañero) → nadie puede entrar al endpoint /api/usuarios/*
  // y se requiere intervención SQL directa para recuperar.
  if (profileDto.rol === 'operador' || profileDto.activo === false) {
    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('rol, activo')
      .eq('id', id)
      .maybeSingle()
    const eraAdminActivo = target?.rol === 'admin' && target?.activo === true
    const dejaDeSerAdminActivo =
      (profileDto.rol === 'operador' && eraAdminActivo) ||
      (profileDto.activo === false && eraAdminActivo)
    if (dejaDeSerAdminActivo) {
      const adminsActivos = await countAdminsActivos()
      if (adminsActivos <= 1) {
        return c.json({
          error: 'ULTIMO_ADMIN',
          detail: 'No podés bajar/desactivar al último admin activo del sistema. Promoví otro user a admin antes.',
        }, 400)
      }
    }
  }

  // Actualizar email en auth.users si se envía
  if (email) {
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email })
    if (authErr) return c.json({ error: authErr.message }, 500)
  }

  // Actualizar perfil solo si hay campos de perfil
  if (Object.keys(profileDto).length > 0) {
    // 1) Snapshot previo para audit. Capturamos también obras_scope y
    //    rol_base — son cambios "sensibles" en v2.
    const { data: before } = await supabase
      .from('profiles')
      .select('rol, modulos, permisos, tipo_usuario, rol_base, obras_scope')
      .eq('id', id)
      .maybeSingle()

    const { data, error } = await supabase
      .from('profiles')
      .update(profileDto)
      .eq('id', id)
      .select()
      .single()
    if (error) return c.json({ error: error.message }, 500)

    // 2) Si algún campo sensible cambió, loguear el diff.
    if (before) {
      const cambioSensible =
        before.rol !== data.rol ||
        JSON.stringify(before.modulos) !== JSON.stringify(data.modulos) ||
        JSON.stringify(before.permisos) !== JSON.stringify(data.permisos) ||
        before.tipo_usuario !== data.tipo_usuario ||
        before.rol_base    !== data.rol_base ||
        before.obras_scope !== data.obras_scope

      if (cambioSensible) {
        const { error: errAudit } = await supabase.from('profiles_permisos_history').insert({
          profile_id: id,
          changed_by: callerId,
          rol_old:          before.rol,
          rol_new:          data.rol,
          modulos_old:      before.modulos,
          modulos_new:      data.modulos,
          permisos_old:     before.permisos,
          permisos_new:     data.permisos,
          tipo_usuario_old: before.tipo_usuario,
          tipo_usuario_new: data.tipo_usuario,
          // Campos v2 — agregar columnas en migración aparte si no existen.
          rol_base_old:     before.rol_base ?? null,
          rol_base_new:     data.rol_base ?? null,
          obras_scope_old:  before.obras_scope ?? null,
          obras_scope_new:  data.obras_scope ?? null,
        })
        // Si el audit falla, NO abortamos la respuesta — el cambio ya se
        // persistió. Pero loggeamos para que quede rastro si algún día
        // se rompe la tabla de history.
        if (errAudit) {
          console.error('[usuarios.patch] audit history insert failed for', id, errAudit.message)
        }
      }
    }

    // Invalidar cache de obras del user en TODA actualización de perfil.
    invalidarCacheObrasUsuario(id)

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

  // Lockout protection: si el target es admin activo y es el último,
  // no permitir el delete. Sin esto, un admin puede eliminar al único
  // compañero admin → sistema sin admins en breve (cuando el caller
  // cierre sesión).
  const { data: target } = await supabaseAdmin
    .from('profiles')
    .select('rol, activo')
    .eq('id', id)
    .maybeSingle()
  if (target?.rol === 'admin' && target?.activo === true) {
    const adminsActivos = await countAdminsActivos()
    if (adminsActivos <= 1) {
      return c.json({
        error: 'ULTIMO_ADMIN',
        detail: 'No podés eliminar al último admin activo del sistema. Promoví otro user a admin antes.',
      }, 400)
    }
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ success: true })
})

// ── GET /api/usuarios/:id/obras — obras asignadas al usuario ──
//
// Devuelve TODAS las rows del usuario (cualquier módulo). El frontend
// agrupa por `modulo` para mostrar "obras de tarja", "obras de
// certificaciones", etc. Filas con `modulo=NULL` aplican a todos los
// módulos donde el perfil tenga `obras_scope='asignadas'`.
usuarios.get('/:id/obras', async (c) => {
  const id = c.req.param('id')
  const { data, error } = await supabase
    .from('usuario_obras')
    .select('obra_cod, modulo, obras(cod, nom, dir)')
    .eq('user_id', id)
    .order('modulo', { nullsFirst: true })
    .order('obra_cod')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// ── PUT /api/usuarios/:id/obras — reemplaza el set de obras asignadas ──
//
// Body opcional `modulo` (string | null). El reemplazo es POR MÓDULO:
//   - { obras: [...], modulo: 'tarja' }      → reemplaza solo las rows de tarja
//   - { obras: [...], modulo: null }         → reemplaza solo las rows globales (legacy)
//   - { obras: [...] } (sin modulo)          → modo legacy: borra TODAS las rows
//                                              del user e inserta las nuevas como modulo=null
const UpdateObrasSchema = z.object({
  obras:  z.array(z.string().min(1)),
  modulo: ModuloKeySchema.nullable().optional(),
})

usuarios.put('/:id/obras', zValidator('json', UpdateObrasSchema), async (c) => {
  const id = c.req.param('id')
  const { obras, modulo } = c.req.valid('json')
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

  // Reemplazo atómico, scoped al módulo si fue pasado.
  // Para `modulo === undefined` (legacy) borramos TODAS las rows del user
  // y reinsertamos como modulo=null (compat con clientes viejos).
  let del = supabase.from('usuario_obras').delete().eq('user_id', id)
  if (modulo !== undefined) {
    del = modulo === null
      ? del.is('modulo', null)
      : del.eq('modulo', modulo)
  }
  const { error: errDel } = await del
  if (errDel) return c.json({ error: errDel.message }, 500)

  if (obras.length > 0) {
    const moduloPersist = modulo === undefined ? null : modulo
    const rows = obras.map(cod => ({
      user_id:    id,
      obra_cod:   cod,
      created_by: userId,
      modulo:     moduloPersist,
    }))
    const { error: errIns } = await supabase.from('usuario_obras').insert(rows)
    if (errIns) return c.json({ error: errIns.message }, 500)
  }

  // Refrescar cache para que los próximos requests del user vean los cambios.
  invalidarCacheObrasUsuario(id)

  return c.json({ success: true, count: obras.length, modulo: modulo ?? null })
})

export default usuarios