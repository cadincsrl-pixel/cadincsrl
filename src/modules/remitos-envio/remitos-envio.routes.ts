import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { remitosEnvioService } from './remitos-envio.service.js'
import { CreateRemitoEnvioSchema } from './remitos-envio.schema.js'

const remitosEnvio = new Hono()
remitosEnvio.use('*', authMiddleware)
remitosEnvio.on(['GET'],  '*', requirePermiso('certificaciones', 'lectura'))
remitosEnvio.on(['POST'], '*', requirePermiso('certificaciones', 'creacion'))

remitosEnvio.get('/', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return c.json(await remitosEnvioService.getAll(c.get('accessToken'), obra_cod || undefined))
})

remitosEnvio.get('/:id', async (c) => {
  return c.json(await remitosEnvioService.getById(Number(c.req.param('id')), c.get('accessToken')))
})

remitosEnvio.post('/', zValidator('json', CreateRemitoEnvioSchema), async (c) => {
  try {
    const data = await remitosEnvioService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default remitosEnvio
