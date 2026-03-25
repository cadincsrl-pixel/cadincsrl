import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { lugaresService } from './lugares.service.js'
import { CreateLugarSchema, UpdateLugarSchema, CreateRutaSchema } from './lugares.schema.js'

const lugares = new Hono()
lugares.use('*', authMiddleware)

lugares.get('/canteras',  async (c) => c.json(await lugaresService.getCanteras(c.get('accessToken'))))
lugares.get('/depositos', async (c) => c.json(await lugaresService.getDepositos(c.get('accessToken'))))
lugares.get('/rutas',     async (c) => c.json(await lugaresService.getRutas(c.get('accessToken'))))

lugares.post('/canteras',  zValidator('json', CreateLugarSchema), async (c) => {
  return c.json(await lugaresService.createCantera(c.req.valid('json'), c.get('accessToken')), 201)
})
lugares.post('/depositos', zValidator('json', CreateLugarSchema), async (c) => {
  return c.json(await lugaresService.createDeposito(c.req.valid('json'), c.get('accessToken')), 201)
})
lugares.post('/rutas', zValidator('json', CreateRutaSchema), async (c) => {
  return c.json(await lugaresService.createRuta(c.req.valid('json'), c.get('accessToken')), 201)
})

lugares.patch('/canteras/:id',  zValidator('json', UpdateLugarSchema), async (c) => {
  return c.json(await lugaresService.updateCantera(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken')))
})
lugares.patch('/depositos/:id', zValidator('json', UpdateLugarSchema), async (c) => {
  return c.json(await lugaresService.updateDeposito(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken')))
})
lugares.delete('/rutas/:id', async (c) => {
  return c.json(await lugaresService.deleteRuta(Number(c.req.param('id')), c.get('accessToken')))
})

export default lugares