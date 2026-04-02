import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { cierresService } from './cierres.service.js'
import { CreateCierreSchema, UpdateCierreSchema } from './cierres.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'

const cierres = new Hono()

cierres.use('*', authMiddleware)

cierres.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  const supabase = createSupabaseClient(c.get('accessToken'))
  const { data, error } = await supabase.from('cierres').select('*')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// GET /api/cierres/:obraCod
cierres.get('/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const data = await cierresService.getByObra(obraCod, token)
  return c.json(data)
})

// GET /api/cierres/:obraCod/:semKey
cierres.get('/:obraCod/:semKey', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const semKey = c.req.param('semKey')
  const token = c.get('accessToken')
  const data = await cierresService.getBySemKey(obraCod, semKey, token)
  return c.json(data)
})

// POST /api/cierres
cierres.post('/', requirePermiso('tarja', 'creacion'), zValidator('json', CreateCierreSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await cierresService.create(dto, token, userId)
  return c.json(data, 201)
})

// PATCH /api/cierres/:obraCod/:semKey
cierres.patch('/:obraCod/:semKey', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpdateCierreSchema), async (c) => {
  const obraCod = c.req.param('obraCod')
  const semKey = c.req.param('semKey')
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await cierresService.updateEstado(obraCod, semKey, dto, token, userId)
  return c.json(data)
})

export default cierres
