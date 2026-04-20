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
  try {
    const dto = c.req.valid('json')
    console.log('[POST /solicitudes] dto:', JSON.stringify(dto))
    const data = await solicitudesService.create(dto, c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    console.error('[POST /solicitudes] ERROR:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

solicitudes.patch('/:id', zValidator('json', UpdateSolicitudSchema), async (c) => {
  const data = await solicitudesService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

solicitudes.delete('/:id', async (c) => {
  return c.json(await solicitudesService.delete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// Helper: las acciones de ítems devuelven 404 si no encuentran el ítem
function itemHandler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err: any) {
      if (err.message?.includes('no encontrado') || err.message?.includes('ya fue')) {
        return c.json({ error: err.message }, 404)
      }
      return c.json({ error: err.message }, 500)
    }
  }
}

// ── Acciones sobre ítems ──
solicitudes.post('/items/:itemId/comprar', zValidator('json', ComprarItemSchema), itemHandler(async (c) => {
  return solicitudesService.comprarItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
}))

solicitudes.post('/items/:itemId/despachar', zValidator('json', DespacharItemSchema), itemHandler(async (c) => {
  return solicitudesService.despacharItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
}))

solicitudes.post('/items/:itemId/enviar', zValidator('json', EnviarItemSchema), itemHandler(async (c) => {
  return solicitudesService.enviarItem(
    Number(c.req.param('itemId')), c.req.valid('json').fecha_envio, c.get('accessToken')
  )
}))

solicitudes.post('/items/:itemId/rechazar', itemHandler(async (c) => {
  return solicitudesService.rechazarItem(
    Number(c.req.param('itemId')), c.get('accessToken')
  )
}))

solicitudes.post('/items/:itemId/revertir', itemHandler(async (c) => {
  return solicitudesService.revertirItem(
    Number(c.req.param('itemId')), c.get('accessToken')
  )
}))

solicitudes.patch('/items/:itemId', zValidator('json', EditarItemSchema), itemHandler(async (c) => {
  return solicitudesService.editarItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
}))

export default solicitudes
