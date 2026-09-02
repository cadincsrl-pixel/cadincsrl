import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso, tieneFlag } from '../../../middleware/permission.js'
import { cobrosService } from './cobros.service.js'
import { CreateCobroSchema, ContraFacturaSchema } from './cobros.schema.js'
import adjuntosRoutes from './adjuntos.routes.js'

const cobros = new Hono()
cobros.use('*', authMiddleware)
cobros.on(['GET'],    '*', requirePermiso('logistica', 'lectura'))
cobros.on(['POST'],   '*', requirePermiso('logistica', 'creacion'))
cobros.on(['PATCH'],  '*', requirePermiso('logistica', 'actualizacion'))
// DELETE: eliminación del módulo O flag fino `anular_cobros` — permite
// borrar cobros pendientes (y sus adjuntos) sin abrirle a la persona la
// eliminación de TODO logística (tramos, gastos, etc.). Patrón gestionar_docs.
// El service igual bloquea borrar cobros ya cobrados (COBRO_YA_COBRADO).
cobros.on(['DELETE'], '*', async (c, next) => {
  if (await tieneFlag(c.get('user').id, 'logistica', 'anular_cobros')) return next()
  return requirePermiso('logistica', 'eliminacion')(c, next)
})

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
    if (err?.code === 'FACTURA_SIN_VIAJES') return c.json({ error: 'FACTURA_SIN_VIAJES' }, 400)
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

// Contra factura del intermediario: nº + fecha del documento y la comisión de
// cada viaje de la factura. Permiso `logistica.actualizacion` — ya lo aplica el
// `cobros.on(['PATCH'], '*', ...)` de arriba (no se repite acá para no pegarle
// dos veces a `profiles` por request).
// A propósito NO valida el estado del cobro: la contra factura llega después
// de la factura, incluso con la plata ya cobrada.
cobros.patch('/:id/contra-factura', zValidator('json', ContraFacturaSchema), async (c) => {
  try {
    const data = await cobrosService.actualizarContraFactura(
      Number(c.req.param('id')),
      c.req.valid('json'),
      c.get('accessToken'),
      c.get('user').id,
    )
    return c.json(data)
  } catch (err: any) {
    const body = (status: number) =>
      c.json({ error: err.message, code: err.code, ...(err.detail !== undefined ? { detail: err.detail } : {}) }, status as any)
    if (err?.code === 'COBRO_NO_EXISTE')            return body(404)
    if (err?.code === 'EMPRESA_NO_EXISTE')          return body(404)
    if (err?.code === 'EMPRESA_SIN_CONTRA_FACTURA') return body(409)
    if (err?.code === 'TRAMO_NO_ES_DEL_COBRO')      return body(400)
    if (err?.code === 'COMISION_MAYOR_QUE_VIAJE')   return body(400)
    throw err
  }
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
