import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermisoOr, requireFlag } from '../../middleware/permission.js'
import { obrasService } from './obras.service.js'
import { CreateObraSchema, UpdateObraSchema } from './obras.schema.js'
import { validarObraDelUsuario } from '../../lib/obras-usuario.js'
import { supabase as supabaseAdmin } from '../../lib/supabase.js'

const obras = new Hono()

obras.use('*', authMiddleware)

// GET /api/obras?modulo=tarja
//
// Lectura accesible desde tarja o certificaciones (los jefes de obra
// solo tienen certificaciones y necesitan ver SUS obras al pedir
// materiales).
//
// Query param opcional `modulo`: cuando se pasa, respeta el override
// `permisos.<modulo>.obras_scope` del perfil. Sin parámetro se usa el
// scope global. Caso típico: Cristian Sosa tiene scope global='todas'
// pero override en tarja='asignadas' → la página de tarja debe pasar
// `?modulo=tarja` para ver solo la obra depósito.
obras.get('/', requirePermisoOr([
  { modulo: 'tarja', accion: 'lectura' },
  { modulo: 'certificaciones', accion: 'lectura' },
]), async (c) => {
  const token  = c.get('accessToken')
  const userId = c.get('user').id
  const modulo = c.req.query('modulo') || undefined
  const data = await obrasService.getAll(token, userId, modulo)
  return c.json(data)
})

// GET /api/obras/archivadas?modulo=tarja
obras.get('/archivadas', requirePermisoOr([
  { modulo: 'tarja', accion: 'lectura' },
  { modulo: 'certificaciones', accion: 'lectura' },
]), async (c) => {
  const token  = c.get('accessToken')
  const userId = c.get('user').id
  const modulo = c.req.query('modulo') || undefined
  const data = await obrasService.getArchivadas(token, userId, modulo)
  return c.json(data)
})

// GET /api/obras/proximo-codigo
//
// Devuelve el próximo código que se va a usar al crear una obra.
// NO consume la sequence — es solo preview para el modal "Nueva obra".
// Si dos admins abren el modal a la vez, ambos ven el mismo preview;
// al hacer submit, el primero se queda con ese número y el segundo
// recibe el siguiente. La RPC interna garantiza unicidad.
obras.get('/proximo-codigo', requireFlag('tarja', 'administrar_obras', true), async (c) => {
  const cod = await obrasService.proximoCodigoPreview()
  return c.json({ cod })
})

// GET /api/obras/responsables-disponibles
//
// Lista users con login activos para asignar como responsables de obra.
// Devuelve `{ capataces: [{id, nombre}], jefes_obra: [{id, nombre}] }`.
//
// Accesible para users con `tarja.actualizacion` o `tarja.creacion`
// (los que pueden editar obras), no requiere admin. Devuelve solo
// nombre + id, sin email u otros datos sensibles, así que no abre
// PII vía este endpoint.
obras.get('/responsables-disponibles', requireFlag('tarja', 'administrar_obras', true), async (c) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, nombre, rol_base')
    .eq('activo', true)
    .in('rol_base', ['capataz', 'jefe_obra'])
    .order('nombre')
  if (error) return c.json({ error: error.message }, 500)
  type Row = { id: string; nombre: string; rol_base: string }
  const rows = (data ?? []) as Row[]
  return c.json({
    capataces:   rows.filter(r => r.rol_base === 'capataz')  .map(r => ({ id: r.id, nombre: r.nombre })),
    jefes_obra:  rows.filter(r => r.rol_base === 'jefe_obra').map(r => ({ id: r.id, nombre: r.nombre })),
  })
})

// GET /api/obras/:cod?modulo=tarja
obras.get('/:cod', requirePermisoOr([
  { modulo: 'tarja', accion: 'lectura' },
  { modulo: 'certificaciones', accion: 'lectura' },
]), async (c) => {
  const cod    = c.req.param('cod')
  const token  = c.get('accessToken')
  const userId = c.get('user').id
  const modulo = c.req.query('modulo') || undefined
  try {
    const data = await obrasService.getByCod(cod, token, userId, modulo)
    return c.json(data)
  } catch (err: unknown) {
    const e = err as { code?: string }
    if (e?.code === 'OBRA_SIN_ACCESO') return c.json({ error: e.code }, 403)
    throw err
  }
})

// Helper: ¿el caller puede asignar responsables (capataz_user_id /
// jefe_obra_user_id)? Solo admin o rol_base='administrativo'. El resto
// (capataces, jefes operativos) puede crear/editar obras pero NO mutar
// quién es responsable — eso es decisión de jefatura.
async function puedeGestionarResponsables(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('rol, rol_base')
    .eq('id', userId)
    .maybeSingle()
  return data?.rol === 'admin' || data?.rol_base === 'administrativo'
}

// POST /api/obras — alta de obra: jefatura.
obras.post(
  '/',
  requireFlag('tarja', 'administrar_obras', true),
  zValidator('json', CreateObraSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id

    // Hardening: si el caller no puede gestionar responsables, ignoramos
    // los user_id del body. Evita que un user con tarja.creacion (sin
    // ser admin/administrativo) se autoasigne o asigne a un colega.
    if (!(await puedeGestionarResponsables(userId))) {
      dto.capataz_user_id   = null
      dto.jefe_obra_user_id = null
    }

    const data = await obrasService.create(dto, token, userId)
    return c.json(data, 201)
  },
)

// PATCH /api/obras/:cod — edición de obra: jefatura.
obras.patch(
  '/:cod',
  requireFlag('tarja', 'administrar_obras', true),
  zValidator('json', UpdateObraSchema),
  async (c) => {
    const cod = c.req.param('cod')
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id

    // Validar acceso a la obra antes de editar.
    try {
      await obrasService.getByCod(cod, token, userId)
    } catch (err: any) {
      if (err?.code === 'OBRA_SIN_ACCESO') return c.json({ error: err.code }, 403)
      throw err
    }

    // Hardening: si el caller no puede gestionar responsables, dropeamos
    // los user_id del patch antes de pasarlo al service.
    if (!(await puedeGestionarResponsables(userId))) {
      delete dto.capataz_user_id
      delete dto.jefe_obra_user_id
    }

    const data = await obrasService.update(cod, dto, token, userId)
    return c.json(data)
  },
)

// PATCH /api/obras/:cod/archivar — jefatura.
obras.patch(
  '/:cod/archivar',
  requireFlag('tarja', 'administrar_obras', true),
  async (c) => {
    const cod = c.req.param('cod')
    const token = c.get('accessToken')
    const userId = c.get('user').id

    try {
      await obrasService.getByCod(cod, token, userId)
    } catch (err: any) {
      if (err?.code === 'OBRA_SIN_ACCESO') return c.json({ error: err.code }, 403)
      throw err
    }

    const data = await obrasService.archivar(cod, token, userId)
    return c.json(data)
  },
)

// PATCH /api/obras/:cod/desarchivar — jefatura.
obras.patch(
  '/:cod/desarchivar',
  requireFlag('tarja', 'administrar_obras', true),
  async (c) => {
    const cod = c.req.param('cod')
    const token = c.get('accessToken')
    const userId = c.get('user').id

    // Para desarchivar no podemos usar getByCod (filtra archivada=false),
    // así que validamos directamente con el helper de obras-usuario.
    try {
      await validarObraDelUsuario(userId, cod)
    } catch (err: any) {
      // HTTPException con message 'OBRA_SIN_ACCESO'
      if (err?.message === 'OBRA_SIN_ACCESO') return c.json({ error: err.message }, 403)
      throw err
    }

    const data = await obrasService.desarchivar(cod, token, userId)
    return c.json(data)
  },
)

// DELETE /api/obras/:cod — jefatura.
obras.delete(
  '/:cod',
  requireFlag('tarja', 'administrar_obras', true),
  async (c) => {
    const cod = c.req.param('cod')
    const token = c.get('accessToken')
    const userId = c.get('user').id

    try {
      await validarObraDelUsuario(userId, cod)
    } catch (err: any) {
      if (err?.message === 'OBRA_SIN_ACCESO') return c.json({ error: err.message }, 403)
      throw err
    }

    const data = await obrasService.delete(cod, token)
    return c.json(data)
  },
)

export default obras
