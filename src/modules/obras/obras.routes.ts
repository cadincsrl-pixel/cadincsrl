import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { obrasService } from './obras.service.js'
import { CreateObraSchema, UpdateObraSchema } from './obras.schema.js'

const obras = new Hono()

obras.use('*', authMiddleware)

// GET /api/obras
obras.get('/', async (c) => {
  const token = c.get('accessToken')
  const data = await obrasService.getAll(token)
  return c.json(data)
})

// GET /api/obras/archivadas
obras.get('/archivadas', async (c) => {
  const token = c.get('accessToken')
  const data = await obrasService.getArchivadas(token)
  return c.json(data)
})

// GET /api/obras/:cod
obras.get('/:cod', async (c) => {
  const cod = c.req.param('cod')
  const token = c.get('accessToken')
  const data = await obrasService.getByCod(cod, token)
  return c.json(data)
})

// POST /api/obras
obras.post('/', zValidator('json', CreateObraSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.create(dto, token, userId)
  return c.json(data, 201)
})

// PATCH /api/obras/:cod
obras.patch('/:cod', zValidator('json', UpdateObraSchema), async (c) => {
  const cod = c.req.param('cod')
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.update(cod, dto, token, userId)
  return c.json(data)
})

// PATCH /api/obras/:cod/archivar
obras.patch('/:cod/archivar', async (c) => {
  const cod = c.req.param('cod')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.archivar(cod, token, userId)
  return c.json(data)
})

// DELETE /api/obras/:cod
obras.delete('/:cod', async (c) => {
  const cod = c.req.param('cod')
  const token = c.get('accessToken')
  const data = await obrasService.delete(cod, token)
  return c.json(data)
})

export default obras
