import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { choferesService } from './choferes.service.js'
import { CreateChoferSchema, UpdateChoferSchema, TraspasoChoferSchema } from './choferes.schema.js'
import documentosRoutes from './documentos.routes.js'

const choferes = new Hono()
choferes.use('*', authMiddleware)

// Sub-router de documentos del legajo (DNI, licencia, alta temprana, etc.).
// Monta /:id/documentos/... → /api/logistica/choferes/:id/documentos
choferes.route('/', documentosRoutes)

choferes.get('/', requirePermiso('logistica', 'lectura'), async (c) => {
  const data = await choferesService.getAll(c.get('accessToken'))
  return c.json(data)
})

choferes.post('/', requirePermiso('logistica', 'creacion'), zValidator('json', CreateChoferSchema), async (c) => {
  const data = await choferesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

// Traspaso de camión/batea entre choferes (un solo paso, con opción de swap).
choferes.post('/traspaso', requirePermiso('logistica', 'actualizacion'), zValidator('json', TraspasoChoferSchema), async (c) => {
  const data = await choferesService.traspaso(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
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
