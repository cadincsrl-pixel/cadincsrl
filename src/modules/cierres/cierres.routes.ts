import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { cierresService } from './cierres.service.js'
import { CreateCierreSchema, UpdateCierreSchema } from './cierres.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const cierres = new Hono()

cierres.use('*', authMiddleware)

cierres.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  const userId = c.get('user').id
  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed != null && allowed.length === 0) return c.json([])

  const supabase = createSupabaseClient(c.get('accessToken'))
  let q = supabase.from('cierres').select('*')
  if (allowed != null) q = q.in('obra_cod', allowed)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// GET /api/cierres/:obraCod
cierres.get('/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')
  const data = await cierresService.getByObra(obraCod, token)
  return c.json(data)
})

// GET /api/cierres/:obraCod/:semKey
cierres.get('/:obraCod/:semKey', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const semKey = c.req.param('semKey')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')
  const data = await cierresService.getBySemKey(obraCod, semKey, token)
  return c.json(data)
})

// POST /api/cierres — cierre/apertura de semana: acción de jefatura, capataz no.
cierres.post(
  '/',
  requirePermiso('tarja', 'creacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', CreateCierreSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
    const data = await cierresService.create(dto, token, userId)
    return c.json(data, 201)
  },
)

// PATCH /api/cierres/:obraCod/:semKey — reabrir/cerrar: jefatura.
cierres.patch(
  '/:obraCod/:semKey',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', UpdateCierreSchema),
  async (c) => {
    const obraCod = c.req.param('obraCod')
    const semKey = c.req.param('semKey')
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, obraCod, 'tarja')
    const data = await cierresService.updateEstado(obraCod, semKey, dto, token, userId)
    return c.json(data)
  },
)

export default cierres
