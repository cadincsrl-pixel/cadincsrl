import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { flotaGastosService, FlotaGastoError } from './flota-gastos.service.js'

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/

const UploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1).max(255),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

const CreateSchema = z.object({
  vehiculo_id:      z.number().int().positive(),
  categoria_id:     z.number().int().positive().nullable().optional(),
  fecha:            z.string().regex(FECHA_RE),
  monto:            z.number().min(0),
  proveedor:        z.string().max(120).nullable().optional(),
  descripcion:      z.string().max(500).nullable().optional(),
  comprobante_path: z.string().nullable().optional(),
  comprobante_hash: z.string().min(8).max(128).nullable().optional(),
})

const UpdateSchema = z.object({
  categoria_id: z.number().int().positive().nullable().optional(),
  fecha:        z.string().regex(FECHA_RE).optional(),
  monto:        z.number().min(0).optional(),
  proveedor:    z.string().max(120).nullable().optional(),
  descripcion:  z.string().max(500).nullable().optional(),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof FlotaGastoError) {
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
// /api/flota/gastos-categorias  (catálogo)
// =====================================================================
const categorias = new Hono()
categorias.use('*', authMiddleware)

categorias.get(
  '/',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaGastosService.listCategorias(c.get('accessToken'))),
)

export { categorias as flotaGastosCategorias }

// =====================================================================
// /api/flota/gastos
// =====================================================================
const gastos = new Hono()
gastos.use('*', authMiddleware)

// GET /api/flota/gastos?vehiculo_id=..&categoria_id=..&desde=..&hasta=..&limit=..
gastos.get(
  '/',
  requirePermiso('flota', 'lectura'),
  handle(c => {
    const q = c.req.query.bind(c.req)
    return flotaGastosService.list({
      vehiculo_id:  q('vehiculo_id')  ? Number(q('vehiculo_id'))  : null,
      categoria_id: q('categoria_id') ? Number(q('categoria_id')) : null,
      desde:        q('desde')  ?? null,
      hasta:        q('hasta')  ?? null,
      limit:        q('limit')  ? Number(q('limit')) : 200,
    }, c.get('accessToken'))
  }),
)

// POST /api/flota/gastos/upload-url?vehiculo_id=..
gastos.post(
  '/upload-url',
  requirePermiso('flota', 'creacion'),
  zValidator('json', UploadUrlSchema),
  handle(c => flotaGastosService.generarUploadUrl(
    Number(c.req.query('vehiculo_id')),
    c.req.valid('json'),
  )),
)

// POST /api/flota/gastos
gastos.post(
  '/',
  requirePermiso('flota', 'creacion'),
  zValidator('json', CreateSchema),
  async (c) => {
    try {
      const data = await flotaGastosService.create(
        c.req.valid('json') as any,
        c.get('user').id,
        c.get('accessToken'),
      )
      return c.json(data, 201)
    } catch (err) {
      if (err instanceof FlotaGastoError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: (err as Error).message ?? 'UNKNOWN' }, 500)
    }
  },
)

// PATCH /api/flota/gastos/:id
gastos.patch(
  '/:id',
  requirePermiso('flota', 'actualizacion'),
  zValidator('json', UpdateSchema),
  handle(c => flotaGastosService.update(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

// GET /api/flota/gastos/:id/comprobante-url
gastos.get(
  '/:id/comprobante-url',
  requirePermiso('flota', 'lectura'),
  handle(c => flotaGastosService.signedUrl(
    Number(c.req.param('id')),
    c.get('accessToken'),
  )),
)

// DELETE /api/flota/gastos/:id  (soft delete)
gastos.delete(
  '/:id',
  requirePermiso('flota', 'eliminacion'),
  handle(c => flotaGastosService.softDelete(
    Number(c.req.param('id')),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

export default gastos
