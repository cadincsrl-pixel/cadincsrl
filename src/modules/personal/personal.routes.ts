import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermisoOr, requireFlag } from '../../middleware/permission.js'
import { personalService } from './personal.service.js'
import { CreatePersonalSchema, UpdatePersonalSchema } from './personal.schema.js'
import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, TIPOS_LEGACY_RESTRINGIDOS } from '../../lib/obras-usuario.js'
import documentosRoutes from './documentos.routes.js'

// Decide si el user debe ver columnas limitadas de personal (sin DNI,
// dirección, teléfono, fecha_nacimiento).
//
// Regla v3 (capacidad `permisos.tarja.ver_pii`):
// - admin → no limitado.
// - permisos.tarja.ver_pii === true → no limitado.
// - cualquier otro caso → limitado (PII redactada).
async function piiLimitada(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('rol, permisos')
    .eq('id', userId)
    .maybeSingle()
  if (!data) return false
  if (data.rol === 'admin') return false
  const tarja = (data.permisos as any)?.tarja
  if (!tarja) return false

  // v3: ver_pii es la fuente de verdad. Default false (sin la flag = no ve PII).
  return tarja.ver_pii !== true
}

const personal = new Hono()

personal.use('*', authMiddleware)

// Sub-router para documentos del legajo (DNI, alta temprana, baja, telegrama).
// Monta /:leg/documentos/... bajo /api/personal → rutas finales
// /api/personal/:leg/documentos, .../upload-url, .../:id/signed-url, .../:id.
personal.route('/', documentosRoutes)

// Roles base que limitan la visibilidad de personal a los legs asignados
// a sus obras. Coincide con los roles cuyo scope de obras es 'asignadas'
// por defecto y necesitan ver solo "su" personal.
const ROLES_BASE_PERSONAL_RESTRINGIDO = new Set(['capataz', 'jefe_obra'])

// Filtra el universo de personal a aquellos legs que tienen al menos una
// asignación en una obra del usuario. Solo aplica para roles "operativos"
// (capataz/jefe_obra). Administrativos / compras / depósito ven todo.
async function filtrarLegsPermitidos(
  userId: string,
  token: string,
): Promise<string[] | null> {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('rol, rol_base, tipo_usuario')
    .eq('id', userId)
    .maybeSingle()
  if (!profile) return null
  if (profile.rol === 'admin') return null

  // v2: si rol_base está seteado, decidimos por él.
  // Legacy fallback: usar tipo_usuario.
  const restringido = profile.rol_base
    ? ROLES_BASE_PERSONAL_RESTRINGIDO.has(profile.rol_base)
    : profile.tipo_usuario != null && TIPOS_LEGACY_RESTRINGIDOS.has(profile.tipo_usuario)

  if (!restringido) return null

  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed == null) return null
  if (allowed.length === 0) return []

  // Tomamos la UNIÓN de asignaciones + horas. Razón: muchas obras viejas
  // tienen carga directa desde la tarja (upsert sobre `horas`) sin haber
  // pasado nunca por la tabla `asignaciones`. Si filtramos solo por
  // asignaciones, un capataz nuevo asignado a una obra con histórico de
  // horas pero 0 asignaciones formales, no ve a nadie y la planilla
  // queda en blanco. Caso real (José/cc 24): 143 horas, 6 legs, 0
  // asignaciones → mostraba 0.
  // Usamos la RPC `legs_de_obras` que hace SELECT DISTINCT server-side.
  // La query previa con .from('horas').select('leg').in(...) caía en el hard
  // cap de PostgREST (1000 filas), incluso pasando .range(0, 99999) — el cap
  // lo aplica el servidor, no se puede bypassear desde el cliente. Caso real
  // 2026-05-20: Candela tenía 1705 filas en `horas` de sus obras, el cap
  // recortaba a 1000 → quedaban 5 legs invisibles (026, 070, 074, 080, 095).
  // La RPC devuelve ~45 legs únicos en vez de 1705 filas → lejos del cap.
  const supabase = createSupabaseClient(token)
  const { data, error } = await supabase
    .rpc('legs_de_obras', { p_obras: allowed })
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: { leg: string }) => r.leg)
}

personal.get(
  '/',
  requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]),
  async (c) => {
    const token = c.get('accessToken')
    const userId = c.get('user').id

    const legsPermitidos = await filtrarLegsPermitidos(userId, token)
    if (legsPermitidos != null && legsPermitidos.length === 0) return c.json([])

    const limitado = await piiLimitada(userId)

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

    const limitado = await piiLimitada(userId)
    const data = await personalService.getByLeg(leg, token, { limitado })
    return c.json(data)
  },
)

personal.post(
  '/',
  requirePermisoOr([{ modulo: 'personal', accion: 'creacion' }, { modulo: 'tarja', accion: 'creacion' }]),
  requireFlag('tarja', 'ver_pii', true),
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
  requireFlag('tarja', 'ver_pii', true),
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
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const leg = c.req.param('leg')
    const token = c.get('accessToken')
    const data = await personalService.delete(leg, token)
    return c.json(data)
  },
)

export default personal
