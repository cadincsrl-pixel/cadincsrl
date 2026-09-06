import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireTab } from '../../middleware/permission.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario, validarObraDeRegistro, sinObras } from '../../lib/obras-usuario.js'
import { stockClienteService, StockClienteHttpError } from './stock-cliente.service.js'
import {
  ListStockClienteSchema,
  EntradaStockClienteSchema,
  EntradaLoteStockClienteSchema,
  SalidaStockClienteSchema,
} from './stock-cliente.schema.js'

const stockCliente = new Hono()

stockCliente.use('*', authMiddleware)
// Guardia por tab (2026-09-06): la tab de la pantalla también vale en la API. Solicitudes lee el saldo del cliente al resolver un ítem.
stockCliente.on(['GET'], '*', requireTab('certificaciones', ['stock-cliente', 'solicitudes']))
stockCliente.on(['POST', 'PATCH', 'PUT', 'DELETE'], '*', requireTab('certificaciones', 'stock-cliente'))
stockCliente.on(['GET'],  '*', requirePermiso('certificaciones', 'lectura'))
stockCliente.on(['POST'], '*', requirePermiso('certificaciones', 'creacion'))

// Alcance por obra (2026-09-06): el material del cliente es de SU obra.
// Antes cualquier usuario del módulo listaba y movía stock de cualquier obra.
const MODULO = 'certificaciones'

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
    const dto = c.req.valid('query')
    const userId = c.get('user').id
    if (dto.obra_cod) await validarObraDelUsuario(userId, dto.obra_cod, MODULO)
    const allowed = await getObrasDelUsuarioCached(userId, MODULO)
    if (sinObras(allowed)) return c.json([])
    const data = await stockClienteService.list(dto, c.get('accessToken'), allowed)
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Movimientos de un material (entregas y consumos) ──
stockCliente.get('/items/:itemId/movimientos', async (c) => {
  try {
    await validarObraDeRegistro(c.get('user').id, MODULO, 'stock_cliente_items', Number(c.req.param('itemId')))
    const data = await stockClienteService.getMovimientos(Number(c.req.param('itemId')), c.get('accessToken'))
    return c.json(data)
  } catch (err) { return handle(err, c) }
})

// ── Entrega del cliente (entrada al ledger) ──
stockCliente.post('/entrada', zValidator('json', EntradaStockClienteSchema), async (c) => {
  try {
    await validarObraDelUsuario(c.get('user').id, c.req.valid('json').obra_cod, MODULO)
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
      await validarObraDelUsuario(c.get('user').id, c.req.valid('json').obra_cod, MODULO)
      const data = await stockClienteService.entradaLote(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
      return c.json(data, 201)
    } catch (err) { return handle(err, c) }
  },
)

// ── Salida manual (consumo sin solicitud / ajuste / devolución) ──
stockCliente.post('/salida', zValidator('json', SalidaStockClienteSchema), async (c) => {
  try {
    await validarObraDeRegistro(c.get('user').id, MODULO, 'stock_cliente_items', c.req.valid('json').item_id)
    const data = await stockClienteService.salida(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err) { return handle(err, c) }
})

export default stockCliente
