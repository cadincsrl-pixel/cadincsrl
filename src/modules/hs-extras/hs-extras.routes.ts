import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { hsExtrasService } from './hs-extras.service.js'
import { UpsertHsExtraSchema, UpsertHsExtrasLoteSchema } from './hs-extras.schema.js'

const hsExtras = new Hono()

hsExtras.use('*', authMiddleware)

// GET /api/hs-extras/all — todas las hs extras (vistas globales).
// Debe declararse ANTES de /:obra_cod para que Hono no lo matchee como "obra_cod='all'".
hsExtras.get('/all', requirePermiso('horas', 'lectura'), async (c) => {
  const token = c.get('accessToken')
  const data = await hsExtrasService.getAll(token)
  return c.json(data)
})

// GET /api/hs-extras/:obra_cod?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
hsExtras.get('/:obra_cod', requirePermiso('horas', 'lectura'), async (c) => {
  const obraCod = c.req.param('obra_cod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')

  const data = await hsExtrasService.getByObra(obraCod, desde, hasta, token)
  return c.json(data)
})

// PUT /api/hs-extras — upsert individual
// IMPORTANTE: /lote debe declararse ANTES de este handler para que Hono no lo
// resuelva con este y devuelva 400 de zod (body distinto). Lo cumple el orden abajo.
hsExtras.put(
  '/lote',
  requirePermiso('horas', 'actualizacion'),
  zValidator('json', UpsertHsExtrasLoteSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await hsExtrasService.upsertLote(dto, token, userId)
    return c.json(data)
  },
)

hsExtras.put(
  '/',
  requirePermiso('horas', 'actualizacion'),
  zValidator('json', UpsertHsExtraSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await hsExtrasService.upsert(dto, token, userId)
    return c.json(data)
  },
)

// DELETE /api/hs-extras/:id
hsExtras.delete('/:id', requirePermiso('horas', 'eliminacion'), async (c) => {
  const idParam = c.req.param('id')
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'id inválido' }, 400)
  }
  const token = c.get('accessToken')
  const data = await hsExtrasService.deleteById(id, token)
  return c.json(data)
})

export default hsExtras
