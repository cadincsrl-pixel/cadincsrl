import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requirePermisoOr } from '../../middleware/permission.js'
import { obrasService } from './obras.service.js'
import { CreateObraSchema, UpdateObraSchema } from './obras.schema.js'

const obras = new Hono()

obras.use('*', authMiddleware)

// GET /api/obras
// Lectura accesible desde tarja o certificaciones (los jefes de obra
// solo tienen certificaciones y necesitan ver SUS obras al pedir
// materiales).
obras.get('/', requirePermisoOr([
  { modulo: 'tarja', accion: 'lectura' },
  { modulo: 'certificaciones', accion: 'lectura' },
]), async (c) => {
  const token  = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.getAll(token, userId)
  return c.json(data)
})

// GET /api/obras/archivadas
obras.get('/archivadas', requirePermisoOr([
  { modulo: 'tarja', accion: 'lectura' },
  { modulo: 'certificaciones', accion: 'lectura' },
]), async (c) => {
  const token  = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.getArchivadas(token, userId)
  return c.json(data)
})

// POST /api/obras/auto-archivar
obras.post('/auto-archivar', requirePermiso('tarja', 'actualizacion'), async (c) => {
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.autoArchivar(token, userId)
  return c.json(data)
})

// GET /api/obras/:cod
obras.get('/:cod', requirePermisoOr([
  { modulo: 'tarja', accion: 'lectura' },
  { modulo: 'certificaciones', accion: 'lectura' },
]), async (c) => {
  const cod    = c.req.param('cod')
  const token  = c.get('accessToken')
  const userId = c.get('user').id
  try {
    const data = await obrasService.getByCod(cod, token, userId)
    return c.json(data)
  } catch (err: any) {
    if (err?.code === 'OBRA_SIN_ACCESO') return c.json({ error: err.code }, 403)
    throw err
  }
})

// POST /api/obras
obras.post('/', requirePermiso('tarja', 'creacion'), zValidator('json', CreateObraSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.create(dto, token, userId)
  return c.json(data, 201)
})

// PATCH /api/obras/:cod
obras.patch('/:cod', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpdateObraSchema), async (c) => {
  const cod = c.req.param('cod')
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.update(cod, dto, token, userId)
  return c.json(data)
})

// PATCH /api/obras/:cod/archivar
obras.patch('/:cod/archivar', requirePermiso('tarja', 'actualizacion'), async (c) => {
  const cod = c.req.param('cod')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.archivar(cod, token, userId)
  return c.json(data)
})

// PATCH /api/obras/:cod/desarchivar
obras.patch('/:cod/desarchivar', requirePermiso('tarja', 'actualizacion'), async (c) => {
  const cod = c.req.param('cod')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await obrasService.desarchivar(cod, token, userId)
  return c.json(data)
})

// DELETE /api/obras/:cod
obras.delete('/:cod', requirePermiso('tarja', 'eliminacion'), async (c) => {
  const cod = c.req.param('cod')
  const token = c.get('accessToken')
  const data = await obrasService.delete(cod, token)
  return c.json(data)
})

export default obras
