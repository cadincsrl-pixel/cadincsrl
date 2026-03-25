import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { horasService } from './horas.service.js'
import { UpsertHoraSchema, UpsertHorasLoteSchema } from './horas.schema.js'

const horas = new Hono()

horas.use('*', authMiddleware)

// GET /api/horas/:obraCod?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
horas.get('/:obraCod', async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')

  if (desde && hasta) {
    const data = await horasService.getBySemana(obraCod, desde, hasta, token)
    return c.json(data)
  }

  const data = await horasService.getByObra(obraCod, token)
  return c.json(data)
})

// PUT /api/horas — upsert individual
horas.put('/', zValidator('json', UpsertHoraSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await horasService.upsert(dto, token)
  return c.json(data)
})

// PUT /api/horas/lote — upsert en lote
horas.put('/lote', zValidator('json', UpsertHorasLoteSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const data = await horasService.upsertLote(dto, token)
  return c.json(data)
})

// DELETE /api/horas/:obraCod/semana?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
horas.delete('/:obraCod/semana', async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  if (!desde || !hasta) return c.json({ error: 'Faltan parámetros desde/hasta' }, 400)
  const token = c.get('accessToken')
  const data = await horasService.limpiarSemana(obraCod, desde, hasta, token)
  return c.json(data)
})

export default horas