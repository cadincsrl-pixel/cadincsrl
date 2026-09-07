import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { prestamosService } from './prestamos.service.js'
import { CreatePrestamoSchema } from './prestamos.schema.js'

// Préstamos es un tab de tarja (CLAUDE.md §4, §5.5) → permisos vía 'tarja.*'.
const prestamos = new Hono()
prestamos.use('*', authMiddleware)
prestamos.on(['POST'],   '*', requirePermiso('tarja', 'creacion'))
prestamos.on(['DELETE'], '*', requirePermiso('tarja', 'eliminacion'))

// GET /api/prestamos?legs=001,002&sem_key=&desde=&hasta= — todos los
// movimientos (o los de esos legajos / esa semana / ese rango de semanas).
// Desde 2026-09-07 la lectura también pasa por acá: antes el front leía la
// tabla con la anon key, sin paginar.
prestamos.get('/', requirePermiso('tarja', 'lectura'), async (c) => {
  const legsParam = c.req.query('legs')
  const legs = legsParam === undefined ? undefined : legsParam.split(',').map(s => s.trim()).filter(Boolean)
  const data = await prestamosService.list({
    legs,
    semKey: c.req.query('sem_key'),
    desde:  c.req.query('desde'),
    hasta:  c.req.query('hasta'),
  })
  return c.json(data)
})

prestamos.post('/', zValidator('json', CreatePrestamoSchema), async (c) => {
  const data = await prestamosService.create(
    c.req.valid('json'),
    c.get('accessToken'),
    c.get('user').id,
  )
  return c.json(data, 201)
})

prestamos.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'ID_INVALIDO' }, 400)
  const data = await prestamosService.delete(id, c.get('accessToken'))
  return c.json(data)
})

export default prestamos
