// src/modules/categorias/categorias.routes.ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { categoriasService } from './categorias.service.js'
import { CreateCategoriaSchema, UpdateCategoriaSchema } from './categorias.schema.js'

const categorias = new Hono()

categorias.use('*', authMiddleware)

// Lectura abierta (sin requirePermiso) por compat: la UI la usa para
// dibujar selects/tabs en muchos contextos. Si fuera necesario cerrar,
// hacerlo desde un solo lugar.
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

// Mutaciones de catálogo de categorías: jefatura/RRHH.
// Antes este endpoint NO tenía requirePermiso → cualquier user logueado
// podía crear/editar/borrar. Ahora exige permiso de eliminación de tarja
// (proxy razonable de "es jefe que administra catálogos") + el flag
// solo_carga_horas en false (capataz queda fuera).
categorias.post(
  '/',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', CreateCategoriaSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await categoriasService.create(dto, token, userId)
    return c.json(data, 201)
  },
)

categorias.patch(
  '/:id',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', UpdateCategoriaSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await categoriasService.update(id, dto, token, userId)
    return c.json(data)
  },
)

categorias.delete(
  '/:id',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const token = c.get('accessToken')
    const data = await categoriasService.delete(id, token)
    return c.json(data)
  },
)

export default categorias
