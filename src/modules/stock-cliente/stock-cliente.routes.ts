import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { stockClienteService, StockClienteHttpError } from './stock-cliente.service.js'
import {
  ListStockClienteSchema,
  EntradaStockClienteSchema,
  EntradaLoteStockClienteSchema,
  SalidaStockClienteSchema,
} from './stock-cliente.schema.js'

const stockCliente = new Hono()

stockCliente.use('*', authMiddleware)
stockCliente.on(['GET'],  '*', requirePermiso('certificaciones', 'lectura'))
stockCliente.on(['POST'], '*', requirePermiso('certificaciones', 'creacion'))

function handle(err: unknown, c: any) {
  if (err instanceof StockClienteHttpError) {
    const body: Record<string, unknown> = { error: err.code }
    if (err.detail !== undefined) body.detail = err.detail
    return c.json(body, err.status as any)
  }
  throw err
}

// ── Saldo por material (filtrable por obra) ──
stockCliente.get('/', zValidator('query', ListStockClienteSchema), async (c) => {
  try {
    const data = await stockClienteService.list(c.req.valid('query'), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Movimientos de un material (entregas y consumos) ──
stockCliente.get('/items/:itemId/movimientos', async (c) => {
  try {
    const data = await stockClienteService.getMovimientos(Number(c.req.param('itemId')), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Entrega del cliente (entrada al ledger) ──
stockCliente.post('/entrada', zValidator('json', EntradaStockClienteSchema), async (c) => {
  try {
    const data = await stockClienteService.entrada(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err) { return handle(err, c) }
})

// ── Entrega del cliente en lote (varios materiales de una misma factura/remito) ──
stockCliente.post(
  '/entrada-lote',
  // El superRefine del schema marca descripciones repetidas con message
  // 'MATERIAL_DUPLICADO'; el hook lo mapea al shape { error: CODE } que espera
  // el frontend (el default del zValidator devolvería el ZodError crudo).
  zValidator('json', EntradaLoteStockClienteSchema, (result, c) => {
    if (!result.success) {
      const dup = result.error.issues.some((i) => i.message === 'MATERIAL_DUPLICADO')
      if (dup) return c.json({ error: 'MATERIAL_DUPLICADO' }, 400)
    }
  }),
  async (c) => {
    try {
      const data = await stockClienteService.entradaLote(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
      return c.json(data, 201)
    } catch (err) { return handle(err, c) }
  },
)

// ── Salida manual (consumo sin solicitud / ajuste / devolución) ──
stockCliente.post('/salida', zValidator('json', SalidaStockClienteSchema), async (c) => {
  try {
    const data = await stockClienteService.salida(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err) { return handle(err, c) }
})

export default stockCliente
