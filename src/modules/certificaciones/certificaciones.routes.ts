import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { certificacionesService } from './certificaciones.service.js'
import {
  CreateMaterialSchema, UpdateMaterialSchema,
  CreateAdicionalSchema, UpdateAdicionalSchema,
} from './certificaciones.schema.js'

const cert = new Hono()
cert.use('*', authMiddleware)
cert.on(['GET'],            '*', requirePermiso('tarja', 'lectura'))
cert.on(['POST'],           '*', requirePermiso('tarja', 'creacion'))
cert.on(['PATCH', 'PUT'],   '*', requirePermiso('tarja', 'actualizacion'))
cert.on(['DELETE'],         '*', requirePermiso('tarja', 'eliminacion'))

// ── Materiales ─────────────────────────────────────────
cert.get('/materiales', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return c.json(await certificacionesService.getMateriales(c.get('accessToken'), obra_cod))
})

cert.post('/materiales', zValidator('json', CreateMaterialSchema), async (c) => {
  const data = await certificacionesService.createMaterial(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

cert.patch('/materiales/:id', zValidator('json', UpdateMaterialSchema), async (c) => {
  const data = await certificacionesService.updateMaterial(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

cert.delete('/materiales/:id', async (c) => {
  return c.json(await certificacionesService.deleteMaterial(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Adicionales ───────────────────────────────────────
cert.get('/adicionales', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return c.json(await certificacionesService.getAdicionales(c.get('accessToken'), obra_cod))
})

cert.post('/adicionales', zValidator('json', CreateAdicionalSchema), async (c) => {
  const data = await certificacionesService.createAdicional(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

cert.patch('/adicionales/:id', zValidator('json', UpdateAdicionalSchema), async (c) => {
  const data = await certificacionesService.updateAdicional(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

cert.delete('/adicionales/:id', async (c) => {
  return c.json(await certificacionesService.deleteAdicional(Number(c.req.param('id')), c.get('accessToken')))
})

export default cert
