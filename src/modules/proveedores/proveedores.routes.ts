import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { proveedoresService } from './proveedores.service.js'
import { CreateProveedorSchema, UpdateProveedorSchema } from './proveedores.schema.js'

const proveedores = new Hono()
proveedores.use('*', authMiddleware)
proveedores.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
proveedores.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
proveedores.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
proveedores.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

proveedores.get('/', async (c) => {
  return c.json(await proveedoresService.getAll(c.get('accessToken')))
})

proveedores.post('/', zValidator('json', CreateProveedorSchema), async (c) => {
  const data = await proveedoresService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

proveedores.patch('/:id', zValidator('json', UpdateProveedorSchema), async (c) => {
  const data = await proveedoresService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

proveedores.delete('/:id', async (c) => {
  return c.json(await proveedoresService.delete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

export default proveedores
