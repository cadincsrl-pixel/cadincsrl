import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { empresasService } from './empresas.service.js'
import { CreateEmpresaSchema, UpdateEmpresaSchema, CreateTarifaEmpresaSchema, UpdateTarifaEmpresaSchema } from './empresas.schema.js'

const empresas = new Hono()
empresas.use('*', authMiddleware)
empresas.on(['GET'],           '*', requirePermiso('logistica', 'lectura'))
empresas.on(['POST', 'PATCH'], '*', requirePermiso('logistica', 'actualizacion'))
empresas.on(['DELETE'],        '*', requirePermiso('logistica', 'eliminacion'))

// ── Empresas ──
empresas.get('/', async (c) => {
  const data = await empresasService.getAll(c.get('accessToken'))
  return c.json(data)
})

empresas.post('/', zValidator('json', CreateEmpresaSchema), async (c) => {
  const data = await empresasService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

empresas.patch('/:id', zValidator('json', UpdateEmpresaSchema), async (c) => {
  const data = await empresasService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

empresas.delete('/:id', async (c) => {
  const data = await empresasService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

// ── Tarifas empresa × cantera ──
empresas.get('/tarifas', async (c) => {
  const data = await empresasService.getTarifas(c.get('accessToken'))
  return c.json(data)
})


empresas.post('/tarifas', zValidator('json', CreateTarifaEmpresaSchema), async (c) => {
  const data = await empresasService.createTarifa(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

empresas.patch('/tarifas/:id', zValidator('json', UpdateTarifaEmpresaSchema), async (c) => {
  const data = await empresasService.updateTarifa(
    Number(c.req.param('id')),
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data)
})

empresas.delete('/tarifas/:id', async (c) => {
  const data = await empresasService.deleteTarifa(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

export default empresas
