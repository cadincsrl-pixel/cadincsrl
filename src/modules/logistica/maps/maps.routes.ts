import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { mapsService, MapsError } from './maps.service.js'
import { GeocodeSchema } from './maps.schema.js'

const maps = new Hono()

maps.use('*', authMiddleware)
maps.on(['GET'],  '*', requirePermiso('logistica', 'lectura'))
maps.on(['POST'], '*', requirePermiso('logistica', 'actualizacion'))

function handle(err: unknown, c: any) {
  if (err instanceof MapsError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// POST /api/logistica/maps/geocode — convierte dirección/nombre en lat/lng.
maps.post('/geocode', zValidator('json', GeocodeSchema), async (c) => {
  try {
    const { direccion } = c.req.valid('json')
    const data = await mapsService.geocodeDireccion(direccion)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// GET /api/logistica/maps/en-ruta — lista de tramos cargados en curso con
// distancia/ETA al destino.
maps.get('/en-ruta', async (c) => {
  try {
    const data = await mapsService.listarEnRuta(c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

export default maps
