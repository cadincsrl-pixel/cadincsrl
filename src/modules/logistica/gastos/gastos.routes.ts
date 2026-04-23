import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { gastosService, HttpError } from './gastos.service.js'
import {
  CreateGastoSchema, UpdateGastoSchema, RechazarGastoSchema,
  ListGastosQuerySchema, UploadComprobanteSchema,
} from './gastos.schema.js'

const gastos = new Hono()

gastos.use('*', authMiddleware)
gastos.on(['GET'],           '*', requirePermiso('logistica', 'lectura'))
gastos.on(['POST'],          '*', requirePermiso('logistica', 'creacion'))
gastos.on(['PATCH', 'PUT'],  '*', requirePermiso('logistica', 'actualizacion'))
gastos.on(['DELETE'],        '*', requirePermiso('logistica', 'eliminacion'))

// Wrapper de error → respeta HttpError con status/code/detail.
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err: any) {
      if (err instanceof HttpError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: err.message ?? 'UNKNOWN' }, 500)
    }
  }
}

// ── Catálogo de categorías ─────────────────────────────────────
gastos.get('/categorias', handler(async (c) => {
  return gastosService.listCategorias(c.get('accessToken'))
}))

// ── Upload/Download de comprobantes ────────────────────────────
gastos.post('/upload-comprobante',
  zValidator('json', UploadComprobanteSchema),
  handler(async (c) => {
    return gastosService.firmarUploadComprobante(c.req.valid('json'), c.get('user').id)
  }),
)

gastos.get('/:id/comprobante-url', handler(async (c) => {
  return gastosService.getComprobanteUrl(Number(c.req.param('id')), c.get('accessToken'))
}))

// ── Reintegros pendientes (usado por liquidaciones) ────────────
// IMPORTANTE: esta ruta debe ir ANTES de /:id para evitar que el
// segmento "reintegros-pendientes" sea capturado como parámetro id.
gastos.get('/reintegros-pendientes', handler(async (c) => {
  const chofer_id = Number(c.req.query('chofer_id'))
  if (!chofer_id) throw new HttpError(400, 'CHOFER_ID_REQUERIDO')
  const hasta = c.req.query('hasta') || undefined
  return gastosService.getReintegrosPendientes(chofer_id, hasta, c.get('accessToken'))
}))

// ── CRUD + workflow ────────────────────────────────────────────
gastos.get('/', zValidator('query', ListGastosQuerySchema), handler(async (c) => {
  return gastosService.list(c.req.valid('query'), c.get('accessToken'))
}))

gastos.get('/:id', handler(async (c) => {
  return gastosService.getById(Number(c.req.param('id')), c.get('accessToken'))
}))

gastos.post('/', zValidator('json', CreateGastoSchema), handler(async (c) => {
  return gastosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
}))

gastos.patch('/:id', zValidator('json', UpdateGastoSchema), handler(async (c) => {
  return gastosService.update(
    Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id,
  )
}))

gastos.delete('/:id', handler(async (c) => {
  return gastosService.softDelete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
}))

gastos.post('/:id/aprobar', handler(async (c) => {
  return gastosService.aprobar(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
}))

gastos.post('/:id/rechazar',
  zValidator('json', RechazarGastoSchema),
  handler(async (c) => {
    return gastosService.rechazar(
      Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
  }),
)

export default gastos
