import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { facturasCompraService } from './facturas-compra.service.js'
import { CreateFacturaSchema, UpdateFacturaSchema } from './facturas-compra.schema.js'

const facturas = new Hono()
facturas.use('*', authMiddleware)
facturas.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
facturas.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
facturas.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
facturas.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

facturas.get('/', async (c) => {
  const proveedor_id = c.req.query('proveedor_id')
  return c.json(await facturasCompraService.getAll(c.get('accessToken'), proveedor_id ? Number(proveedor_id) : undefined))
})

facturas.post('/', zValidator('json', CreateFacturaSchema), async (c) => {
  const data = await facturasCompraService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

facturas.patch('/:id', zValidator('json', UpdateFacturaSchema), async (c) => {
  const data = await facturasCompraService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

facturas.delete('/:id', async (c) => {
  return c.json(await facturasCompraService.delete(Number(c.req.param('id')), c.get('accessToken')))
})

export default facturas
