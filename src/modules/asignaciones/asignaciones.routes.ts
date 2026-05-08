import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { asignacionesService } from './asignaciones.service.js'
import {
  CreateAsignacionSchema,
  BajaAsignacionSchema,
} from './asignaciones.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const asignaciones = new Hono()

asignaciones.use('*', authMiddleware)

asignaciones.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const allowed = await getObrasDelUsuarioCached(userId)
  if (allowed != null && allowed.length === 0) return c.json([])

  const supabase = createSupabaseClient(token)
  let q = supabase
    .from('asignaciones')
    .select('*')
  if (allowed != null) q = q.in('obra_cod', allowed)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// GET /api/asignaciones/:obraCod
asignaciones.get('/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod)
  const data = await asignacionesService.getByObra(obraCod, token)
  return c.json(data)
})

// POST /api/asignaciones
asignaciones.post('/', requirePermiso('tarja', 'creacion'), zValidator('json', CreateAsignacionSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod)
  const data = await asignacionesService.create(dto, token, userId)
  return c.json(data, 201)
})

// PATCH /api/asignaciones/:obraCod/:leg/baja
asignaciones.patch('/:obraCod/:leg/baja', requirePermiso('tarja', 'actualizacion'), zValidator('json', BajaAsignacionSchema), async (c) => {
  const obraCod = c.req.param('obraCod')
  const leg = c.req.param('leg')
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod)
  const data = await asignacionesService.baja(obraCod, leg, dto, token, userId)
  return c.json(data)
})

// DELETE /api/asignaciones/:obraCod/:leg
asignaciones.delete('/:obraCod/:leg', requirePermiso('tarja', 'eliminacion'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const leg = c.req.param('leg')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod)
  const data = await asignacionesService.delete(obraCod, leg, token)
  return c.json(data)
})

export default asignaciones
