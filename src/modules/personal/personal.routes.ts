import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermisoOr } from '../../middleware/permission.js'
import { personalService } from './personal.service.js'
import { CreatePersonalSchema, UpdatePersonalSchema } from './personal.schema.js'

const personal = new Hono()

personal.use('*', authMiddleware)

personal.get('/', requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]), async (c) => {
  const token = c.get('accessToken')
  const data = await personalService.getAll(token)
  return c.json(data)
})

personal.get('/:leg', requirePermisoOr([{ modulo: 'personal', accion: 'lectura' }, { modulo: 'tarja', accion: 'lectura' }]), async (c) => {
  const leg = c.req.param('leg')
  const token = c.get('accessToken')
  const data = await personalService.getByLeg(leg, token)
  return c.json(data)
})

personal.post('/', requirePermisoOr([{ modulo: 'personal', accion: 'creacion' }, { modulo: 'tarja', accion: 'creacion' }]), zValidator('json', CreatePersonalSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await personalService.create(dto, token, userId)
  return c.json(data, 201)
})

personal.patch('/:leg', requirePermisoOr([{ modulo: 'personal', accion: 'actualizacion' }, { modulo: 'tarja', accion: 'actualizacion' }]), zValidator('json', UpdatePersonalSchema), async (c) => {
  const leg = c.req.param('leg')
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await personalService.update(leg, dto, token, userId)
  return c.json(data)
})

personal.delete('/:leg', requirePermisoOr([{ modulo: 'personal', accion: 'eliminacion' }, { modulo: 'tarja', accion: 'eliminacion' }]), async (c) => {
  const leg = c.req.param('leg')
  const token = c.get('accessToken')
  const data = await personalService.delete(leg, token)
  return c.json(data)
})

export default personal
