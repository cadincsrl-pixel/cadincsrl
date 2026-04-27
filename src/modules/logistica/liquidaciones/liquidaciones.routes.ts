import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { liquidacionesService, LiqHttpError } from './liquidaciones.service.js'
import { CreateLiquidacionSchema, UpdateLiquidacionSchema, CreateAdelantoSchema, UpdateAdelantoSchema, UploadComprobanteAdelantoSchema } from './liquidaciones.schema.js'

const liquidaciones = new Hono()
liquidaciones.use('*', authMiddleware)
liquidaciones.on(['GET'],            '*', requirePermiso('logistica', 'lectura'))
liquidaciones.on(['POST'],           '*', requirePermiso('logistica', 'creacion'))
liquidaciones.on(['PATCH', 'PUT'],   '*', requirePermiso('logistica', 'actualizacion'))
liquidaciones.on(['DELETE'],         '*', requirePermiso('logistica', 'eliminacion'))

liquidaciones.get('/',          async (c) => c.json(await liquidacionesService.getAll(c.get('accessToken'))))
liquidaciones.get('/adelantos', async (c) => c.json(await liquidacionesService.getAdelantos(c.get('accessToken'))))

liquidaciones.post('/', zValidator('json', CreateLiquidacionSchema), async (c) => {
  try {
    const data = await liquidacionesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    // El RPC lanza TRAMO_INVALIDO / ADELANTO_INVALIDO / GASTO_INVALIDO cuando
    // los IDs no pertenecen al chofer o ya están liquidados. Mapeo a 400.
    const msg = err?.message ?? ''
    if (msg.includes('TRAMO_INVALIDO'))    return c.json({ error: 'TRAMO_INVALIDO',    detail: err.detail }, 400)
    if (msg.includes('ADELANTO_INVALIDO')) return c.json({ error: 'ADELANTO_INVALIDO', detail: err.detail }, 400)
    if (msg.includes('GASTO_INVALIDO'))    return c.json({ error: 'GASTO_INVALIDO',    detail: err.detail }, 400)
    return c.json({ error: msg || 'UNKNOWN' }, 500)
  }
})

liquidaciones.patch('/:id', zValidator('json', UpdateLiquidacionSchema), async (c) => {
  const data = await liquidacionesService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

liquidaciones.patch('/:id/cerrar', async (c) => {
  const data = await liquidacionesService.cerrar(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

liquidaciones.patch('/:id/reabrir', async (c) => {
  try {
    const data = await liquidacionesService.reabrir(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
    return c.json(data)
  } catch (err) {
    if (err instanceof LiqHttpError) {
      const body: Record<string, unknown> = { error: err.code }
      if (err.detail !== undefined) body.detail = err.detail
      return c.json(body, err.status as any)
    }
    throw err
  }
})

liquidaciones.delete('/:id', async (c) => {
  try {
    const data = await liquidacionesService.delete(Number(c.req.param('id')), c.get('accessToken'))
    return c.json(data)
  } catch (err) {
    if (err instanceof LiqHttpError) {
      const body: Record<string, unknown> = { error: err.code }
      if (err.detail !== undefined) body.detail = err.detail
      return c.json(body, err.status as any)
    }
    throw err
  }
})

function handleLiqError(err: unknown, c: any) {
  if (err instanceof LiqHttpError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

liquidaciones.post('/adelantos', zValidator('json', CreateAdelantoSchema), async (c) => {
  try {
    const data = await liquidacionesService.createAdelanto(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err) { return handleLiqError(err, c) }
})

liquidaciones.patch('/adelantos/:id', zValidator('json', UpdateAdelantoSchema), async (c) => {
  try {
    const data = await liquidacionesService.updateAdelanto(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data)
  } catch (err) { return handleLiqError(err, c) }
})

liquidaciones.delete('/adelantos/:id', async (c) => {
  try {
    const data = await liquidacionesService.deleteAdelanto(Number(c.req.param('id')), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handleLiqError(err, c) }
})

// Firmar URL de upload para comprobante de adelanto.
liquidaciones.post('/adelantos/upload-comprobante', zValidator('json', UploadComprobanteAdelantoSchema), async (c) => {
  try {
    const dto = c.req.valid('json')
    const data = await liquidacionesService.firmarUploadComprobanteAdelanto(dto.content_type)
    return c.json(data)
  } catch (err) { return handleLiqError(err, c) }
})

// Firmar URL de descarga para comprobante existente.
liquidaciones.get('/adelantos/:id/comprobante-url', async (c) => {
  try {
    const data = await liquidacionesService.getAdelantoComprobanteUrl(Number(c.req.param('id')), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handleLiqError(err, c) }
})

export default liquidaciones
