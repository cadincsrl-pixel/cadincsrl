import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { gpsSyncService, GpsSyncError } from './gps-sync.service.js'
import {
  SyncCamionParamSchema, SetIdVehiculoGpsSchema, LogQuerySchema,
} from './gps-sync.schema.js'

const gps = new Hono()

gps.use('*', authMiddleware)
gps.on(['GET'],   '*', requirePermiso('logistica', 'lectura'))
gps.on(['POST'],  '*', requirePermiso('logistica', 'actualizacion'))
gps.on(['PATCH'], '*', requirePermiso('logistica', 'actualizacion'))

function handle(err: unknown, c: any) {
  if (err instanceof GpsSyncError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// POST /api/logistica/gps/sync-todos — sincroniza todos los camiones ahora.
gps.post('/sync-todos', async (c) => {
  try {
    const user = c.get('user')
    const data = await gpsSyncService.syncGlobalManual(user.id)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// POST /api/logistica/gps/sync/:camion_id — sync manual de un camión solo.
gps.post('/sync/:camion_id', zValidator('param', SyncCamionParamSchema), async (c) => {
  try {
    const { camion_id } = c.req.valid('param')
    const user = c.get('user')
    const data = await gpsSyncService.syncCamionManual(camion_id, user.id)
    if (!data) return c.json({ error: 'CAMION_NO_ENCONTRADO_EN_GPS' }, 404)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// PATCH /api/logistica/gps/camion/:camion_id/id-vehiculo — mapping manual.
gps.patch('/camion/:camion_id/id-vehiculo',
  zValidator('param', SyncCamionParamSchema),
  zValidator('json',  SetIdVehiculoGpsSchema),
  async (c) => {
    try {
      const { camion_id } = c.req.valid('param')
      const { id_vehiculo_gps } = c.req.valid('json')
      const user = c.get('user')
      const data = await gpsSyncService.setIdVehiculoGps(
        camion_id, id_vehiculo_gps, c.get('accessToken'), user.id,
      )
      return c.json(data)
    } catch (err) { return handle(err, c) }
  },
)

// GET /api/logistica/gps/log?camion_id=X&estado=Y&limit=N — bitácora.
gps.get('/log', zValidator('query', LogQuerySchema), async (c) => {
  try {
    const q = c.req.valid('query')
    const data = await gpsSyncService.listLog(c.get('accessToken'), q)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// GET /api/logistica/gps/sin-asignar — vehículos GPS no mapeados a camión.
gps.get('/sin-asignar', async (c) => {
  try {
    const data = await gpsSyncService.vehiculosSinAsignar(c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

export default gps
