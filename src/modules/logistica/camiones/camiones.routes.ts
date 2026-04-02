import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { camionesService } from './camiones.service.js'
import { CreateCamionSchema, UpdateCamionSchema } from './camiones.schema.js'

const camiones = new Hono()
camiones.use('*', authMiddleware)

camiones.get('/', requirePermiso('logistica', 'lectura'), async (c) => {
  const data = await camionesService.getAll(c.get('accessToken'))
  return c.json(data)
})

camiones.post('/', requirePermiso('logistica', 'creacion'), zValidator('json', CreateCamionSchema), async (c) => {
  const data = await camionesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

camiones.patch('/:id', requirePermiso('logistica', 'actualizacion'), zValidator('json', UpdateCamionSchema), async (c) => {
  const id = Number(c.req.param('id'))
  const data = await camionesService.update(id, c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

camiones.delete('/:id', requirePermiso('logistica', 'eliminacion'), async (c) => {
  const id = Number(c.req.param('id'))
  const data = await camionesService.delete(id, c.get('accessToken'))
  return c.json(data)
})

export default camiones
