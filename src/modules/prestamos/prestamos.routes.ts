import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { prestamosService } from './prestamos.service.js'
import { CreatePrestamoSchema } from './prestamos.schema.js'

// Préstamos es un tab de tarja (CLAUDE.md §4, §5.5) → permisos vía 'tarja.*'.
// El GET no vive acá: los hooks del front leen vía Supabase directamente
// (lectura con anon es OK porque la data es propia del usuario logueado en
// el modelo permisivo RLS, y no es PII). Lo que NO va por anon es mutar.
const prestamos = new Hono()
prestamos.use('*', authMiddleware)
prestamos.on(['POST'],   '*', requirePermiso('tarja', 'creacion'))
prestamos.on(['DELETE'], '*', requirePermiso('tarja', 'eliminacion'))

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
