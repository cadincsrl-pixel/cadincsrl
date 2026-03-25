import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { choferesService } from './choferes.service.js'
import { CreateChoferSchema, UpdateChoferSchema } from './choferes.schema.js'

const choferes = new Hono()
choferes.use('*', authMiddleware)

choferes.get('/', async (c) => {
  const data = await choferesService.getAll(c.get('accessToken'))
  return c.json(data)
})

choferes.post('/', zValidator('json', CreateChoferSchema), async (c) => {
  const data = await choferesService.create(c.req.valid('json'), c.get('accessToken'))
  return c.json(data, 201)
})

choferes.patch('/:id', zValidator('json', UpdateChoferSchema), async (c) => {
  const id = Number(c.req.param('id'))
  const data = await choferesService.update(id, c.req.valid('json'), c.get('accessToken'))
  return c.json(data)
})

choferes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const data = await choferesService.delete(id, c.get('accessToken'))
  return c.json(data)
})

export default choferes