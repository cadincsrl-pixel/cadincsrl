import { Hono } from 'hono'
import { authMiddleware } from '../../middleware/auth.js'
import { auditService } from './audit.service.js'

const admin = new Hono()
admin.use('*', authMiddleware)

// Solo admins
admin.use('*', async (c, next) => {
  const user = c.get('user')
  if (user.rol !== 'admin') {
    return c.json({ error: 'Acceso denegado' }, 403)
  }
  await next()
})

admin.get('/audit', async (c) => {
  const user_id = c.req.query('user_id')
  const modulo = c.req.query('modulo')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const limit = c.req.query('limit')

  const data = await auditService.getAll(c.get('accessToken'), {
    user_id: user_id || undefined,
    modulo: modulo || undefined,
    desde: desde || undefined,
    hasta: hasta || undefined,
    limit: limit ? Number(limit) : undefined,
  })
  return c.json(data)
})

export default admin
