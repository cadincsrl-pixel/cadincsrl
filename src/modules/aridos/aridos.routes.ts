import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { aridosService } from './aridos.service.js'
import {
  CreateMaterialSchema, UpdateMaterialSchema,
  CreateClienteSchema, UpdateClienteSchema,
  CreatePrecioSchema, UpdatePrecioSchema,
  CreateMovimientoSchema, UpdateMovimientoSchema, ListMovimientosQuerySchema,
  CreateCobroSchema, UpdateCobroSchema, CobrosQuerySchema,
  CreateMunicipioSchema, UpdateMunicipioSchema,
  CreateCostoCanteraSchema, UpdateCostoCanteraSchema,
} from './aridos.schema.js'

const aridos = new Hono()
aridos.use('*', authMiddleware)

// Permisos por método sobre todo el módulo (mismo patrón que alquiler):
// GET=lectura, POST=creacion, PATCH/PUT=actualizacion, DELETE=eliminacion.
aridos.on(['GET'],          '*', requirePermiso('aridos', 'lectura'))
aridos.on(['POST'],         '*', requirePermiso('aridos', 'creacion'))
aridos.on(['PATCH', 'PUT'], '*', requirePermiso('aridos', 'actualizacion'))
aridos.on(['DELETE'],       '*', requirePermiso('aridos', 'eliminacion'))

// ── Materiales ────────────────────────────────────────────────
aridos.get('/materiales', async (c) => {
  return c.json(await aridosService.getMateriales(c.get('accessToken')))
})

aridos.post('/materiales', zValidator('json', CreateMaterialSchema), async (c) => {
  return c.json(await aridosService.createMaterial(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/materiales/:id', zValidator('json', UpdateMaterialSchema), async (c) => {
  return c.json(await aridosService.updateMaterial(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/materiales/:id', async (c) => {
  return c.json(await aridosService.deleteMaterial(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Clientes ──────────────────────────────────────────────────
aridos.get('/clientes', async (c) => {
  return c.json(await aridosService.getClientes(c.get('accessToken')))
})

aridos.post('/clientes', zValidator('json', CreateClienteSchema), async (c) => {
  return c.json(await aridosService.createCliente(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/clientes/:id', zValidator('json', UpdateClienteSchema), async (c) => {
  return c.json(await aridosService.updateCliente(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/clientes/:id', async (c) => {
  return c.json(await aridosService.deleteCliente(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Precios por cliente × material ────────────────────────────
aridos.get('/precios', async (c) => {
  return c.json(await aridosService.getPrecios(c.get('accessToken')))
})

aridos.post('/precios', zValidator('json', CreatePrecioSchema), async (c) => {
  return c.json(await aridosService.createPrecio(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/precios/:id', zValidator('json', UpdatePrecioSchema), async (c) => {
  return c.json(await aridosService.updatePrecio(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/precios/:id', async (c) => {
  return c.json(await aridosService.deletePrecio(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Movimientos (ventas / acopios / ajustes) ──────────────────
aridos.get('/movimientos', zValidator('query', ListMovimientosQuerySchema), async (c) => {
  return c.json(await aridosService.getMovimientos(c.req.valid('query'), c.get('accessToken')))
})

aridos.post('/movimientos', zValidator('json', CreateMovimientoSchema), async (c) => {
  return c.json(await aridosService.createMovimiento(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/movimientos/:id', zValidator('json', UpdateMovimientoSchema), async (c) => {
  return c.json(await aridosService.updateMovimiento(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/movimientos/:id', async (c) => {
  return c.json(await aridosService.deleteMovimiento(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Municipios (zonas de entrega con recargo %) ───────────────
aridos.get('/municipios', async (c) => {
  return c.json(await aridosService.getMunicipios(c.get('accessToken')))
})

aridos.post('/municipios', zValidator('json', CreateMunicipioSchema), async (c) => {
  return c.json(await aridosService.createMunicipio(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/municipios/:id', zValidator('json', UpdateMunicipioSchema), async (c) => {
  return c.json(await aridosService.updateMunicipio(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/municipios/:id', async (c) => {
  return c.json(await aridosService.deleteMunicipio(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Costos de compra por cantera × material ───────────────────
aridos.get('/costos-cantera', async (c) => {
  return c.json(await aridosService.getCostosCantera(c.get('accessToken')))
})

aridos.post('/costos-cantera', zValidator('json', CreateCostoCanteraSchema), async (c) => {
  return c.json(await aridosService.createCostoCantera(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/costos-cantera/:id', zValidator('json', UpdateCostoCanteraSchema), async (c) => {
  return c.json(await aridosService.updateCostoCantera(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/costos-cantera/:id', async (c) => {
  return c.json(await aridosService.deleteCostoCantera(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Stock del depósito ────────────────────────────────────────
aridos.get('/stock', async (c) => {
  return c.json(await aridosService.getStock(c.get('accessToken')))
})

// ── Cobros y cuenta corriente ─────────────────────────────────
aridos.get('/cobros', zValidator('query', CobrosQuerySchema), async (c) => {
  return c.json(await aridosService.getCobros(c.req.valid('query'), c.get('accessToken')))
})

aridos.post('/cobros', zValidator('json', CreateCobroSchema), async (c) => {
  return c.json(await aridosService.createCobro(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/cobros/:id', zValidator('json', UpdateCobroSchema), async (c) => {
  return c.json(await aridosService.updateCobro(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/cobros/:id', async (c) => {
  return c.json(await aridosService.deleteCobro(Number(c.req.param('id')), c.get('accessToken')))
})

aridos.get('/cuenta-corriente', async (c) => {
  return c.json(await aridosService.getCuentaCorriente(c.get('accessToken')))
})

export default aridos
