import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { solicitudesService } from './solicitudes.service.js'
import {
  CreateSolicitudSchema, UpdateSolicitudSchema,
  ComprarItemSchema, DespacharItemSchema, EnviarItemSchema, EditarItemSchema,
} from './solicitudes.schema.js'

const solicitudes = new Hono()
solicitudes.use('*', authMiddleware)
solicitudes.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
solicitudes.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
solicitudes.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
solicitudes.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

// ── Solicitudes CRUD ──
solicitudes.get('/', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return c.json(await solicitudesService.getAll(c.get('accessToken'), obra_cod))
})

solicitudes.get('/:id', async (c) => {
  return c.json(await solicitudesService.getById(Number(c.req.param('id')), c.get('accessToken')))
})

solicitudes.post('/', zValidator('json', CreateSolicitudSchema), async (c) => {
  const data = await solicitudesService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

solicitudes.patch('/:id', zValidator('json', UpdateSolicitudSchema), async (c) => {
  const data = await solicitudesService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

solicitudes.delete('/:id', async (c) => {
  return c.json(await solicitudesService.delete(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Acciones sobre ítems ──
solicitudes.post('/items/:itemId/comprar', zValidator('json', ComprarItemSchema), async (c) => {
  const data = await solicitudesService.comprarItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
  return c.json(data)
})

solicitudes.post('/items/:itemId/despachar', zValidator('json', DespacharItemSchema), async (c) => {
  const data = await solicitudesService.despacharItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
  return c.json(data)
})

solicitudes.post('/items/:itemId/enviar', zValidator('json', EnviarItemSchema), async (c) => {
  const data = await solicitudesService.enviarItem(
    Number(c.req.param('itemId')), c.req.valid('json').fecha_envio, c.get('accessToken')
  )
  return c.json(data)
})

solicitudes.post('/items/:itemId/rechazar', async (c) => {
  const data = await solicitudesService.rechazarItem(
    Number(c.req.param('itemId')), c.get('accessToken')
  )
  return c.json(data)
})

solicitudes.post('/items/:itemId/revertir', async (c) => {
  const data = await solicitudesService.revertirItem(
    Number(c.req.param('itemId')), c.get('accessToken')
  )
  return c.json(data)
})

solicitudes.patch('/items/:itemId', zValidator('json', EditarItemSchema), async (c) => {
  const data = await solicitudesService.editarItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
  return c.json(data)
})

export default solicitudes
