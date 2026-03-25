// src/modules/categorias/categorias.routes.ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { categoriasService } from './categorias.service.js'
import { CreateCategoriaSchema, UpdateCategoriaSchema } from './categorias.schema.js'

const categorias = new Hono()

categorias.use('*', authMiddleware)

categorias.get('/', async (c) => {
  const token = c.get('accessToken')
  const data = await categoriasService.getAll(token)
  return c.json(data)
})

categorias.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await categoriasService.getById(id, token)
  return c.json(data)
})

categorias.post('/', zValidator('json', CreateCategoriaSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await categoriasService.create(dto, token)
  return c.json(data, 201)
})

categorias.patch('/:id', zValidator('json', UpdateCategoriaSchema), async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await categoriasService.update(id, dto, token)
  return c.json(data)
})

categorias.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await categoriasService.delete(id, token)
  return c.json(data)
})

export default categorias