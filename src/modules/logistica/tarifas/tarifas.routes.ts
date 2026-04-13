import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { tarifasService } from './tarifas.service.js'
import { UpsertTarifaCanteraSchema } from './tarifas.schema.js'

const tarifas = new Hono()
tarifas.use('*', authMiddleware)
tarifas.on(['GET'],          '*', requirePermiso('logistica', 'lectura'))
tarifas.on(['POST', 'PUT'],  '*', requirePermiso('logistica', 'actualizacion'))
tarifas.on(['DELETE'],       '*', requirePermiso('logistica', 'eliminacion'))

tarifas.get('/canteras', async (c) => {
  const data = await tarifasService.getTarifasCantera(c.get('accessToken'))
  return c.json(data)
})

tarifas.post('/canteras', zValidator('json', UpsertTarifaCanteraSchema), async (c) => {
  const data = await tarifasService.upsertTarifaCantera(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

tarifas.delete('/canteras/:id', async (c) => {
  const data = await tarifasService.deleteTarifaCantera(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default tarifas
