import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { camionServicesService, CamionServiceError } from './camion-services.service.js'
import {
  CreateServiceSchema, UpdateServiceSchema, UploadComprobanteSchema,
} from './camion-services.schema.js'

const services = new Hono()

services.use('*', authMiddleware)
services.on(['GET'],            '*', requirePermiso('logistica', 'lectura'))
services.on(['POST'],           '*', requirePermiso('logistica', 'creacion'))
services.on(['PATCH', 'PUT'],   '*', requirePermiso('logistica', 'actualizacion'))
services.on(['DELETE'],         '*', requirePermiso('logistica', 'eliminacion'))

function handle(err: unknown, c: any) {
  if (err instanceof CamionServiceError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// GET /api/logistica/camion-services/estado — vista para listado / notif
services.get('/estado', async (c) => {
  try {
    const data = await camionServicesService.getEstadoTodos(c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// GET /api/logistica/camion-services?camion_id=X — histórico por camión
services.get('/', async (c) => {
  try {
    const camionIdParam = c.req.query('camion_id')
    if (!camionIdParam) return c.json({ error: 'camion_id es requerido' }, 400)
    const data = await camionServicesService.listByCamion(Number(camionIdParam), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// POST /api/logistica/camion-services/upload-comprobante
services.post('/upload-comprobante', zValidator('json', UploadComprobanteSchema), async (c) => {
  try {
    const dto = c.req.valid('json')
    const data = await camionServicesService.firmarUploadComprobante(dto.camion_id, dto.content_type)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// POST /api/logistica/camion-services
services.post('/', zValidator('json', CreateServiceSchema), async (c) => {
  try {
    const data = await camionServicesService.create(
      c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data, 201)
  } catch (err) { return handle(err, c) }
})

// PATCH /api/logistica/camion-services/:id
services.patch('/:id', zValidator('json', UpdateServiceSchema), async (c) => {
  try {
    const data = await camionServicesService.update(
      Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// DELETE /api/logistica/camion-services/:id (soft delete)
services.delete('/:id', async (c) => {
  try {
    const data = await camionServicesService.softDelete(
      Number(c.req.param('id')), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// GET /api/logistica/camion-services/:id/comprobante-url
services.get('/:id/comprobante-url', async (c) => {
  try {
    const data = await camionServicesService.getComprobanteUrl(
      Number(c.req.param('id')), c.get('accessToken'),
    )
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

export default services
