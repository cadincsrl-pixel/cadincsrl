/**
 * Factory de routes de documentos por entidad. Se monta CUATRO veces:
 *   /api/logistica/camiones  (entidad='camion',  permisos de logistica)
 *   /api/logistica/bateas    (entidad='batea',   permisos de logistica)
 *   /api/alquiler/maquinas   (entidad='maquina', permisos de alquiler)
 *   /api/aridos/unidades     (entidad='unidad',  permisos de aridos)
 *
 * El módulo de permisos y la lista de tipos válidos salen de `entidadInfo()`:
 * agregar una entidad nueva es una entrada en ese mapa más el `route()` del
 * router de su módulo. Nada de esto se duplica por entidad.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { entidadDocsService, entidadInfo, VehiculoDocError, type Entidad } from './entidad-docs.service.js'

// Los tipos válidos dependen de la entidad (camión/batea aceptan 6, máquina y
// unidad los 8 de flota), así que los schemas se arman por entidad.
function schemasDe(entidad: Entidad) {
  const tipos = entidadInfo(entidad).tipos as [string, ...string[]]
  const TipoEnum = z.enum(tipos)
  return {
    UploadUrlSchema: z.object({
      tipo:           TipoEnum,
      nombre_archivo: z.string().min(1).max(255),
      mime_type:      z.string().min(1),
      size_bytes:     z.number().int().positive(),
    }),
    RegistrarSchema: z.object({
      tipo:           TipoEnum,
      storage_path:   z.string().min(1),
      nombre_archivo: z.string().min(1).max(255),
      mime_type:      z.string().min(1),
      size_bytes:     z.number().int().positive(),
      vence_el:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      obs:            z.string().max(500).optional(),
    }),
  }
}

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

export function buildEntidadDocsRoutes(entidad: Entidad): Hono {
  const docs = new Hono()
  const { modulo } = entidadInfo(entidad)
  const { UploadUrlSchema, RegistrarSchema } = schemasDe(entidad)
  docs.use('*', authMiddleware)

  // GET /:id/documentos
  docs.get(
    '/:id/documentos',
    requirePermiso(modulo, 'lectura'),
    handle(c => entidadDocsService.listByEntidad(
      entidad, Number(c.req.param('id')), c.get('accessToken'),
    )),
  )

  // POST /:id/documentos/upload-url
  docs.post(
    '/:id/documentos/upload-url',
    requirePermiso(modulo, 'creacion'),
    zValidator('json', UploadUrlSchema),
    handle(c => entidadDocsService.generarUploadUrl(
      entidad, Number(c.req.param('id')), c.req.valid('json'),
    )),
  )

  // POST /:id/documentos
  docs.post(
    '/:id/documentos',
    requirePermiso(modulo, 'creacion'),
    zValidator('json', RegistrarSchema),
    handle(c => entidadDocsService.registrar(
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
    requirePermiso(modulo, 'actualizacion'),
    zValidator('json', PatchSchema),
    handle(c => entidadDocsService.actualizarMetadata(
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
    requirePermiso(modulo, 'lectura'),
    handle(c => entidadDocsService.signedUrl(
      entidad,
      Number(c.req.param('id')),
      Number(c.req.param('docId')),
      c.get('accessToken'),
    )),
  )

  // DELETE /:id/documentos/:docId
  docs.delete(
    '/:id/documentos/:docId',
    requirePermiso(modulo, 'eliminacion'),
    handle(c => entidadDocsService.softDelete(
      entidad,
      Number(c.req.param('id')),
      Number(c.req.param('docId')),
      c.get('user').id,
      c.get('accessToken'),
    )),
  )

  return docs
}
