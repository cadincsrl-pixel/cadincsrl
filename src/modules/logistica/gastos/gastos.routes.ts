import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { gastosService, HttpError } from './gastos.service.js'
import {
  CreateGastoSchema, UpdateGastoSchema, RechazarGastoSchema,
  ListGastosQuerySchema, UploadComprobanteSchema, ReporteRangoQuerySchema,
} from './gastos.schema.js'
import { combustibleService } from './combustible.service.js'
import {
  ListCargasQuerySchema, ConsumoCamionQuerySchema,
  ConsumoChoferMesQuerySchema, RankingChoferesQuerySchema,
} from './combustible.schema.js'

const gastos = new Hono()

gastos.use('*', authMiddleware)
gastos.on(['GET'],           '*', requirePermiso('logistica', 'lectura'))
gastos.on(['POST'],          '*', requirePermiso('logistica', 'creacion'))
gastos.on(['PATCH', 'PUT'],  '*', requirePermiso('logistica', 'actualizacion'))
gastos.on(['DELETE'],        '*', requirePermiso('logistica', 'eliminacion'))

// Wrapper de error → respeta HttpError con status/code/detail.
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err: any) {
      if (err instanceof HttpError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: err.message ?? 'UNKNOWN' }, 500)
    }
  }
}

// ── Catálogo de categorías ─────────────────────────────────────
gastos.get('/categorias', handler(async (c) => {
  return gastosService.listCategorias(c.get('accessToken'))
}))

// ── Upload/Download de comprobantes ────────────────────────────
gastos.post('/upload-comprobante',
  zValidator('json', UploadComprobanteSchema),
  handler(async (c) => {
    return gastosService.firmarUploadComprobante(c.req.valid('json'), c.get('user').id)
  }),
)

gastos.get('/:id/comprobante-url', handler(async (c) => {
  return gastosService.getComprobanteUrl(Number(c.req.param('id')), c.get('accessToken'))
}))

// ── Reportes agregados ─────────────────────────────────────────
// IMPORTANTE: estas rutas van ANTES de /:id para que /reportes/X no sea
// capturado como parámetro id.
gastos.get('/reportes/resumen',
  zValidator('query', ReporteRangoQuerySchema),
  handler(async (c) => {
    const { desde, hasta } = c.req.valid('query')
    return gastosService.reporteResumen(desde, hasta, c.get('accessToken'))
  }),
)

gastos.get('/reportes/por-camion',
  zValidator('query', ReporteRangoQuerySchema),
  handler(async (c) => {
    const { desde, hasta } = c.req.valid('query')
    return gastosService.reportePorCamion(desde, hasta, c.get('accessToken'))
  }),
)

gastos.get('/reportes/por-chofer',
  zValidator('query', ReporteRangoQuerySchema),
  handler(async (c) => {
    const { desde, hasta } = c.req.valid('query')
    return gastosService.reportePorChofer(desde, hasta, c.get('accessToken'))
  }),
)

gastos.get('/reportes/por-categoria',
  zValidator('query', ReporteRangoQuerySchema),
  handler(async (c) => {
    const { desde, hasta } = c.req.valid('query')
    return gastosService.reportePorCategoria(desde, hasta, c.get('accessToken'))
  }),
)

// ── Submódulo combustible ──────────────────────────────────────
// Los reportes de consumo son info gerencial. El middleware global
// ya aplica requirePermiso('logistica','lectura'), pero hacemos el
// gateo extra: solo usuarios con 'actualizacion' ven rankings entre
// choferes (defensa server-side, no confiar solo en el frontend).
gastos.get('/reportes/consumo-camion',
  requirePermiso('logistica', 'actualizacion'),
  zValidator('query', ConsumoCamionQuerySchema),
  handler(async (c) => {
    return combustibleService.consumoCamion(c.req.valid('query'), c.get('accessToken'))
  }),
)

gastos.get('/reportes/consumo-chofer-mes',
  requirePermiso('logistica', 'actualizacion'),
  zValidator('query', ConsumoChoferMesQuerySchema),
  handler(async (c) => {
    return combustibleService.consumoChoferMes(c.req.valid('query'), c.get('accessToken'))
  }),
)

gastos.get('/reportes/ranking-choferes',
  requirePermiso('logistica', 'actualizacion'),
  zValidator('query', RankingChoferesQuerySchema),
  handler(async (c) => {
    return combustibleService.rankingChoferes(c.req.valid('query'), c.get('accessToken'))
  }),
)

gastos.get('/combustible',
  zValidator('query', ListCargasQuerySchema),
  handler(async (c) => {
    return combustibleService.listCargas(c.req.valid('query'), c.get('accessToken'))
  }),
)

// ── Reintegros pendientes (usado por liquidaciones) ────────────
// IMPORTANTE: esta ruta debe ir ANTES de /:id para evitar que el
// segmento "reintegros-pendientes" sea capturado como parámetro id.
gastos.get('/reintegros-pendientes', handler(async (c) => {
  const chofer_id = Number(c.req.query('chofer_id'))
  if (!chofer_id) throw new HttpError(400, 'CHOFER_ID_REQUERIDO')
  const hasta = c.req.query('hasta') || undefined
  return gastosService.getReintegrosPendientes(chofer_id, hasta, c.get('accessToken'))
}))

// ── CRUD + workflow ────────────────────────────────────────────
gastos.get('/', zValidator('query', ListGastosQuerySchema), handler(async (c) => {
  return gastosService.list(c.req.valid('query'), c.get('accessToken'))
}))

gastos.get('/:id', handler(async (c) => {
  return gastosService.getById(Number(c.req.param('id')), c.get('accessToken'))
}))

gastos.post('/', zValidator('json', CreateGastoSchema), handler(async (c) => {
  return gastosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
}))

gastos.patch('/:id', zValidator('json', UpdateGastoSchema), handler(async (c) => {
  return gastosService.update(
    Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id,
  )
}))

gastos.delete('/:id', handler(async (c) => {
  return gastosService.softDelete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
}))

gastos.post('/:id/aprobar', handler(async (c) => {
  return gastosService.aprobar(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)
}))

gastos.post('/:id/rechazar',
  zValidator('json', RechazarGastoSchema),
  handler(async (c) => {
    return gastosService.rechazar(
      Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
  }),
)

gastos.post('/:id/marcar-pagado', handler(async (c) => {
  return gastosService.marcarPagado(
    Number(c.req.param('id')), c.get('accessToken'), c.get('user').id,
  )
}))

export default gastos
