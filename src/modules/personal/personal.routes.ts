import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermisoOr, requireFlag } from '../../middleware/permission.js'
import { personalService } from './personal.service.js'
import { CreatePersonalSchema, UpdatePersonalSchema } from './personal.schema.js'
import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import documentosRoutes from './documentos.routes.js'

// Devuelve true si el user no admin tiene tarja.solo_carga_horas activo.
// Usado para limitar las columnas devueltas (capataz no debería ver
// DNI, dirección, teléfono, etc. — solo lo necesario para tarja).
async function esCapatazPuro(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('rol, permisos')
    .eq('id', userId)
    .maybeSingle()
  if (!data) return false
  if (data.rol === 'admin') return false
  return (data.permisos as any)?.tarja?.solo_carga_horas === true
}

const personal = new Hono()

personal.use('*', authMiddleware)

// Sub-router para documentos del legajo (DNI, alta temprana, baja, telegrama).
// Monta /:leg/documentos/... bajo /api/personal → rutas finales
// /api/personal/:leg/documentos, .../upload-url, .../:id/signed-url, .../:id.
personal.route('/', documentosRoutes)

// Filtra el universo de personal a aquellos legs que tienen al menos una
// asignación en una obra del usuario. Admin/usuario sin restricción ve todo.
async function filtrarLegsPermitidos(
  userId: string,
  token: string,
): Promise<string[] | null> {
  const allowed = await getObrasDelUsuarioCached(userId)
  if (allowed == null) return null // admin
  if (allowed.length === 0) return []

  const supabase = createSupabaseClient(token)
  const { data, error } = await supabase
    .from('asignaciones')
    .select('leg')
    .in('obra_cod', allowed)
  if (error) throw new Error(error.message)

  const legs = Array.from(new Set((data ?? []).map((r: { leg: string }) => r.leg)))
  return legs
}

personal.get(
  '/',
  requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]),
  async (c) => {
    const token = c.get('accessToken')
    const userId = c.get('user').id

    const legsPermitidos = await filtrarLegsPermitidos(userId, token)
    if (legsPermitidos != null && legsPermitidos.length === 0) return c.json([])

    const limitado = await esCapatazPuro(userId)

    if (legsPermitidos == null) {
      const data = await personalService.getAll(token, { limitado })
      return c.json(data)
    }

    const supabase = createSupabaseClient(token)
    const select = limitado
      ? 'leg, nom, condicion, activo_override, created_at, updated_at'
      : '*, personal_cat_historial (cat_id, desde)'
    const { data, error } = await supabase
      .from('personal')
      .select(select)
      .in('leg', legsPermitidos)
      .order('leg')
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data ?? [])
  },
)

personal.get(
  '/:leg',
  requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]),
  async (c) => {
    const leg = c.req.param('leg')
    const token = c.get('accessToken')
    const userId = c.get('user').id

    const legsPermitidos = await filtrarLegsPermitidos(userId, token)
    if (legsPermitidos != null && !legsPermitidos.includes(leg)) {
      throw new HTTPException(403, { message: 'NO_ACCESO_PERSONAL' })
    }

    const limitado = await esCapatazPuro(userId)
    const data = await personalService.getByLeg(leg, token, { limitado })
    return c.json(data)
  },
)

personal.post(
  '/',
  requirePermisoOr([{ modulo: 'personal', accion: 'creacion' }, { modulo: 'tarja', accion: 'creacion' }]),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', CreatePersonalSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await personalService.create(dto, token, userId)
    return c.json(data, 201)
  },
)

personal.patch(
  '/:leg',
  requirePermisoOr([{ modulo: 'personal', accion: 'actualizacion' }, { modulo: 'tarja', accion: 'actualizacion' }]),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', UpdatePersonalSchema),
  async (c) => {
    const leg = c.req.param('leg')
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await personalService.update(leg, dto, token, userId)
    return c.json(data)
  },
)

personal.delete(
  '/:leg',
  requirePermisoOr([{ modulo: 'personal', accion: 'eliminacion' }, { modulo: 'tarja', accion: 'eliminacion' }]),
  requireFlag('tarja', 'solo_carga_horas', false),
  async (c) => {
    const leg = c.req.param('leg')
    const token = c.get('accessToken')
    const data = await personalService.delete(leg, token)
    return c.json(data)
  },
)

export default personal
