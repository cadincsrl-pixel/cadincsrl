import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { tramosService } from './tramos.service.js'
import { CreateTramoSchema, UpdateTramoSchema } from './tramos.schema.js'

const tramos = new Hono()
tramos.use('*', authMiddleware)
tramos.on(['GET'],            '*', requirePermiso('logistica', 'lectura'))
tramos.on(['POST'],           '*', requirePermiso('logistica', 'creacion'))
tramos.on(['PATCH', 'PUT'],   '*', requirePermiso('logistica', 'actualizacion'))
tramos.on(['DELETE'],         '*', requirePermiso('logistica', 'eliminacion'))

tramos.get('/', async (c) => {
  const data = await tramosService.getAll(c.get('accessToken'))
  return c.json(data)
})

tramos.post('/', zValidator('json', CreateTramoSchema), async (c) => {
  const data = await tramosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

tramos.patch('/:id', zValidator('json', UpdateTramoSchema), async (c) => {
  const data = await tramosService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

tramos.delete('/:id', async (c) => {
  const data = await tramosService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default tramos
