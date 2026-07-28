import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { empresasService } from './empresas.service.js'
import {
  CreateEmpresaSchema, UpdateEmpresaSchema, CreateTarifaEmpresaSchema,
  UpdateTarifaEmpresaSchema, DeleteTarifaEmpresaSchema,
} from './empresas.schema.js'

const empresas = new Hono()
empresas.use('*', authMiddleware)
empresas.on(['GET'],           '*', requirePermiso('logistica', 'lectura'))
empresas.on(['POST', 'PATCH'], '*', requirePermiso('logistica', 'actualizacion'))
empresas.on(['DELETE'],        '*', requirePermiso('logistica', 'eliminacion'))

// ── Empresas ──
empresas.get('/', async (c) => {
  const data = await empresasService.getAll(c.get('accessToken'))
  return c.json(data)
})

empresas.post('/', zValidator('json', CreateEmpresaSchema), async (c) => {
  const data = await empresasService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
})

empresas.patch('/:id', zValidator('json', UpdateEmpresaSchema), async (c) => {
  const data = await empresasService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

empresas.delete('/:id', async (c) => {
  const data = await empresasService.delete(Number(c.req.param('id')), c.get('accessToken'))
  return c.json(data)
})

// ── Tarifas empresa × cantera ──
empresas.get('/tarifas', async (c) => {
  const data = await empresasService.getTarifas(c.get('accessToken'))
  return c.json(data)
})


empresas.post('/tarifas', zValidator('json', CreateTarifaEmpresaSchema), async (c) => {
  try {
    const data = await empresasService.createTarifa(c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err) {
    // Un alta con vigencia retroactiva también puede devolver 409
    // TARIFA_YA_FACTURADA (detail.operacion = 'crear').
    return errorTarifa(c, err)
  }
})

// Tocar (o borrar) una tarifa con la que ya se facturó devuelve 409
// TARIFA_YA_FACTURADA + detail { operacion, cantidad, facturas, viajes,
// valor_actual, valor_nuevo, vigente_desde_actual, vigente_desde_nuevo }.
// El front ofrece crear una versión nueva o, si fue un error de tipeo,
// reintentar con `confirmar_pisar_historico: true`.
// Lo que no reconocemos se re-lanza a propósito: el `app.onError` de index.ts
// es el que loguea el stack. Devolverlo acá como 500 pelado nos dejaba a
// oscuras cuando fallaba de verdad.
function errorTarifa(c: Context, err: unknown) {
  const e = err as Error & { code?: string; detail?: unknown }
  if (e.code === 'TARIFA_NO_EXISTE')    return c.json({ error: e.code, message: e.message }, 404)
  if (e.code === 'TARIFA_YA_FACTURADA') return c.json({ error: e.code, message: e.message, detail: e.detail }, 409)
  throw err
}

empresas.patch('/tarifas/:id', zValidator('json', UpdateTarifaEmpresaSchema), async (c) => {
  try {
    const data = await empresasService.updateTarifa(
      Number(c.req.param('id')),
      c.req.valid('json'),
      c.get('accessToken'),
      c.get('user').id,
    )
    return c.json(data)
  } catch (err) {
    return errorTarifa(c, err)
  }
})

// El DELETE lleva body OPCIONAL ({ confirmar_pisar_historico }). No usamos
// zValidator porque el caso normal es sin body y el validator exige JSON.
empresas.delete('/tarifas/:id', async (c) => {
  const crudo = await c.req.json().catch(() => ({}))
  const dto   = DeleteTarifaEmpresaSchema.safeParse(crudo)
  try {
    const data = await empresasService.deleteTarifa(
      Number(c.req.param('id')),
      dto.success ? dto.data : {},
      c.get('accessToken'),
    )
    return c.json(data)
  } catch (err) {
    return errorTarifa(c, err)
  }
})

export default empresas
