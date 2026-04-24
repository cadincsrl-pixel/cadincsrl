import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { cajaService } from './caja.service.js'
import {
  CreateMovimientoSchema, UpdateMovimientoSchema,
  CreateConceptoSchema, ToggleActivoSchema, CreateCentroSchema,
} from './caja.schema.js'

const caja = new Hono()
caja.use('*', authMiddleware)
caja.on(['GET'],          '*', requirePermiso('caja', 'lectura'))
caja.on(['POST'],         '*', requirePermiso('caja', 'creacion'))
caja.on(['PATCH', 'PUT'], '*', requirePermiso('caja', 'actualizacion'))
caja.on(['DELETE'],       '*', requirePermiso('caja', 'eliminacion'))

// ── Movimientos ────────────────────────────────────────────────────────────

caja.get('/movimientos', async (c) => {
  return c.json(await cajaService.getMovimientos(c.get('accessToken')))
})

caja.post('/movimientos', zValidator('json', CreateMovimientoSchema), async (c) => {
  const data = await cajaService.createMovimiento(
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data, 201)
})

caja.patch('/movimientos/:id', zValidator('json', UpdateMovimientoSchema), async (c) => {
  const data = await cajaService.updateMovimiento(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('accessToken'),
  )
  return c.json(data)
})

caja.delete('/movimientos/:id', async (c) => {
  return c.json(await cajaService.deleteMovimiento(
    Number(c.req.param('id')),
    c.get('accessToken'),
  ))
})

// ── Conceptos ──────────────────────────────────────────────────────────────

caja.get('/conceptos', async (c) => {
  return c.json(await cajaService.getConceptos(c.get('accessToken')))
})

caja.post('/conceptos', zValidator('json', CreateConceptoSchema), async (c) => {
  return c.json(await cajaService.createConcepto(c.req.valid('json'), c.get('accessToken')), 201)
})

caja.patch('/conceptos/:id', zValidator('json', ToggleActivoSchema), async (c) => {
  return c.json(await cajaService.toggleConcepto(
    Number(c.req.param('id')),
    c.req.valid('json').activo,
    c.get('accessToken'),
  ))
})

// ── Centros de costo ───────────────────────────────────────────────────────

caja.get('/centros-costo', async (c) => {
  return c.json(await cajaService.getCentros(c.get('accessToken')))
})

caja.post('/centros-costo', zValidator('json', CreateCentroSchema), async (c) => {
  return c.json(await cajaService.createCentro(c.req.valid('json').nombre, c.get('accessToken')), 201)
})

caja.patch('/centros-costo/:id', zValidator('json', ToggleActivoSchema), async (c) => {
  return c.json(await cajaService.toggleCentro(
    Number(c.req.param('id')),
    c.req.valid('json').activo,
    c.get('accessToken'),
  ))
})

export { caja as cajaRoutes }
