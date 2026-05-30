import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { ropaService } from './ropa.service.js'
import {
  CreateCategoriaSchema, UpdateCategoriaSchema, CreateEntregaSchema,
} from './ropa.schema.js'

// Ropa es un tab de tarja (CLAUDE.md §4) → permisos vía 'tarja.*'.
// Las lecturas las hace el front directo contra Supabase (data no-PII);
// lo que sí se centraliza acá es la mutación (con audit + permisos).
const ropa = new Hono()
ropa.use('*', authMiddleware)
ropa.on(['POST'],         '*', requirePermiso('tarja', 'creacion'))
ropa.on(['PATCH', 'PUT'], '*', requirePermiso('tarja', 'actualizacion'))
ropa.on(['DELETE'],       '*', requirePermiso('tarja', 'eliminacion'))

// ── Categorías ──

ropa.post('/categorias', zValidator('json', CreateCategoriaSchema), async (c) => {
  const data = await ropaService.createCategoria(c.req.valid('json'), c.get('accessToken'))
  return c.json(data, 201)
})

ropa.patch('/categorias/:id', zValidator('json', UpdateCategoriaSchema), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'ID_INVALIDO' }, 400)
  const data = await ropaService.updateCategoria(id, c.req.valid('json'), c.get('accessToken'))
  return c.json(data)
})

ropa.delete('/categorias/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'ID_INVALIDO' }, 400)
  const data = await ropaService.deleteCategoria(id, c.get('accessToken'))
  return c.json(data)
})

// ── Entregas ──

ropa.post('/entregas', zValidator('json', CreateEntregaSchema), async (c) => {
  const data = await ropaService.createEntrega(
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data, 201)
})

ropa.delete('/entregas/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'ID_INVALIDO' }, 400)
  const data = await ropaService.deleteEntrega(id, c.get('accessToken'))
  return c.json(data)
})

export default ropa
