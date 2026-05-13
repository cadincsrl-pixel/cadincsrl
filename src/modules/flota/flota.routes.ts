import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { flotaService } from './flota.service.js'
import { CreateVehiculoSchema, UpdateVehiculoSchema } from './flota.schema.js'
import flotaDocs from './flota-docs.routes.js'
import flotaTipos from './flota-tipos-servicio.routes.js'
import flotaServicios from './flota-servicios.routes.js'
import flotaGpsSync from './gps-sync/flota-gps-sync.routes.js'

const flota = new Hono()
flota.use('*', authMiddleware)

// Sub-router de documentos del vehículo: /api/flota/vehiculos/:id/documentos/...
flota.route('/vehiculos', flotaDocs)
// Catálogo de tipos de servicio: /api/flota/tipos-servicio
flota.route('/tipos-servicio', flotaTipos)
// Servicios de mantenimiento: /api/flota/servicios
flota.route('/servicios', flotaServicios)
// Sync de GPS MobilQuest: /api/flota/gps/...
flota.route('/gps', flotaGpsSync)

// CRUD de vehículos
flota.get(
  '/vehiculos',
  requirePermiso('flota', 'lectura'),
  async (c) => {
    const data = await flotaService.getAll(c.get('accessToken'))
    return c.json(data)
  },
)

flota.get(
  '/vehiculos/:id',
  requirePermiso('flota', 'lectura'),
  async (c) => {
    try {
      const data = await flotaService.getById(Number(c.req.param('id')), c.get('accessToken'))
      return c.json(data)
    } catch (err) {
      if ((err as Error).message === 'VEHICULO_NO_EXISTE') {
        return c.json({ error: 'VEHICULO_NO_EXISTE' }, 404)
      }
      return c.json({ error: (err as Error).message }, 500)
    }
  },
)

flota.post(
  '/vehiculos',
  requirePermiso('flota', 'creacion'),
  zValidator('json', CreateVehiculoSchema),
  async (c) => {
    const data = await flotaService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  },
)

flota.patch(
  '/vehiculos/:id',
  requirePermiso('flota', 'actualizacion'),
  zValidator('json', UpdateVehiculoSchema),
  async (c) => {
    const data = await flotaService.update(
      Number(c.req.param('id')),
      c.req.valid('json'),
      c.get('accessToken'),
      c.get('user').id,
    )
    return c.json(data)
  },
)

flota.delete(
  '/vehiculos/:id',
  requirePermiso('flota', 'eliminacion'),
  async (c) => {
    const data = await flotaService.delete(Number(c.req.param('id')), c.get('accessToken'))
    return c.json(data)
  },
)

// Notificaciones del módulo: papeles con vencimiento (vencidos o por vencer).
// El frontend decide el umbral; acá devolvemos todos los registros con
// vence_el seteado.
flota.get(
  '/notificaciones/documentos',
  requirePermiso('flota', 'lectura'),
  async (c) => {
    const data = await flotaService.getNotificaciones(c.get('accessToken'))
    return c.json(data)
  },
)

export default flota
