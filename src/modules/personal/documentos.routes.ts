import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermisoOr, requireFlag } from '../../middleware/permission.js'
import { documentosService, PersonalDocError } from './documentos.service.js'
import { supabase as supabaseAdmin } from '../../lib/supabase.js'

const docs = new Hono()
docs.use('*', authMiddleware)

const TipoEnum = z.enum(['dni', 'alta_temprana', 'baja', 'telegrama'])

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
      if (err instanceof PersonalDocError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

// GET /api/personal/:leg/documentos — lista
docs.get(
  '/:leg/documentos',
  requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]),
  handle(c => documentosService.listByLeg(c.req.param('leg'), c.get('accessToken'))),
)

// GET /api/personal/documentos/resumen
// Devuelve la lista de legs que tienen al menos 1 documento de cada tipo.
// Usado por banners de alerta en /personal (ej. AlertaDniFaltante) para
// detectar trabajadores con papelitos pendientes sin hacer N requests
// individuales. Service role evita el cap de PostgREST si la tabla crece.
docs.get(
  '/documentos/resumen',
  requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]),
  async (c) => {
    const { data, error } = await supabaseAdmin
      .rpc('legs_con_documento')
    if (error) return c.json({ error: error.message }, 500)
    // data: [{ tipo: 'dni', legs: ['001','002',...] }, ...]
    const resumen: Record<string, string[]> = {}
    for (const row of (data ?? []) as Array<{ tipo: string; legs: string[] }>) {
      resumen[row.tipo] = row.legs
    }
    return c.json(resumen)
  },
)

// POST /api/personal/:leg/documentos/upload-url — genera signed upload URL
docs.post(
  '/:leg/documentos/upload-url',
  requirePermisoOr([{ modulo: 'personal', accion: 'creacion' }, { modulo: 'tarja', accion: 'creacion' }]),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UploadUrlSchema),
  handle(c => documentosService.generarUploadUrl(c.req.param('leg'), c.req.valid('json'))),
)

// POST /api/personal/:leg/documentos — registra un doc tras upload
docs.post(
  '/:leg/documentos',
  requirePermisoOr([{ modulo: 'personal', accion: 'creacion' }, { modulo: 'tarja', accion: 'creacion' }]),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', RegistrarSchema),
  handle(c => documentosService.registrar(
    c.req.param('leg'),
    c.req.valid('json'),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

// GET /api/personal/:leg/documentos/:id/signed-url — URL temporal view/download
docs.get(
  '/:leg/documentos/:id/signed-url',
  requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]),
  handle(c => documentosService.signedUrl(
    c.req.param('leg'),
    Number(c.req.param('id')),
    c.get('accessToken'),
  )),
)

// DELETE /api/personal/:leg/documentos/:id — soft delete
docs.delete(
  '/:leg/documentos/:id',
  requirePermisoOr([{ modulo: 'personal', accion: 'eliminacion' }, { modulo: 'tarja', accion: 'eliminacion' }]),
  requireFlag('tarja', 'ver_pii', true),
  handle(c => documentosService.softDelete(
    c.req.param('leg'),
    Number(c.req.param('id')),
    c.get('user').id,
    c.get('accessToken'),
  )),
)

export default docs
