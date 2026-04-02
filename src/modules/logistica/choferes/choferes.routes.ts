import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { choferesService } from './choferes.service.js'
import { CreateChoferSchema, UpdateChoferSchema } from './choferes.schema.js'

const choferes = new Hono()
choferes.use('*', authMiddleware)

choferes.get('/', requirePermiso('logistica', 'lectura'), async (c) => {
  const data = await choferesService.getAll(c.get('accessToken'))
  return c.json(data)
})

choferes.post('/', requirePermiso('logistica', 'creacion'), zValidator('json', CreateChoferSchema), async (c) => {
  const data = await choferesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

choferes.patch('/:id', requirePermiso('logistica', 'actualizacion'), zValidator('json', UpdateChoferSchema), async (c) => {
  const id = Number(c.req.param('id'))
  const data = await choferesService.update(id, c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

choferes.delete('/:id', requirePermiso('logistica', 'eliminacion'), async (c) => {
  const id = Number(c.req.param('id'))
  const data = await choferesService.delete(id, c.get('accessToken'))
  return c.json(data)
})

export default choferes
