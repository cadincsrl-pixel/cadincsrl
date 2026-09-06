import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario, validarObraDeRegistro, sinObras } from '../../lib/obras-usuario.js'
import { certificacionesService } from './certificaciones.service.js'
import {
  CreateMaterialSchema, UpdateMaterialSchema,
  CreateAdicionalSchema, UpdateAdicionalSchema,
} from './certificaciones.schema.js'

const cert = new Hono()
cert.use('*', authMiddleware)
// Materiales y adicionales son del módulo certificaciones, no tarja.
// Antes pedía permisos de tarja por error: dejaba que un user con
// solo tarja.lectura viera materiales certificables (datos al cliente)
// y bloqueaba a un user de certificaciones que no tuviera tarja.
cert.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
cert.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
cert.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
cert.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

// Alcance por obra (2026-09-06): son precios facturables al cliente de cada
// obra. Hasta hoy un jefe de obra con scope 'asignadas' podía listar y editar
// los de cualquier obra. Mismo patrón que cuenta-cliente.routes.ts.
const MODULO = 'certificaciones'

// ── Materiales ─────────────────────────────────────────
cert.get('/materiales', async (c) => {
  const userId = c.get('user').id
  const obra_cod = c.req.query('obra_cod')
  if (obra_cod) await validarObraDelUsuario(userId, obra_cod, MODULO)
  const allowed = await getObrasDelUsuarioCached(userId, MODULO)
  if (sinObras(allowed)) return c.json([])
  return c.json(await certificacionesService.getMateriales(c.get('accessToken'), obra_cod, allowed))
})

cert.post('/materiales', zValidator('json', CreateMaterialSchema), async (c) => {
  const dto = c.req.valid('json')
  await validarObraDelUsuario(c.get('user').id, dto.obra_cod, MODULO)
  const data = await certificacionesService.createMaterial(dto, c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

cert.patch('/materiales/:id', zValidator('json', UpdateMaterialSchema), async (c) => {
  await validarObraDeRegistro(c.get('user').id, MODULO, 'cert_materiales', Number(c.req.param('id')))
  const data = await certificacionesService.updateMaterial(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

cert.delete('/materiales/:id', async (c) => {
  await validarObraDeRegistro(c.get('user').id, MODULO, 'cert_materiales', Number(c.req.param('id')))
  return c.json(await certificacionesService.deleteMaterial(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Adicionales ───────────────────────────────────────
cert.get('/adicionales', async (c) => {
  const userId = c.get('user').id
  const obra_cod = c.req.query('obra_cod')
  if (obra_cod) await validarObraDelUsuario(userId, obra_cod, MODULO)
  const allowed = await getObrasDelUsuarioCached(userId, MODULO)
  if (sinObras(allowed)) return c.json([])
  return c.json(await certificacionesService.getAdicionales(c.get('accessToken'), obra_cod, allowed))
})

cert.post('/adicionales', zValidator('json', CreateAdicionalSchema), async (c) => {
  const dto = c.req.valid('json')
  await validarObraDelUsuario(c.get('user').id, dto.obra_cod, MODULO)
  const data = await certificacionesService.createAdicional(dto, c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

cert.patch('/adicionales/:id', zValidator('json', UpdateAdicionalSchema), async (c) => {
  await validarObraDeRegistro(c.get('user').id, MODULO, 'cert_adicionales', Number(c.req.param('id')))
  const data = await certificacionesService.updateAdicional(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

cert.delete('/adicionales/:id', async (c) => {
  await validarObraDeRegistro(c.get('user').id, MODULO, 'cert_adicionales', Number(c.req.param('id')))
  return c.json(await certificacionesService.deleteAdicional(Number(c.req.param('id')), c.get('accessToken')))
})

export default cert
