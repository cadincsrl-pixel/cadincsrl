import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { tramoRelevoService, RelevoError } from './relevo.service.js'

const relevo = new Hono()
relevo.use('*', authMiddleware)

const CrearSchema = z.object({
  chofer_relevo_id:    z.number().int().positive(),
  km_chofer_1:         z.number().min(0).optional(),
  km_chofer_2:         z.number().min(0).optional(),
  jornales_chofer_1:   z.number().min(0).max(10).optional(),
  jornales_chofer_2:   z.number().min(0).max(10).optional(),
  obs:                 z.string().max(500).optional(),
})

const UpdateSchema = z.object({
  km_chofer_1:         z.number().min(0).optional(),
  km_chofer_2:         z.number().min(0).optional(),
  jornales_chofer_1:   z.number().min(0).max(10).optional(),
  jornales_chofer_2:   z.number().min(0).max(10).optional(),
  obs:                 z.string().max(500).nullable().optional(),
})

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err) {
      if (err instanceof RelevoError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      const msg = (err as Error).message ?? 'UNKNOWN'
      return c.json({ error: msg }, 500)
    }
  }
}

relevo.get(
  '/:id/relevo',
  requirePermiso('logistica', 'lectura'),
  handle(c => tramoRelevoService.get(Number(c.req.param('id')), c.get('accessToken'))),
)

// Solo devuelve la sugerencia (km calculados) sin escribir nada.
relevo.get(
  '/:id/relevo/sugerencia',
  requirePermiso('logistica', 'lectura'),
  handle(c => tramoRelevoService.sugerencia(Number(c.req.param('id')), c.get('accessToken'))),
)

relevo.post(
  '/:id/relevo',
  requirePermiso('logistica', 'creacion'),
  zValidator('json', CrearSchema),
  handle(c => tramoRelevoService.crear(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )),
)

relevo.patch(
  '/:id/relevo',
  requirePermiso('logistica', 'actualizacion'),
  zValidator('json', UpdateSchema),
  handle(c => tramoRelevoService.update(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )),
)

relevo.delete(
  '/:id/relevo',
  requirePermiso('logistica', 'eliminacion'),
  handle(c => tramoRelevoService.delete(Number(c.req.param('id')), c.get('accessToken'))),
)

export default relevo
