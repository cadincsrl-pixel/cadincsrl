import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso, requireTab } from '../../../middleware/permission.js
import { rentabilidadService } from './rentabilidad.service.js'
import { ParametrosSchema, CreateViajeSchema, UpdateViajeSchema } from './rentabilidad.schema.js'

const rentabilidad = new Hono()

rentabilidad.use('*', authMiddleware)
// Guardia por tab (2026-09-06): la tab de la pantalla también vale en la API.
rentabilidad.use('*', requireTab('logistica', 'rentabilidad'))
rentabilidad.on(['GET'],          '*', requirePermiso('logistica', 'lectura'))
rentabilidad.on(['POST'],         '*', requirePermiso('logistica', 'creacion'))
rentabilidad.on(['PATCH', 'PUT'], '*', requirePermiso('logistica', 'actualizacion'))
rentabilidad.on(['DELETE'],       '*', requirePermiso('logistica', 'eliminacion'))

// ── Parámetros vigentes (set único con vigente_hasta IS NULL) ──
rentabilidad.get('/parametros', async (c) => {
  const data = await rentabilidadService.getParametros(c.get('accessToken'))
  return c.json(data)
})

rentabilidad.put('/parametros', zValidator('json', ParametrosSchema), async (c) => {
  const data = await rentabilidadService.updateParametros(
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data)
})

// ── Viajes (CRUD ilimitado) ──
rentabilidad.get('/viajes', async (c) => {
  const data = await rentabilidadService.listViajes(c.get('accessToken'))
  return c.json(data)
})

rentabilidad.post('/viajes', zValidator('json', CreateViajeSchema), async (c) => {
  const data = await rentabilidadService.createViaje(
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data, 201)
})

rentabilidad.patch('/viajes/:id', zValidator('json', UpdateViajeSchema), async (c) => {
  const data = await rentabilidadService.updateViaje(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data)
})

rentabilidad.delete('/viajes/:id', async (c) => {
  const data = await rentabilidadService.deleteViaje(
    Number(c.req.param('id')),
    c.get('accessToken'),
  )
  return c.json(data)
})

export default rentabilidad
