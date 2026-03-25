import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { tarifasService } from './tarifas.service.js'
import { CreateTarifaSchema } from './tarifas.schema.js'

const tarifas = new Hono()

tarifas.use('*', authMiddleware)

// GET /api/tarifas/:obraCod
tarifas.get('/:obraCod', async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const data = await tarifasService.getByObra(obraCod, token)
  return c.json(data)
})

// PUT /api/tarifas
tarifas.put('/', zValidator('json', CreateTarifaSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await tarifasService.upsert(dto, token)
  return c.json(data)
})

// DELETE /api/tarifas/:id
tarifas.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await tarifasService.delete(id, token)
  return c.json(data)
})

export default tarifas