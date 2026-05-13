import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { flotaGpsSyncService, FlotaGpsSyncError } from './flota-gps-sync.service.js'

const gps = new Hono()

gps.use('*', authMiddleware)

const ParamVehiculoSchema = z.object({
  vehiculo_id: z.coerce.number().int().positive(),
})

const LogQuerySchema = z.object({
  vehiculo_id: z.coerce.number().int().positive().optional(),
  estado:      z.enum(['ok', 'error', 'no_match', 'sin_cambio']).optional(),
  limit:       z.coerce.number().int().positive().max(500).default(50),
})

function handle(err: unknown, c: any) {
  if (err instanceof FlotaGpsSyncError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// POST /api/flota/gps/sync-todos — sincroniza toda la flota ahora.
gps.post(
  '/sync-todos',
  requirePermiso('flota', 'actualizacion'),
  async (c) => {
    try {
      const user = c.get('user')
      const data = await flotaGpsSyncService.syncTodos(user.id)
      return c.json({
        total:       data.total,
        ok:          data.ok,
        sin_cambio:  data.sin_cambio,
        no_match:    data.no_match,
        error:       data.error,
        duracion_ms: data.duracion_ms,
      })
    } catch (err) { return handle(err, c) }
  },
)

// POST /api/flota/gps/sync/:vehiculo_id — sync manual de un vehículo solo.
gps.post(
  '/sync/:vehiculo_id',
  requirePermiso('flota', 'actualizacion'),
  zValidator('param', ParamVehiculoSchema),
  async (c) => {
    try {
      const { vehiculo_id } = c.req.valid('param')
      const user = c.get('user')
      const data = await flotaGpsSyncService.syncIndividual(
        vehiculo_id,
        user.id,
        c.get('accessToken'),
      )
      return c.json(data)
    } catch (err) { return handle(err, c) }
  },
)

// GET /api/flota/gps/log?vehiculo_id=X&estado=Y&limit=N — bitácora.
gps.get(
  '/log',
  requirePermiso('flota', 'lectura'),
  zValidator('query', LogQuerySchema),
  async (c) => {
    try {
      const q = c.req.valid('query')
      const data = await flotaGpsSyncService.listLog(c.get('accessToken'), q)
      return c.json(data)
    } catch (err) { return handle(err, c) }
  },
)

export default gps
