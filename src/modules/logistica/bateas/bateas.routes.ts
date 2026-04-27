import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { bateasService } from './bateas.service.js'
import { CreateBateaSchema, UpdateBateaSchema } from './bateas.schema.js'
import { buildVehiculoDocsRoutes } from './vehiculo-docs.routes.js'

const bateas = new Hono()
bateas.use('*', authMiddleware)

// Sub-router de documentos: /api/logistica/bateas/:id/documentos/...
bateas.route('/', buildVehiculoDocsRoutes('batea'))

bateas.get('/', requirePermiso('logistica', 'lectura'), async (c) => {
  return c.json(await bateasService.getAll(c.get('accessToken')))
})

bateas.post('/', requirePermiso('logistica', 'creacion'), zValidator('json', CreateBateaSchema), async (c) => {
  const data = await bateasService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

bateas.patch('/:id', requirePermiso('logistica', 'actualizacion'), zValidator('json', UpdateBateaSchema), async (c) => {
  const data = await bateasService.update(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data)
})

bateas.delete('/:id', requirePermiso('logistica', 'eliminacion'), async (c) => {
  return c.json(await bateasService.delete(Number(c.req.param('id')), c.get('accessToken')))
})

export default bateas
