import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { stockService } from './stock.service.js'
import {
  CreateRubroSchema, UpdateRubroSchema,
  CreateMaterialSchema, UpdateMaterialSchema,
  CreateMovimientoSchema,
} from './stock.schema.js'

const stock = new Hono()
stock.use('*', authMiddleware)
stock.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
stock.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
stock.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
stock.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

// ── Rubros ──
stock.get('/rubros', async (c) => {
  return c.json(await stockService.getRubros(c.get('accessToken')))
})

stock.post('/rubros', zValidator('json', CreateRubroSchema), async (c) => {
  return c.json(await stockService.createRubro(c.req.valid('json'), c.get('accessToken')), 201)
})

stock.patch('/rubros/:id', zValidator('json', UpdateRubroSchema), async (c) => {
  return c.json(await stockService.updateRubro(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken')))
})

// ── Materiales ──
stock.get('/materiales', async (c) => {
  const rubro_id = c.req.query('rubro_id')
  return c.json(await stockService.getMateriales(c.get('accessToken'), rubro_id ? Number(rubro_id) : undefined))
})

stock.post('/materiales', zValidator('json', CreateMaterialSchema), async (c) => {
  return c.json(await stockService.createMaterial(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

stock.patch('/materiales/:id', zValidator('json', UpdateMaterialSchema), async (c) => {
  return c.json(await stockService.updateMaterial(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

stock.delete('/materiales/:id', async (c) => {
  return c.json(await stockService.deleteMaterial(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Movimientos ──
stock.get('/movimientos', async (c) => {
  const material_id = c.req.query('material_id')
  return c.json(await stockService.getMovimientos(c.get('accessToken'), material_id ? Number(material_id) : undefined))
})

stock.post('/movimientos', zValidator('json', CreateMovimientoSchema), async (c) => {
  return c.json(await stockService.createMovimiento(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

export default stock
