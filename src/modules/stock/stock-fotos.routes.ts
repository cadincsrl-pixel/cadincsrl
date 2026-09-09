/**
 * Fotos de las fichas del catálogo (20260912g). App aparte, montada en app.ts
 * sobre el mismo prefijo `/api/stock` pero ANTES del router de stock: ese
 * router aplica permisos por método (POST = creacion, DELETE = eliminacion) y
 * acá subir o sacar una foto es EDITAR la ficha, así que todo va con
 * `certificaciones.actualizacion`. Lo que esta app no matchea sigue al router
 * de stock como siempre.
 *
 *   GET    /api/stock/materiales/:id/fotos              lectura
 *   POST   /api/stock/materiales/:id/fotos/upload-url   actualizacion
 *   POST   /api/stock/materiales/:id/fotos              actualizacion → 201
 *   PATCH  /api/stock/materiales/:id/fotos/orden        actualizacion (la primera es la principal)
 *   DELETE /api/stock/fotos/:fotoId                     actualizacion
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { stockFotosService, StockFotoError } from './stock-fotos.service.js'

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
const ReordenarSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) })

function handle<T>(fn: (c: any) => Promise<T>, status = 200) {
  return async (c: any) => {
    try {
      return c.json(await fn(c), status as any)
    } catch (err) {
      if (err instanceof StockFotoError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: (err as Error).message ?? 'UNKNOWN' }, 500)
    }
  }
}

const leer   = requirePermiso('certificaciones', 'lectura')
const editar = requirePermiso('certificaciones', 'actualizacion')

const stockFotos = new Hono()

stockFotos.get('/materiales/:id/fotos', authMiddleware, leer,
  handle(c => stockFotosService.list(Number(c.req.param('id')), c.get('accessToken'))))

stockFotos.post('/materiales/:id/fotos/upload-url', authMiddleware, editar, zValidator('json', UploadUrlSchema),
  handle(c => stockFotosService.requestUploadUrl(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'))))

stockFotos.post('/materiales/:id/fotos', authMiddleware, editar, zValidator('json', CreateSchema),
  handle(c => stockFotosService.create(Number(c.req.param('id')), c.req.valid('json'), c.get('user').id, c.get('accessToken')), 201))

stockFotos.patch('/materiales/:id/fotos/orden', authMiddleware, editar, zValidator('json', ReordenarSchema),
  handle(c => stockFotosService.reordenar(Number(c.req.param('id')), c.req.valid('json').ids, c.get('accessToken'))))

stockFotos.delete('/fotos/:fotoId', authMiddleware, editar,
  handle(c => stockFotosService.softDelete(Number(c.req.param('fotoId')), c.get('accessToken'))))

export default stockFotos
