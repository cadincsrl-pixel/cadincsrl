import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { viajesService } from './viajes.service.js'
import { CreateViajeSchema, CargaSchema, DescargaSchema } from './viajes.schema.js'

const viajes = new Hono()
viajes.use('*', authMiddleware)

viajes.get('/', async (c) => {
  const data = await viajesService.getAll(c.get('accessToken'))
  return c.json(data)
})

viajes.post('/', zValidator('json', CreateViajeSchema), async (c) => {
  const data = await viajesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

viajes.post('/carga', zValidator('json', CargaSchema), async (c) => {
  const data = await viajesService.registrarCarga(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

viajes.post('/descarga', zValidator('json', DescargaSchema), async (c) => {
  const data = await viajesService.registrarDescarga(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

viajes.delete('/:id', async (c) => {
  const data = await viajesService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default viajes
