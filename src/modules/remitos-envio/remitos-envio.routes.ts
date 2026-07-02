import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import { remitosEnvioService } from './remitos-envio.service.js'
import { CreateRemitoEnvioSchema } from './remitos-envio.schema.js'

const remitosEnvio = new Hono()
remitosEnvio.use('*', authMiddleware)
remitosEnvio.on(['GET'],  '*', requirePermiso('certificaciones', 'lectura'))
remitosEnvio.on(['POST'], '*', requirePermiso('certificaciones', 'creacion'))

// Guard: crear un remito de envío marca ítems como 'enviado' (y puede
// ingresar stock a depósito) → es una acción de resolución, no del jefe de
// obra. Espeja los guards de POST /api/solicitudes/items/:id/enviar
// (requireResolverItems + requireItemObraScope). Sin esto, cualquiera con
// certificaciones.creacion podía transicionar ítems de CUALQUIER obra vía
// este endpoint, salteando el flag resolver_items y el obra-scope.
async function requireRemitoObraScope(c: any, next: any) {
  const allowed = await getObrasDelUsuarioCached(c.get('user').id, 'certificaciones')
  if (allowed != null) {
    const dto = c.req.valid('json')
    if (!allowed.includes(dto.obra_cod)) {
      return c.json({ error: 'OBRA_SIN_ACCESO' }, 403)
    }
    // Cada ítem a enviar debe pertenecer a una solicitud de la MISMA obra
    // del remito (el frontend arma un remito por solicitud). Bloquea enviar
    // ítems de otra obra bajo un remito de una obra propia.
    if (dto.enviar_items && dto.enviar_items.length > 0) {
      const { data, error } = await supabase
        .from('solicitud_compra_item')
        .select('id, solicitud_compra(obra_cod)')
        .in('id', dto.enviar_items)
      if (error) return c.json({ error: error.message }, 500)
      const rows = data ?? []
      const todosDeLaObra =
        rows.length === dto.enviar_items.length &&
        rows.every((it: any) => it.solicitud_compra?.obra_cod === dto.obra_cod)
      if (!todosDeLaObra) {
        return c.json({ error: 'OBRA_SIN_ACCESO' }, 403)
      }
    }
  }
  await next()
}

remitosEnvio.get('/', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return c.json(await remitosEnvioService.getAll(c.get('accessToken'), obra_cod || undefined))
})

remitosEnvio.get('/:id', async (c) => {
  return c.json(await remitosEnvioService.getById(Number(c.req.param('id')), c.get('accessToken')))
})

remitosEnvio.post(
  '/',
  requireFlag('certificaciones', 'resolver_items'),
  zValidator('json', CreateRemitoEnvioSchema),
  requireRemitoObraScope,
  async (c) => {
    try {
      const data = await remitosEnvioService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
      return c.json(data, 201)
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  },
)

export default remitosEnvio
