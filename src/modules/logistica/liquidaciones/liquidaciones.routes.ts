import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { liquidacionesService } from './liquidaciones.service.js'
import { CreateLiquidacionSchema, CreateAdelantoSchema } from './liquidaciones.schema.js'

const liquidaciones = new Hono()
liquidaciones.use('*', authMiddleware)

liquidaciones.get('/',          async (c) => c.json(await liquidacionesService.getAll(c.get('accessToken'))))
liquidaciones.get('/adelantos', async (c) => c.json(await liquidacionesService.getAdelantos(c.get('accessToken'))))

liquidaciones.post('/', zValidator('json', CreateLiquidacionSchema), async (c) => {
  const data = await liquidacionesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

liquidaciones.patch('/:id/cerrar', async (c) => {
  const data = await liquidacionesService.cerrar(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

liquidaciones.delete('/:id', async (c) => {
  const data = await liquidacionesService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

liquidaciones.post('/adelantos', zValidator('json', CreateAdelantoSchema), async (c) => {
  const data = await liquidacionesService.createAdelanto(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

liquidaciones.delete('/adelantos/:id', async (c) => {
  const data = await liquidacionesService.deleteAdelanto(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default liquidaciones
