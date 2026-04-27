import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { cobrosService } from './cobros.service.js'
import { CreateCobroSchema } from './cobros.schema.js'
import adjuntosRoutes from './adjuntos.routes.js'

const cobros = new Hono()
cobros.use('*', authMiddleware)
cobros.on(['GET'],           '*', requirePermiso('logistica', 'lectura'))
cobros.on(['POST', 'PATCH'], '*', requirePermiso('logistica', 'actualizacion'))
cobros.on(['DELETE'],        '*', requirePermiso('logistica', 'eliminacion'))

// Sub-router de adjuntos: /api/logistica/cobros/:id/adjuntos/...
cobros.route('/', adjuntosRoutes)

cobros.get('/', async (c) => {
  const data = await cobrosService.getAll(c.get('accessToken'))
  return c.json(data)
})

cobros.post('/', zValidator('json', CreateCobroSchema), async (c) => {
  const data = await cobrosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

cobros.patch('/:id/cobrar', async (c) => {
  const data = await cobrosService.marcarCobrado(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

cobros.delete('/:id', async (c) => {
  const data = await cobrosService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default cobros
