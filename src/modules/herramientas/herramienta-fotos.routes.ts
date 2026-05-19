/**
 * Routes de fotos de herramientas. Se montan como dos sub-routers dentro
 * de herramientas.routes.ts para que las URLs efectivas queden:
 *
 *   GET    /api/herramientas/:id/fotos
 *   POST   /api/herramientas/:id/fotos/upload-url
 *   POST   /api/herramientas/:id/fotos
 *   PATCH  /api/herramientas/:id/fotos/orden
 *   GET    /api/herramientas/fotos/:fotoId/url
 *   DELETE /api/herramientas/fotos/:fotoId
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import {
  herramientaFotosService,
  HerramientaFotoError,
} from './herramienta-fotos.service.js'

const UploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1).max(255),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

const CreateSchema = z.object({
  storage_path: z.string().min(1).max(500),
  file_hash:    z.string().min(8).max(128).nullable().optional(),
  descripcion:  z.string().max(500).nullable().optional(),
  orden:        z.number().int().min(0).nullable().optional(),
})

const ReordenarSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof HerramientaFotoError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

// =====================================================================
// Sub-router de operaciones a nivel galería: /api/herramientas/:id/fotos/...
// =====================================================================
const fotosPorHerramienta = new Hono()
fotosPorHerramienta.use('*', authMiddleware)

// GET /api/herramientas/:id/fotos
fotosPorHerramienta.get(
  '/:id/fotos',
  requirePermiso('herramientas', 'lectura'),
  handle(c => herramientaFotosService.list(
    Number(c.req.param('id')),
    c.get('accessToken'),
  )),
)

// POST /api/herramientas/:id/fotos/upload-url
fotosPorHerramienta.post(
  '/:id/fotos/upload-url',
  requirePermiso('herramientas', 'creacion'),
  zValidator('json', UploadUrlSchema),
  handle(c => herramientaFotosService.requestUploadUrl(
    Number(c.req.param('id')),
    c.req.valid('json'),
  )),
)

// POST /api/herramientas/:id/fotos
fotosPorHerramienta.post(
  '/:id/fotos',
  requirePermiso('herramientas', 'creacion'),
  zValidator('json', CreateSchema),
  async (c) => {
    try {
      const data = await herramientaFotosService.create(
        Number(c.req.param('id')),
        c.req.valid('json'),
        c.get('user').id,
        c.get('accessToken'),
      )
      return c.json(data, 201)
    } catch (err) {
      if (err instanceof HerramientaFotoError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: (err as Error).message ?? 'UNKNOWN' }, 500)
    }
  },
)

// PATCH /api/herramientas/:id/fotos/orden
fotosPorHerramienta.patch(
  '/:id/fotos/orden',
  requirePermiso('herramientas', 'actualizacion'),
  zValidator('json', ReordenarSchema),
  handle(c => herramientaFotosService.reordenar(
    Number(c.req.param('id')),
    c.req.valid('json').ids,
    c.get('accessToken'),
  )),
)

// =====================================================================
// Sub-router de operaciones a nivel foto: /api/herramientas/fotos/:fotoId/...
// =====================================================================
const fotosPorId = new Hono()
fotosPorId.use('*', authMiddleware)

// GET /api/herramientas/fotos/:fotoId/url
fotosPorId.get(
  '/:fotoId/url',
  requirePermiso('herramientas', 'lectura'),
  handle(c => herramientaFotosService.signedUrl(
    Number(c.req.param('fotoId')),
    c.get('accessToken'),
  )),
)

// DELETE /api/herramientas/fotos/:fotoId
fotosPorId.delete(
  '/:fotoId',
  requirePermiso('herramientas', 'eliminacion'),
  handle(c => herramientaFotosService.softDelete(
    Number(c.req.param('fotoId')),
    c.get('accessToken'),
  )),
)

export { fotosPorHerramienta, fotosPorId }
