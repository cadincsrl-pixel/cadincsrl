import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario, validarObraDeRegistro, sinObras } from '../../lib/obras-usuario.js'
import { stockProveedorService, StockProvHttpError } from './stock-proveedor.service.js'
import {
  ListStockSchema,
  CrearRemitoRetiroSchema,
  UploadComprobanteSchema,
} from './stock-proveedor.schema.js'

const stockProv = new Hono()

stockProv.use('*', authMiddleware)
stockProv.on(['GET'],          '*', requirePermiso('certificaciones', 'lectura'))
stockProv.on(['POST'],         '*', requirePermiso('certificaciones', 'creacion'))

// Alcance por obra (2026-09-06): lo comprado para una obra lo ve y lo retira
// esa obra. Antes cualquier usuario del módulo podía retirar stock de otra.
const MODULO = 'certificaciones'

function handle(err: unknown, c: any) {
  if (err instanceof StockProvHttpError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// ── Listado de stock pendiente en proveedores ──
stockProv.get('/', zValidator('query', ListStockSchema), async (c) => {
  try {
    const dto = c.req.valid('query')
    const userId = c.get('user').id
    if (dto.obra_cod) await validarObraDelUsuario(userId, dto.obra_cod, MODULO)
    const allowed = await getObrasDelUsuarioCached(userId, MODULO)
    if (sinObras(allowed)) return c.json([])
    const data = await stockProveedorService.list(dto, c.get('accessToken'), allowed)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Movimientos de un item específico (entradas/salidas) ──
stockProv.get('/items/:itemId/movimientos', async (c) => {
  try {
    await validarObraDeRegistro(c.get('user').id, MODULO, 'solicitud_compra_item', Number(c.req.param('itemId')), { viaSolicitud: true })
    const data = await stockProveedorService.getMovimientos(Number(c.req.param('itemId')), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Listado de remitos de retiro hechos ──
stockProv.get('/remitos', async (c) => {
  try {
    const proveedor_id = c.req.query('proveedor_id') ? Number(c.req.query('proveedor_id')) : undefined
    const obra_cod     = c.req.query('obra_cod') ?? undefined
    const userId = c.get('user').id
    if (obra_cod) await validarObraDelUsuario(userId, obra_cod, MODULO)
    const allowed = await getObrasDelUsuarioCached(userId, MODULO)
    if (sinObras(allowed)) return c.json([])
    const data = await stockProveedorService.listRemitos({ proveedor_id, obra_cod }, c.get('accessToken'), allowed)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── URL firmada para descargar el comprobante de un remito ──
stockProv.get('/remitos/:id/comprobante-url', async (c) => {
  try {
    await validarObraDeRegistro(c.get('user').id, MODULO, 'remitos_retiro_proveedor', Number(c.req.param('id')))
    const data = await stockProveedorService.getComprobanteUrl(Number(c.req.param('id')), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── URL firmada para subir un comprobante (paso 1 del upload) ──
stockProv.post('/upload-comprobante', zValidator('json', UploadComprobanteSchema), async (c) => {
  try {
    const dto = c.req.valid('json')
    const data = await stockProveedorService.firmarUploadComprobante(dto.content_type)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Crear remito de retiro (la operación principal: dispara la RPC) ──
stockProv.post('/retirar', zValidator('json', CrearRemitoRetiroSchema), async (c) => {
  try {
    await validarObraDelUsuario(c.get('user').id, c.req.valid('json').obra_cod, MODULO)
    const data = await stockProveedorService.crearRemitoRetiro(
      c.req.valid('json'), c.get('accessToken'), c.get('user').id,
    )
    return c.json(data, 201)
  } catch (err) { return handle(err, c) }
})

export default stockProv
