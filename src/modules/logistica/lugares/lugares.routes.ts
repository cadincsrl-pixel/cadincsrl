import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { lugaresService } from './lugares.service.js'
import {
  CreateLugarSchema, UpdateLugarSchema, CreateRutaSchema, UpdateRutaSchema,
  CrearLugarOperativoSchema, UpdateLugarOperativoSchema,
} from './lugares.schema.js'

const lugares = new Hono()
lugares.use('*', authMiddleware)
lugares.on(['GET'],            '*', requirePermiso('logistica', 'lectura'))
lugares.on(['POST'],           '*', requirePermiso('logistica', 'creacion'))
lugares.on(['PATCH', 'PUT'],   '*', requirePermiso('logistica', 'actualizacion'))
lugares.on(['DELETE'],         '*', requirePermiso('logistica', 'eliminacion'))

lugares.get('/canteras',  async (c) => c.json(await lugaresService.getCanteras(c.get('accessToken'))))
lugares.get('/depositos', async (c) => c.json(await lugaresService.getDepositos(c.get('accessToken'))))
lugares.get('/rutas',     async (c) => c.json(await lugaresService.getRutas(c.get('accessToken'))))

lugares.post('/canteras',  zValidator('json', CreateLugarSchema), async (c) => {
  return c.json(await lugaresService.createCantera(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})
lugares.post('/depositos', zValidator('json', CreateLugarSchema), async (c) => {
  return c.json(await lugaresService.createDeposito(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})
lugares.post('/rutas', zValidator('json', CreateRutaSchema), async (c) => {
  return c.json(await lugaresService.createRuta(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

lugares.patch('/canteras/:id',  zValidator('json', UpdateLugarSchema), async (c) => {
  return c.json(await lugaresService.updateCantera(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})
lugares.patch('/depositos/:id', zValidator('json', UpdateLugarSchema), async (c) => {
  return c.json(await lugaresService.updateDeposito(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})
lugares.patch('/rutas/:id', zValidator('json', UpdateRutaSchema), async (c) => {
  return c.json(await lugaresService.updateRuta(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})
lugares.delete('/rutas/:id', async (c) => {
  return c.json(await lugaresService.deleteRuta(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Lugares operativos ────────────────────────────────────────────────
lugares.get('/operativos', async (c) => c.json(await lugaresService.getLugaresOperativos(c.get('accessToken'))))

lugares.post('/operativos', zValidator('json', CrearLugarOperativoSchema), async (c) => {
  return c.json(await lugaresService.crearLugarOperativo(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

lugares.patch('/operativos/:id', zValidator('json', UpdateLugarOperativoSchema), async (c) => {
  try {
    return c.json(await lugaresService.actualizarLugarOperativo(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
  } catch (err: any) {
    if (err.code === 'NO_EXISTE') return c.json({ error: err.code, message: err.message }, 404)
    return c.json({ error: err.message }, 500)
  }
})

lugares.delete('/operativos/:id', async (c) => {
  try {
    return c.json(await lugaresService.eliminarLugarOperativo(Number(c.req.param('id')), c.get('accessToken')))
  } catch (err: any) {
    if (err.code === 'NO_EXISTE') return c.json({ error: err.code, message: err.message }, 404)
    if (err.code === 'EN_USO')    return c.json({ error: err.code, message: err.message }, 409)
    return c.json({ error: err.message }, 500)
  }
})

export default lugares
