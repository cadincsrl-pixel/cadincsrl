import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { personalService } from './personal.service.js'
import { CreatePersonalSchema, UpdatePersonalSchema } from './personal.schema.js'

const personal = new Hono()

personal.use('*', authMiddleware)

personal.get('/', async (c) => {
  const token = c.get('accessToken')
  const data = await personalService.getAll(token)
  return c.json(data)
})

personal.get('/:leg', async (c) => {
  const leg = c.req.param('leg')
  const token = c.get('accessToken')
  const data = await personalService.getByLeg(leg, token)
  return c.json(data)
})

personal.post('/', zValidator('json', CreatePersonalSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await personalService.create(dto, token)
  return c.json(data, 201)
})

personal.patch('/:leg', zValidator('json', UpdatePersonalSchema), async (c) => {
  const leg = c.req.param('leg')
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await personalService.update(leg, dto, token)
  return c.json(data)
})

personal.delete('/:leg', async (c) => {
  const leg = c.req.param('leg')
  const token = c.get('accessToken')
  const data = await personalService.delete(leg, token)
  return c.json(data)
})

export default personal