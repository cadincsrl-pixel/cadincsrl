import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { alquilerService } from './alquiler.service.js'
import {
  CreateMaquinaSchema,
  UpdateMaquinaSchema,
  CreateClienteSchema,
  UpdateClienteSchema,
  CreateObraSchema,
  UpdateObraSchema,
  CreateObraMaquinaSchema,
  UpdateObraMaquinaSchema,
  CreateParteSchema,
  UpdateParteSchema,
  ListPartesQuerySchema,
  ListRemitosQuerySchema,
  ReporteHorasQuerySchema,
  CuentaCorrienteQuerySchema,
  CreateCobroSchema,
  UpdateCobroSchema,
  CobrosQuerySchema,
  SeguroUploadUrlSchema,
  SeguroRegistrarSchema,
} from './alquiler.schema.js'

const alquiler = new Hono()
alquiler.use('*', authMiddleware)

// Permisos por método sobre todo el módulo. Cada ruta hereda el gate
// correspondiente (GET=lectura, POST=creacion, PATCH/PUT=actualizacion,
// DELETE=eliminacion). Mismo patrón que lugares.routes.ts.
alquiler.on(['GET'],          '*', requirePermiso('alquiler', 'lectura'))
alquiler.on(['POST'],         '*', requirePermiso('alquiler', 'creacion'))
alquiler.on(['PATCH', 'PUT'], '*', requirePermiso('alquiler', 'actualizacion'))
alquiler.on(['DELETE'],       '*', requirePermiso('alquiler', 'eliminacion'))

// ── Máquinas ──────────────────────────────────────────────────
alquiler.get('/maquinas', async (c) => {
  return c.json(await alquilerService.getMaquinas(c.get('accessToken'), c.get('user').id))
})

alquiler.post('/maquinas', zValidator('json', CreateMaquinaSchema), async (c) => {
  return c.json(await alquilerService.createMaquina(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

alquiler.patch('/maquinas/:id', zValidator('json', UpdateMaquinaSchema), async (c) => {
  return c.json(await alquilerService.updateMaquina(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/maquinas/:id', async (c) => {
  return c.json(await alquilerService.deleteMaquina(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Póliza de seguro de la máquina (admin-only; bucket alquiler-docs) ──
// Flujo de 2 pasos: pedir URL firmada de subida → registrar el storage_path.
alquiler.post('/maquinas/:id/seguro-poliza/upload-url', zValidator('json', SeguroUploadUrlSchema), async (c) => {
  return c.json(await alquilerService.seguroUploadUrl(Number(c.req.param('id')), c.req.valid('json'), c.get('user').id))
})

alquiler.post('/maquinas/:id/seguro-poliza', zValidator('json', SeguroRegistrarSchema), async (c) => {
  return c.json(await alquilerService.seguroRegistrar(Number(c.req.param('id')), c.req.valid('json'), c.get('user').id, c.get('accessToken')), 201)
})

alquiler.get('/maquinas/:id/seguro-poliza', async (c) => {
  return c.json(await alquilerService.seguroSignedUrl(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/maquinas/:id/seguro-poliza', async (c) => {
  return c.json(await alquilerService.seguroDelete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Asignación máquina ↔ obra ─────────────────────────────────
// IMPORTANTE: estas rutas con sufijo /maquinas deben declararse ANTES de
// /obras/:id para que el router no capture "maquinas" como :id.
alquiler.get('/obras/:id/maquinas', async (c) => {
  return c.json(await alquilerService.getObraMaquinas(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

alquiler.post('/obras/:id/maquinas', zValidator('json', CreateObraMaquinaSchema), async (c) => {
  return c.json(await alquilerService.createObraMaquina(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

// obra-maquinas/:id es la asignación individual (cambiar maquinista / quitar).
alquiler.patch('/obra-maquinas/:id', zValidator('json', UpdateObraMaquinaSchema), async (c) => {
  return c.json(await alquilerService.updateObraMaquina(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/obra-maquinas/:id', async (c) => {
  return c.json(await alquilerService.deleteObraMaquina(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Clientes (ficha; ABM admin-only en el service) ────────────
alquiler.get('/clientes', async (c) => {
  return c.json(await alquilerService.getClientes(c.get('accessToken')))
})

alquiler.get('/clientes/:id', async (c) => {
  return c.json(await alquilerService.getClienteById(Number(c.req.param('id')), c.get('accessToken')))
})

alquiler.post('/clientes', zValidator('json', CreateClienteSchema), async (c) => {
  return c.json(await alquilerService.createCliente(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

alquiler.patch('/clientes/:id', zValidator('json', UpdateClienteSchema), async (c) => {
  return c.json(await alquilerService.updateCliente(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/clientes/:id', async (c) => {
  return c.json(await alquilerService.deleteCliente(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Obras ─────────────────────────────────────────────────────
alquiler.get('/obras', async (c) => {
  return c.json(await alquilerService.getObras(c.get('accessToken'), c.get('user').id))
})

alquiler.get('/obras/:id', async (c) => {
  return c.json(await alquilerService.getObraById(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

alquiler.post('/obras', zValidator('json', CreateObraSchema), async (c) => {
  return c.json(await alquilerService.createObra(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

alquiler.patch('/obras/:id', zValidator('json', UpdateObraSchema), async (c) => {
  return c.json(await alquilerService.updateObra(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/obras/:id', async (c) => {
  return c.json(await alquilerService.deleteObra(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Partes ────────────────────────────────────────────────────
alquiler.get('/partes', zValidator('query', ListPartesQuerySchema), async (c) => {
  return c.json(await alquilerService.getPartes(c.req.valid('query'), c.get('accessToken'), c.get('user').id))
})

alquiler.post('/partes', zValidator('json', CreateParteSchema), async (c) => {
  return c.json(await alquilerService.createParte(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

alquiler.patch('/partes/:id', zValidator('json', UpdateParteSchema), async (c) => {
  return c.json(await alquilerService.updateParte(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/partes/:id', async (c) => {
  return c.json(await alquilerService.deleteParte(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Remitos (Fase 2) ──────────────────────────────────────────
// Emitir el remito de un parte (idempotente: re-emitir conserva el número).
// POST → gate de 'creacion'. El parte_id viaja en la URL; sin body.
alquiler.post('/partes/:id/remito', async (c) => {
  return c.json(await alquilerService.emitirRemito(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id), 201)
})

alquiler.get('/remitos', zValidator('query', ListRemitosQuerySchema), async (c) => {
  return c.json(await alquilerService.getRemitos(c.req.valid('query'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/remitos/:id', async (c) => {
  return c.json(await alquilerService.deleteRemito(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Reportes (Fase 3) ─────────────────────────────────────────
// Horas por máquina en un período (scopeado por identidad).
alquiler.get('/reportes/horas', zValidator('query', ReporteHorasQuerySchema), async (c) => {
  return c.json(await alquilerService.getReporteHorasPorMaquina(c.req.valid('query'), c.get('accessToken'), c.get('user').id))
})

// Cuenta corriente: devengado − cobros = saldo, por cliente (scopeado).
alquiler.get('/cuenta-corriente', zValidator('query', CuentaCorrienteQuerySchema), async (c) => {
  return c.json(await alquilerService.getCuentaCorriente(c.req.valid('query'), c.get('accessToken'), c.get('user').id))
})

// ── Cobros del cliente (Fase C; writes admin-only en el service) ──
alquiler.get('/cobros', zValidator('query', CobrosQuerySchema), async (c) => {
  return c.json(await alquilerService.getCobros(c.req.valid('query'), c.get('accessToken'), c.get('user').id))
})

alquiler.post('/cobros', zValidator('json', CreateCobroSchema), async (c) => {
  return c.json(await alquilerService.createCobro(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

alquiler.patch('/cobros/:id', zValidator('json', UpdateCobroSchema), async (c) => {
  return c.json(await alquilerService.updateCobro(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

alquiler.delete('/cobros/:id', async (c) => {
  return c.json(await alquilerService.deleteCobro(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Notificaciones (campana, scopeada al módulo alquiler) ─────
// Máquinas con seguro vencido / por vencer (scopeadas por identidad).
alquiler.get('/notificaciones/seguros', async (c) => {
  return c.json(await alquilerService.getSegurosVencimientos(c.get('accessToken'), c.get('user').id))
})

export default alquiler
