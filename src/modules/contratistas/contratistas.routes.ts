import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { contratistasService } from './contratistas.service.js'
import {
  CreateContratistaSchema,
  UpdateContratistaSchema,
  AsigContratistaSchema,
  CertificacionSchema,
} from './contratistas.schema.js'

const contratistas = new Hono()

contratistas.use('*', authMiddleware)

// ── CRUD Contratistas ──
contratistas.get('/', async (c) => {
  const token = c.get('accessToken')
  const data = await contratistasService.getAll(token)
  return c.json(data)
})

contratistas.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await contratistasService.getById(id, token)
  return c.json(data)
})

contratistas.post('/', zValidator('json', CreateContratistaSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await contratistasService.create(dto, token)
  return c.json(data, 201)
})

contratistas.patch('/:id', zValidator('json', UpdateContratistaSchema), async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await contratistasService.update(id, dto, token)
  return c.json(data)
})

contratistas.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await contratistasService.delete(id, token)
  return c.json(data)
})

// ── Asignaciones a obras ──
contratistas.get('/asig/:obraCod', async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const data = await contratistasService.getAsigByObra(obraCod, token)
  return c.json(data)
})

contratistas.post('/asig', zValidator('json', AsigContratistaSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await contratistasService.asignar(dto, token)
  return c.json(data, 201)
})

contratistas.delete('/asig/:obraCod/:contratId', async (c) => {
  const obraCod = c.req.param('obraCod')
  const contratId = Number(c.req.param('contratId'))
  if (isNaN(contratId)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await contratistasService.desasignar(obraCod, contratId, token)
  return c.json(data)
})

// ── Certificaciones ──
contratistas.get('/cert/:obraCod', async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const data = await contratistasService.getCertByObra(obraCod, token)
  return c.json(data)
})

contratistas.put('/cert', zValidator('json', CertificacionSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await contratistasService.upsertCert(dto, token)
  return c.json(data)
})

export default contratistas