import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { tramosService } from './tramos.service.js'
import { CreateTramoSchema, UpdateTramoSchema, RegistrarDescargaSchema } from './tramos.schema.js'
import relevoRoutes from './relevo.routes.js'
import { z } from 'zod'

const MoverSchema = z.object({ dir: z.enum(['up', 'down']) })

const tramos = new Hono()
tramos.use('*', authMiddleware)
tramos.on(['GET'],          '*', requirePermiso('logistica', 'lectura'))
tramos.on(['POST'],         '*', requirePermiso('logistica', 'creacion'))
tramos.on(['PATCH', 'PUT'], '*', requirePermiso('logistica', 'actualizacion'))
tramos.on(['DELETE'],       '*', requirePermiso('logistica', 'eliminacion'))

// Sub-router de relevos: /api/logistica/tramos/:id/relevo[/sugerencia]
tramos.route('/', relevoRoutes)

tramos.get('/', async (c) => {
  const data = await tramosService.getAll(c.get('accessToken'))
  return c.json(data)
})

tramos.post('/', zValidator('json', CreateTramoSchema), async (c) => {
  const data = await tramosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

tramos.patch('/:id', zValidator('json', UpdateTramoSchema), async (c) => {
  try {
    const data = await tramosService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data)
  } catch (err: any) {
    if (err.code === 'TRAMO_NO_EXISTE') return c.json({ error: err.code, message: err.message }, 404)
    if (err.code === 'TRAMO_LIQUIDADO') return c.json({ error: err.code, message: err.message }, 409)
    if (err.code === 'TRAMO_COBRADO')   return c.json({ error: err.code, message: err.message }, 409)
    return c.json({ error: err.message }, 500)
  }
})

tramos.post('/:id/descarga', zValidator('json', RegistrarDescargaSchema), async (c) => {
  try {
    const data = await tramosService.registrarDescarga(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data)
  } catch (err: any) {
    if (err.code === 'TRAMO_NO_EXISTE') return c.json({ error: err.code, message: err.message }, 404)
    if (err.code === 'TRAMO_LIQUIDADO') return c.json({ error: err.code, message: err.message }, 409)
    if (err.code === 'TRAMO_COBRADO')   return c.json({ error: err.code, message: err.message }, 409)
    return c.json({ error: err.message }, 500)
  }
})

// Revertir el registro de descarga. Mapea errores del service a status HTTP:
//   TRAMO_NO_EXISTE    → 404
//   TRAMO_SIN_DESCARGA → 400
//   TRAMO_LIQUIDADO    → 409
//   TRAMO_COBRADO      → 409
tramos.post('/:id/revertir-descarga', async (c) => {
  try {
    const data = await tramosService.revertirDescarga(
      Number(c.req.param('id')), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data)
  } catch (err: any) {
    if (err.code === 'TRAMO_NO_EXISTE')    return c.json({ error: err.code, message: err.message }, 404)
    if (err.code === 'TRAMO_SIN_DESCARGA') return c.json({ error: err.code, message: err.message }, 400)
    if (err.code === 'TRAMO_LIQUIDADO')    return c.json({ error: err.code, message: err.message }, 409)
    if (err.code === 'TRAMO_COBRADO')      return c.json({ error: err.code, message: err.message }, 409)
    return c.json({ error: err.message }, 500)
  }
})

tramos.post('/:id/mover', zValidator('json', MoverSchema), async (c) => {
  const { dir } = c.req.valid('json')
  try {
    const data = await tramosService.mover(
      Number(c.req.param('id')),
      dir,
      c.get('accessToken'),
      c.get('user').id,
    )
    return c.json(data)
  } catch (err) {
    const e = err as Error & { code?: string }
    switch (e.code) {
      case 'TRAMO_NO_EXISTE': return c.json({ error: e.code }, 404)
      case 'TRAMO_SIN_FECHA':
      case 'DIR_INVALIDA':    return c.json({ error: e.code }, 400)
      case 'SIN_PERMISO':     return c.json({ error: e.code }, 403)
      default:                return c.json({ error: e.message || 'UNKNOWN' }, 500)
    }
  }
})

tramos.delete('/:id', async (c) => {
  const data = await tramosService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default tramos
