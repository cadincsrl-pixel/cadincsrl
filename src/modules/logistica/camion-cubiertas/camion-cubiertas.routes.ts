import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { camionCubiertasService, CamionCubiertasError } from './camion-cubiertas.service.js'
import { CreateCubiertasSchema, UpdateCubiertasSchema } from './camion-cubiertas.schema.js'

const cubiertas = new Hono()

cubiertas.use('*', authMiddleware)
cubiertas.on(['GET'],          '*', requirePermiso('logistica', 'lectura'))
cubiertas.on(['POST'],         '*', requirePermiso('logistica', 'creacion'))
cubiertas.on(['PATCH', 'PUT'], '*', requirePermiso('logistica', 'actualizacion'))
cubiertas.on(['DELETE'],       '*', requirePermiso('logistica', 'eliminacion'))

function handle(err: unknown, c: Context) {
  if (err instanceof CamionCubiertasError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// GET /api/logistica/camion-cubiertas?camion_id=X
cubiertas.get('/', async (c) => {
  try {
    const camionId = c.req.query('camion_id')
    if (!camionId) return c.json({ error: 'camion_id es requerido' }, 400)
    return c.json(await camionCubiertasService.listByCamion(Number(camionId), c.get('accessToken')))
  } catch (err) { return handle(err, c) }
})

cubiertas.post('/', zValidator('json', CreateCubiertasSchema), async (c) => {
  try {
    const data = await camionCubiertasService.create(
      c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data, 201)
  } catch (err) { return handle(err, c) }
})

cubiertas.patch('/:id', zValidator('json', UpdateCubiertasSchema), async (c) => {
  try {
    const data = await camionCubiertasService.update(
      Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

cubiertas.delete('/:id', async (c) => {
  try {
    const data = await camionCubiertasService.softDelete(
      Number(c.req.param('id')), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

export default cubiertas
