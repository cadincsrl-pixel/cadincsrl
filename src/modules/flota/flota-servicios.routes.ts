import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { flotaServiciosService, FlotaServicioError } from './flota-servicios.service.js'

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/

const UploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1).max(255),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

const CreateSchema = z.object({
  vehiculo_id:      z.number().int().positive(),
  tipo_id:          z.number().int().positive().nullable().optional(),
  tipo_libre:       z.string().max(120).nullable().optional(),
  fecha:            z.string().regex(FECHA_RE),
  km_service:       z.number().min(0),
  km_proximo:       z.number().min(0).nullable().optional(),
  fecha_proximo:    z.string().regex(FECHA_RE).nullable().optional(),
  descripcion:      z.string().max(500).nullable().optional(),
  costo:            z.number().min(0).nullable().optional(),
  proveedor:        z.string().max(120).nullable().optional(),
  comprobante_path: z.string().nullable().optional(),
  obs:              z.string().max(500).nullable().optional(),
}).refine(d => d.tipo_id != null || (d.tipo_libre && d.tipo_libre.trim() !== ''), {
  message: 'Indicá un tipo del catálogo o un tipo libre.',
})

const UpdateSchema = z.object({
  tipo_id:          z.number().int().positive().nullable().optional(),
  tipo_libre:       z.string().max(120).nullable().optional(),
  fecha:            z.string().regex(FECHA_RE).optional(),
  km_service:       z.number().min(0).optional(),
  km_proximo:       z.number().min(0).nullable().optional(),
  fecha_proximo:    z.string().regex(FECHA_RE).nullable().optional(),
  descripcion:      z.string().max(500).nullable().optional(),
  costo:            z.number().min(0).nullable().optional(),
  proveedor:        z.string().max(120).nullable().optional(),
  obs:              z.string().max(500).nullable().optional(),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof FlotaServicioError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

const servicios = new Hono()
servicios.use('*', authMiddleware)

// GET /api/flota/servicios?vehiculo_id=...
servicios.get(
  '/',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaServiciosService.list(
    c.req.query('vehiculo_id') ? Number(c.req.query('vehiculo_id')) : null,
    c.get('accessToken'),
  )),
)

// GET /api/flota/servicios/estado — vista de proximidad/vencidos
servicios.get(
  '/estado',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaServiciosService.getEstado(c.get('accessToken'))),
)

// POST /api/flota/servicios/upload-url?vehiculo_id=...
servicios.post(
  '/upload-url',
  requirePermiso('flota', 'creacion'),
  zValidator('json', UploadUrlSchema),
  handle(c => flotaServiciosService.generarUploadUrl(
    Number(c.req.query('vehiculo_id')),
    c.req.valid('json'),
  )),
)

// POST /api/flota/servicios
servicios.post(
  '/',
  requirePermiso('flota', 'creacion'),
  zValidator('json', CreateSchema),
  handle(c => flotaServiciosService.create(
    c.req.valid('json') as any,
    c.get('user').id,
    c.get('accessToken'),
  )),
)

// PATCH /api/flota/servicios/:id
servicios.patch(
  '/:id',
  requirePermiso('flota', 'actualizacion'),
  zValidator('json', UpdateSchema),
  handle(c => flotaServiciosService.update(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

// GET /api/flota/servicios/:id/comprobante-url
servicios.get(
  '/:id/comprobante-url',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaServiciosService.signedUrl(
    Number(c.req.param('id')),
    c.get('accessToken'),
  )),
)

// DELETE /api/flota/servicios/:id
servicios.delete(
  '/:id',
  requirePermiso('flota', 'eliminacion'),
  handle(c => flotaServiciosService.softDelete(
    Number(c.req.param('id')),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

export default servicios
