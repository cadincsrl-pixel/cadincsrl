/**
 * Routes de documentos para vehículos de flota. Se monta bajo
 * /api/flota/vehiculos como sub-router: las URLs efectivas quedan
 *   GET  /api/flota/vehiculos/:id/documentos
 *   POST /api/flota/vehiculos/:id/documentos/upload-url
 *   POST /api/flota/vehiculos/:id/documentos
 *   PATCH /api/flota/vehiculos/:id/documentos/:docId
 *   GET  /api/flota/vehiculos/:id/documentos/:docId/signed-url
 *   DELETE /api/flota/vehiculos/:id/documentos/:docId
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { flotaDocsService, FlotaDocError } from './flota-docs.service.js'

const TipoEnum = z.enum([
  'titulo', 'tarjeta_verde', 'vtv', 'rto',
  'poliza_seguro', 'patente', 'oblea', 'otro',
])

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
  numero_serie:   z.string().max(80).nullable().optional(),
  vence_el:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  obs:            z.string().max(500).nullable().optional(),
})

const PatchSchema = z.object({
  numero_serie: z.string().max(80).nullable().optional(),
  vence_el:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  obs:          z.string().max(500).nullable().optional(),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof FlotaDocError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

const docs = new Hono()
docs.use('*', authMiddleware)

docs.get(
  '/:id/documentos',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaDocsService.list(
    Number(c.req.param('id')), c.get('accessToken'),
  )),
)

docs.post(
  '/:id/documentos/upload-url',
  requirePermiso('flota', 'creacion'),
  zValidator('json', UploadUrlSchema),
  handle(c => flotaDocsService.generarUploadUrl(
    Number(c.req.param('id')), c.req.valid('json'),
  )),
)

docs.post(
  '/:id/documentos',
  requirePermiso('flota', 'creacion'),
  zValidator('json', RegistrarSchema),
  handle(c => flotaDocsService.registrar(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

docs.patch(
  '/:id/documentos/:docId',
  requirePermiso('flota', 'actualizacion'),
  zValidator('json', PatchSchema),
  handle(c => flotaDocsService.actualizarMetadata(
    Number(c.req.param('id')),
    Number(c.req.param('docId')),
    c.req.valid('json'),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

docs.get(
  '/:id/documentos/:docId/signed-url',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaDocsService.signedUrl(
    Number(c.req.param('id')),
    Number(c.req.param('docId')),
    c.get('accessToken'),
  )),
)

docs.delete(
  '/:id/documentos/:docId',
  requirePermiso('flota', 'eliminacion'),
  handle(c => flotaDocsService.softDelete(
    Number(c.req.param('id')),
    Number(c.req.param('docId')),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

export default docs
