import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { aridosService } from './aridos.service.js'
import { buildEntidadDocsRoutes } from '../documentos/entidad-docs.routes.js'
import { buildServiciosRoutes } from '../servicios/servicios.routes.js'
import { choferesAridosService, ChoferAridosError } from './aridos-choferes.service.js'
import { gastosAridosService, GastoAridosError } from './aridos-gastos.service.js'
import { z as zc } from 'zod'
import {
  CreateMaterialSchema, UpdateMaterialSchema,
  CreateClienteSchema, UpdateClienteSchema,
  CreatePrecioSchema, UpdatePrecioSchema,
  CreateMovimientoSchema, UpdateMovimientoSchema, ListMovimientosQuerySchema,
  CreateCobroSchema, UpdateCobroSchema, CobrosQuerySchema,
  CreateMunicipioSchema, UpdateMunicipioSchema,
  CreateCostoCanteraSchema, UpdateCostoCanteraSchema,
  CreateCanteraSchema, UpdateCanteraSchema,
  CreateUnidadSchema, UpdateUnidadSchema, EtaQuerySchema,
  CreatePagoCanteraSchema, PagosCanteraQuerySchema,
  CreatePrecioGlobalSchema, UpdatePrecioGlobalSchema,
} from './aridos.schema.js'

const aridos = new Hono()
aridos.use('*', authMiddleware)

// Permisos por método sobre todo el módulo (mismo patrón que alquiler):
// GET=lectura, POST=creacion, PATCH/PUT=actualizacion, DELETE=eliminacion.
aridos.on(['GET'],          '*', requirePermiso('aridos', 'lectura'))
aridos.on(['POST'],         '*', requirePermiso('aridos', 'creacion'))
aridos.on(['PATCH', 'PUT'], '*', requirePermiso('aridos', 'actualizacion'))
aridos.on(['DELETE'],       '*', requirePermiso('aridos', 'eliminacion'))

// ── Documentación de la unidad (VTV, RTO, seguro, título…) ────
// Mismo sub-router que camiones, bateas y máquinas de alquiler: hash con dedup,
// bucket privado (aridos-docs) y borrado suave.
aridos.route('/unidades', buildEntidadDocsRoutes('unidad'))
// Services (mantenimientos): mismo molde, montado bajo la misma raíz.
aridos.route('/unidades', buildServiciosRoutes('unidad'))

// ── Choferes del área (padrón propio, jornal por día) ─────────
// Áridos se maneja aparte: estos NO son los choferes de logística ni el
// personal de tarja. Cobran por día trabajado (migración 20260908f).
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/
const CrearChoferSchema = zc.object({
  nombre:       zc.string().trim().min(1),
  dni:          zc.string().trim().nullable().optional(),
  tel:          zc.string().trim().nullable().optional(),
  obs:          zc.string().trim().nullable().optional(),
  jornal:       zc.number().min(0).nullable().optional(),
  jornal_desde: zc.string().regex(FECHA_RE).nullable().optional(),
})
const EditarChoferSchema = CrearChoferSchema.partial().extend({ activo: zc.boolean().optional() })
const JornalSchema = zc.object({
  jornal:        zc.number().min(0),
  vigente_desde: zc.string().regex(FECHA_RE),
  obs:           zc.string().trim().nullable().optional(),
})
const DiaSchema = zc.object({
  chofer_id: zc.number().int().positive(),
  fecha:     zc.string().regex(FECHA_RE),
  unidad_id: zc.number().int().positive().nullable().optional(),
  obs:       zc.string().trim().nullable().optional(),
})

function chofer<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try { return c.json(await fn(c)) } catch (err) {
      if (err instanceof ChoferAridosError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: (err as Error).message ?? 'UNKNOWN' }, 500)
    }
  }
}

aridos.get('/choferes', chofer(c => choferesAridosService.listar(c.get('accessToken'))))

aridos.post('/choferes', zValidator('json', CrearChoferSchema),
  chofer(c => choferesAridosService.crear(c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

aridos.patch('/choferes/:id', zValidator('json', EditarChoferSchema),
  chofer(c => choferesAridosService.editar(Number(c.req.param('id')), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

aridos.get('/choferes/:id/jornales',
  chofer(c => choferesAridosService.jornales(Number(c.req.param('id')), c.get('accessToken'))))

// Cambiar el jornal INSERTA una versión nueva; no pisa la historia.
aridos.post('/choferes/:id/jornales', zValidator('json', JornalSchema),
  chofer(c => choferesAridosService.setJornal(Number(c.req.param('id')), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

// Días trabajados
aridos.get('/chofer-dias', chofer(c => choferesAridosService.dias(
  c.get('accessToken'), c.req.query('desde'), c.req.query('hasta'),
  c.req.query('chofer_id') ? Number(c.req.query('chofer_id')) : undefined)))

aridos.post('/chofer-dias', zValidator('json', DiaSchema),
  chofer(c => choferesAridosService.marcarDia(c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

aridos.delete('/chofer-dias/:id',
  chofer(c => choferesAridosService.borrarDia(Number(c.req.param('id')), c.get('user').id, c.get('accessToken'))))

// Lo que hay que pagar en un mes (YYYY-MM)
aridos.get('/chofer-pago/:mes',
  chofer(c => choferesAridosService.pagoMes(c.req.param('mes'), c.get('accessToken'))))

// ── Gastos del área (combustible, taller, VTV, seguro…) ───────
// Sin workflow de aprobación a propósito: los carga quien tiene los
// comprobantes y el dueño lee el resultado. Ver el encabezado del servicio.
const CargaSchema = zc.object({
  litros:           zc.number().positive(),
  odometro_km:      zc.number().int().min(0).nullable().optional(),
  tipo_combustible: zc.enum(['gasoil', 'nafta']).optional(),
  tanque_lleno:     zc.boolean().optional(),
  obs:              zc.string().trim().nullable().optional(),
})
const CrearGastoSchema = zc.object({
  fecha:            zc.string().regex(FECHA_RE),
  categoria_id:     zc.number().int().positive(),
  unidad_id:        zc.number().int().positive().nullable().optional(),
  monto:            zc.number().positive(),
  descripcion:      zc.string().trim().nullable().optional(),
  proveedor:        zc.string().trim().nullable().optional(),
  metodo_pago:      zc.enum(['efectivo','transferencia','tarjeta','cheque','cta_cte','otro']).nullable().optional(),
  comprobante_nro:  zc.string().trim().nullable().optional(),
  comprobante_path: zc.string().trim().nullable().optional(),
  obs:              zc.string().trim().nullable().optional(),
  carga:            CargaSchema.nullable().optional(),
})
const EditarGastoSchema = CrearGastoSchema.partial().omit({ carga: true })
const ImportarGastosSchema = zc.object({
  dry_run: zc.boolean().optional(),
  filas:   zc.array(CrearGastoSchema).min(1).max(500),
})
const UploadComprobanteSchema = zc.object({
  content_type: zc.enum(['image/jpeg','image/png','image/webp','application/pdf']),
})

function gasto<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try { return c.json(await fn(c)) } catch (err) {
      if (err instanceof GastoAridosError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: (err as Error).message ?? 'UNKNOWN' }, 500)
    }
  }
}

// Estas rutas van ANTES de /gastos/:id: si no, "categorias" o "resultado"
// entran como si fueran un id y el Number() los vuelve NaN.
aridos.get('/gastos/categorias', gasto(c => gastosAridosService.categorias(c.get('accessToken'))))

aridos.get('/gastos/resultado',
  gasto(c => gastosAridosService.resultado(c.get('accessToken'), c.req.query('mes'))))

aridos.get('/gastos/por-categoria',
  gasto(c => gastosAridosService.gastosPorCategoria(c.get('accessToken'), c.req.query('mes'))))

aridos.get('/gastos/combustible', gasto(c => gastosAridosService.cargasCombustible(
  c.get('accessToken'),
  c.req.query('unidad_id') ? Number(c.req.query('unidad_id')) : undefined,
  c.req.query('desde'), c.req.query('hasta'))))

aridos.post('/gastos/upload-comprobante', zValidator('json', UploadComprobanteSchema),
  gasto(c => gastosAridosService.firmarUpload(c.req.valid('json').content_type)))

// El Excel del mes entra entero acá. Con dry_run:true valida sin escribir.
aridos.post('/gastos/importar', zValidator('json', ImportarGastosSchema), gasto(c => {
  const { filas, dry_run } = c.req.valid('json')
  return gastosAridosService.importar(filas, { dry_run }, c.get('accessToken'), c.get('user').id)
}))

aridos.get('/gastos', gasto(c => gastosAridosService.list({
  desde:        c.req.query('desde'),
  hasta:        c.req.query('hasta'),
  mes:          c.req.query('mes'),
  unidad_id:    c.req.query('unidad_id')    ? Number(c.req.query('unidad_id'))    : undefined,
  categoria_id: c.req.query('categoria_id') ? Number(c.req.query('categoria_id')) : undefined,
  sin_unidad:   c.req.query('sin_unidad') === 'true',
  limit:        c.req.query('limit')  ? Number(c.req.query('limit'))  : undefined,
  offset:       c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
}, c.get('accessToken'))))

aridos.get('/gastos/:id', gasto(c => gastosAridosService.getById(Number(c.req.param('id')), c.get('accessToken'))))

aridos.get('/gastos/:id/comprobante-url',
  gasto(c => gastosAridosService.comprobanteUrl(Number(c.req.param('id')), c.get('accessToken'))))

aridos.post('/gastos', zValidator('json', CrearGastoSchema),
  gasto(c => gastosAridosService.create(c.req.valid('json'), c.get('accessToken'), c.get('user').id)))

aridos.patch('/gastos/:id', zValidator('json', EditarGastoSchema),
  gasto(c => gastosAridosService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)))

aridos.delete('/gastos/:id',
  gasto(c => gastosAridosService.softDelete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id)))

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

// ── Lista de precios global ───────────────────────────────────
aridos.get('/precios-global', async (c) => {
  return c.json(await aridosService.getPreciosGlobal(c.get('accessToken')))
})

aridos.post('/precios-global', zValidator('json', CreatePrecioGlobalSchema), async (c) => {
  return c.json(await aridosService.createPrecioGlobal(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/precios-global/:id', zValidator('json', UpdatePrecioGlobalSchema), async (c) => {
  return c.json(await aridosService.updatePrecioGlobal(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/precios-global/:id', async (c) => {
  return c.json(await aridosService.deletePrecioGlobal(Number(c.req.param('id')), c.get('accessToken')))
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

// Emitir (o re-obtener) el remito RV-NNNN de una venta — idempotente.
aridos.post('/movimientos/:id/remito', async (c) => {
  return c.json(await aridosService.emitirRemitoVenta(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id), 201)
})

// ── Canteras propias ──────────────────────────────────────────
aridos.get('/canteras', async (c) => {
  return c.json(await aridosService.getCanteras(c.get('accessToken')))
})

aridos.post('/canteras', zValidator('json', CreateCanteraSchema), async (c) => {
  return c.json(await aridosService.createCantera(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/canteras/:id', zValidator('json', UpdateCanteraSchema), async (c) => {
  return c.json(await aridosService.updateCantera(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/canteras/:id', async (c) => {
  return c.json(await aridosService.deleteCantera(Number(c.req.param('id')), c.get('accessToken')))
})

// ── Unidades (camión + chofer, con GPS) ───────────────────────
// IMPORTANTE: /unidades/:id/eta antes que /unidades/:id genéricas no
// hace falta acá (no hay GET /unidades/:id), pero se deja primero igual.
aridos.get('/unidades/:id/eta', zValidator('query', EtaQuerySchema), async (c) => {
  return c.json(await aridosService.getUnidadEta(Number(c.req.param('id')), c.req.valid('query').direccion, c.get('accessToken')))
})

aridos.get('/gps-catalogo', async (c) => {
  return c.json(await aridosService.getGpsCatalogo())
})

aridos.get('/unidades', async (c) => {
  return c.json(await aridosService.getUnidades(c.get('accessToken')))
})

aridos.post('/unidades', zValidator('json', CreateUnidadSchema), async (c) => {
  return c.json(await aridosService.createUnidad(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.patch('/unidades/:id', zValidator('json', UpdateUnidadSchema), async (c) => {
  return c.json(await aridosService.updateUnidad(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

aridos.delete('/unidades/:id', async (c) => {
  return c.json(await aridosService.deleteUnidad(Number(c.req.param('id')), c.get('accessToken')))
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

// ── Pagos a canteras y cta cte del proveedor ──────────────────
aridos.get('/pagos-cantera', zValidator('query', PagosCanteraQuerySchema), async (c) => {
  return c.json(await aridosService.getPagosCantera(c.req.valid('query'), c.get('accessToken')))
})

aridos.post('/pagos-cantera', zValidator('json', CreatePagoCanteraSchema), async (c) => {
  return c.json(await aridosService.createPagoCantera(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

aridos.delete('/pagos-cantera/:id', async (c) => {
  return c.json(await aridosService.deletePagoCantera(Number(c.req.param('id')), c.get('accessToken')))
})

aridos.get('/cuenta-corriente-canteras', async (c) => {
  return c.json(await aridosService.getCuentaCorrienteCanteras(c.get('accessToken')))
})

export default aridos
