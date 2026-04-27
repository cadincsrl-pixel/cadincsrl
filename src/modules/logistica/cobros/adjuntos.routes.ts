import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { cobroAdjuntosService, CobroAdjError } from './adjuntos.service.js'

const docs = new Hono()
docs.use('*', authMiddleware)

const TipoEnum = z.enum(['liquidacion', 'comprobante'])

const UploadUrlSchema = z.object({
  tipo:           TipoEnum,
  nombre_archivo: z.string().min(1).max(255),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

const RegistrarSchema = z.object({
  tipo:           TipoEnum,
  storage_path:   z.string().min(1),
  nombre_archivo: z.string().min(1).max(255),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
  obs:            z.string().max(500).optional(),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof CobroAdjError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

docs.get(
  '/:id/adjuntos',
  requirePermiso('logistica', 'lectura'),
  handle(c => cobroAdjuntosService.listByCobro(Number(c.req.param('id')), c.get('accessToken'))),
)

docs.post(
  '/:id/adjuntos/upload-url',
  requirePermiso('logistica', 'creacion'),
  zValidator('json', UploadUrlSchema),
  handle(c => cobroAdjuntosService.generarUploadUrl(Number(c.req.param('id')), c.req.valid('json'))),
)

docs.post(
  '/:id/adjuntos',
  requirePermiso('logistica', 'creacion'),
  zValidator('json', RegistrarSchema),
  handle(c => cobroAdjuntosService.registrar(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

docs.get(
  '/:id/adjuntos/:adjId/signed-url',
  requirePermiso('logistica', 'lectura'),
  handle(c => cobroAdjuntosService.signedUrl(
    Number(c.req.param('id')),
    Number(c.req.param('adjId')),
    c.get('accessToken'),
  )),
)

docs.delete(
  '/:id/adjuntos/:adjId',
  requirePermiso('logistica', 'eliminacion'),
  handle(c => cobroAdjuntosService.softDelete(
    Number(c.req.param('id')),
    Number(c.req.param('adjId')),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

export default docs
