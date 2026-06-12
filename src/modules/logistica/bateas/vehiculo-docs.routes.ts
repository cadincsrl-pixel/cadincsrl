/**
 * Factory de routes para documentos de vehículo. Se monta dos veces:
 *   - bajo /api/logistica/camiones (entidad='camion')
 *   - bajo /api/logistica/bateas    (entidad='batea')
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { vehiculoDocsService, VehiculoDocError, type Entidad } from './vehiculo-docs.service.js'

const TipoEnum = z.enum(['titulo', 'tarjeta_verde', 'rto', 'poliza_seguro', 'homologacion', 'registro_modificacion'])

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
  vence_el:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  obs:            z.string().max(500).optional(),
})

const PatchSchema = z.object({
  vence_el: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  obs:      z.string().max(500).nullable().optional(),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof VehiculoDocError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

export function buildVehiculoDocsRoutes(entidad: Entidad): Hono {
  const docs = new Hono()
  docs.use('*', authMiddleware)

  // GET /:id/documentos
  docs.get(
    '/:id/documentos',
    requirePermiso('logistica', 'lectura'),
    handle(c => vehiculoDocsService.listByEntidad(
      entidad, Number(c.req.param('id')), c.get('accessToken'),
    )),
  )

  // POST /:id/documentos/upload-url
  docs.post(
    '/:id/documentos/upload-url',
    requirePermiso('logistica', 'creacion'),
    zValidator('json', UploadUrlSchema),
    handle(c => vehiculoDocsService.generarUploadUrl(
      entidad, Number(c.req.param('id')), c.req.valid('json'),
    )),
  )

  // POST /:id/documentos
  docs.post(
    '/:id/documentos',
    requirePermiso('logistica', 'creacion'),
    zValidator('json', RegistrarSchema),
    handle(c => vehiculoDocsService.registrar(
      entidad,
      Number(c.req.param('id')),
      c.req.valid('json'),
      c.get('user').id,
      c.get('accessToken'),
    )),
  )

  // PATCH /:id/documentos/:docId
  docs.patch(
    '/:id/documentos/:docId',
    requirePermiso('logistica', 'actualizacion'),
    zValidator('json', PatchSchema),
    handle(c => vehiculoDocsService.actualizarMetadata(
      entidad,
      Number(c.req.param('id')),
      Number(c.req.param('docId')),
      c.req.valid('json'),
      c.get('user').id,
      c.get('accessToken'),
    )),
  )

  // GET /:id/documentos/:docId/signed-url
  docs.get(
    '/:id/documentos/:docId/signed-url',
    requirePermiso('logistica', 'lectura'),
    handle(c => vehiculoDocsService.signedUrl(
      entidad,
      Number(c.req.param('id')),
      Number(c.req.param('docId')),
      c.get('accessToken'),
    )),
  )

  // DELETE /:id/documentos/:docId
  docs.delete(
    '/:id/documentos/:docId',
    requirePermiso('logistica', 'eliminacion'),
    handle(c => vehiculoDocsService.softDelete(
      entidad,
      Number(c.req.param('id')),
      Number(c.req.param('docId')),
      c.get('user').id,
      c.get('accessToken'),
    )),
  )

  return docs
}
