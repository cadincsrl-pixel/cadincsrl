import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { cobrosService } from './cobros.service.js'
import { CreateCobroSchema } from './cobros.schema.js'
import adjuntosRoutes from './adjuntos.routes.js'

const cobros = new Hono()
cobros.use('*', authMiddleware)
cobros.on(['GET'],    '*', requirePermiso('logistica', 'lectura'))
cobros.on(['POST'],   '*', requirePermiso('logistica', 'creacion'))
cobros.on(['PATCH'],  '*', requirePermiso('logistica', 'actualizacion'))
cobros.on(['DELETE'], '*', requirePermiso('logistica', 'eliminacion'))

// Sub-router de adjuntos: /api/logistica/cobros/:id/adjuntos/...
cobros.route('/', adjuntosRoutes)

cobros.get('/', async (c) => {
  const data = await cobrosService.getAll(c.get('accessToken'))
  return c.json(data)
})

cobros.post('/', zValidator('json', CreateCobroSchema), async (c) => {
  try {
    const data = await cobrosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    if (err?.code === 'TRAMO_NO_EXISTE')    return c.json({ error: 'TRAMO_NO_EXISTE' }, 400)
    if (err?.code === 'TRAMO_OTRA_EMPRESA') return c.json({ error: 'TRAMO_OTRA_EMPRESA', detail: err.detail }, 400)
    if (err?.code === 'TRAMO_YA_COBRADO')   return c.json({ error: 'TRAMO_YA_COBRADO',   detail: err.detail }, 409)
    if (err?.code === 'EMPRESA_NO_EXISTE')  return c.json({ error: 'EMPRESA_NO_EXISTE' }, 400)
    if (err?.code === 'FALTA_FACTURA')      return c.json({ error: 'FALTA_FACTURA' }, 400)
    if (err?.code === 'FACTURA_UN_VIAJE')   return c.json({ error: 'FACTURA_UN_VIAJE' }, 400)
    throw err
  }
})

cobros.patch('/:id/cobrar', async (c) => {
  try {
    // Body opcional: { fecha_cobro: 'YYYY-MM-DD' } — se anota en obs.
    let fechaCobro: string | undefined
    try {
      const body = await c.req.json()
      if (typeof body?.fecha_cobro === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha_cobro)) {
        fechaCobro = body.fecha_cobro
      }
    } catch { /* sin body o no-JSON: se marca cobrado sin fecha */ }
    const data = await cobrosService.marcarCobrado(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id, fechaCobro)
    return c.json(data)
  } catch (err: any) {
    if (err?.code === 'FALTA_COMPROBANTE_PAGO') {
      return c.json({ error: 'FALTA_COMPROBANTE_PAGO' }, 400)
    }
    throw err
  }
})

cobros.patch('/:id/revertir', async (c) => {
  const data = await cobrosService.revertirCobrado(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

cobros.delete('/:id', async (c) => {
  try {
    const data = await cobrosService.delete(Number(c.req.param('id')), c.get('accessToken'))
    return c.json(data)
  } catch (err: any) {
    if (err?.code === 'COBRO_NO_EXISTE')  return c.json({ error: 'COBRO_NO_EXISTE' }, 404)
    if (err?.code === 'COBRO_YA_COBRADO') return c.json({ error: 'COBRO_YA_COBRADO' }, 409)
    throw err
  }
})

export default cobros
