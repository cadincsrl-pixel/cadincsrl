/**
 * Rutas del módulo Pagos (montado en `/api/pagos`). Diseño v3 §5.1 + las 12
 * decisiones del 18/09.
 *
 * GUARDIAS POR RUTA, NO POR VERBO GLOBAL. Un `router.on(['POST'], '*',
 * requirePermiso('pagos','creacion'))` correría antes que cualquier guardia
 * puntual: el contador (`lectura` + `registrar_pagos`, sin `creacion`) recibiría
 * 403 en `POST /ordenes` y el aprobador (`lectura` + `aprobar_facturas`) en
 * `POST /facturas/:id/aprobar`. Cada ruta declara la suya (patrón
 * cuenta-cliente.routes.ts).
 *
 * Tabs: la ficha de una factura se abre desde `facturas` y desde `pagos`, y el
 * select de proveedores lo usan los modales de factura y de pago, así que los
 * GET admiten todos los tabs que los consumen (TAB_PAGO / TAB_PROV_LECTURA).
 *
 * Alcance por obra: NO aplica (decisión 10). Caja, solicitudes, MCC y
 * facturas_compra: no se tocan (decisiones 8 y 9).
 *
 * Rutas literales (`/facturas/resumen`, `/facturas/export`, `/facturas/aprobar`,
 * `/ordenes/resumen`, `/ordenes/upload-comprobante`, `/ordenes/comprobante-pendiente`,
 * `/proveedores/saldos`, `/proveedores/export`) van ANTES de `/:id`.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, requireTab, tieneFlag } from '../../middleware/permission.js'
import { PagosHttpError } from './pagos.errors.js'
import { pagosService, perfilDe, esAdmin, flagPagos, verPiiDe } from './pagos.service.js'
import { avisoPagoService } from './aviso-pago.service.js'
import { proveedoresService, enmascararProveedor } from './proveedores.service.js'
import { pagosAdjuntosService } from './adjuntos.service.js'
import {
  TAB_FACTURA, TAB_PAGO, TAB_PROV_LECTURA, esBoolQ,
  ListFacturasQuerySchema, FacturasResumenQuerySchema, CreateFacturaSchema, UpdateFacturaSchema,
  MotivoSchema, CorregidaSchema, AprobarLoteSchema,
  UploadUrlFacturaSchema, RegistrarAdjFacturaSchema, UploadUrlOrdenSchema, RegistrarAdjOrdenSchema,
  UploadComprobantePendienteSchema, BorrarPendienteSchema,
  ListOrdenesQuerySchema, OrdenesResumenQuerySchema, CreateOrdenSchema, UpdateOrdenSchema, AvisarPagoSchema, RegistrarFinnegansSchema,
  ListProveedoresQuerySchema, CreateProveedorSchema, UpdateProveedorSchema, DatosPagoSchema,
} from './pagos.schema.js'

const pagos = new Hono()
pagos.use('*', authMiddleware)

// ── Guardias ────────────────────────────────────────────────────────────────
const lectura       = requirePermiso('pagos', 'lectura')
const creacion      = requirePermiso('pagos', 'creacion')
const actualizacion = requirePermiso('pagos', 'actualizacion')
const tabFactura    = requireTab('pagos', [...TAB_FACTURA])
const tabPago       = requireTab('pagos', [...TAB_PAGO])
const tabProvLect   = requireTab('pagos', [...TAB_PROV_LECTURA])
const tabProveedores = requireTab('pagos', 'proveedores')
const tabFacturaOProveedores = requireTab('pagos', ['facturas', 'proveedores'])
const aprobarFacturas = requireFlag('pagos', 'aprobar_facturas')
const registrarPagos  = requireFlag('pagos', 'registrar_pagos')
const verPiiFlag      = requireFlag('pagos', 'ver_pii')

/** Errores tipados → `{ error, campo?, detail? }`. Lo demás sube al onError global. */
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return data instanceof Response ? data : c.json(data)
    } catch (err: any) {
      if (err instanceof PagosHttpError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail && typeof err.detail === 'object' && 'campo' in (err.detail as object)) {
          body.campo = (err.detail as { campo: string }).campo
        }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      throw err
    }
  }
}

const verPii = (c: any) => tieneFlag(c.get('user').id, 'pagos', 'ver_pii', false)
const idParam = (c: any, name = 'id') => {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n <= 0) throw new PagosHttpError(400, 'ID_INVALIDO', { campo: name })
  return n
}

// ═══════════════════════════════════ Facturas ═══════════════════════════════

pagos.get('/facturas', lectura, tabPago, zValidator('query', ListFacturasQuerySchema), handler(async (c) =>
  pagosService.listarFacturas(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

pagos.get('/facturas/resumen', lectura, tabPago, zValidator('query', FacturasResumenQuerySchema), handler(async (c) =>
  pagosService.resumenFacturas(c.req.valid('query'))))

pagos.get('/facturas/export', lectura, tabFactura, zValidator('query', ListFacturasQuerySchema), handler(async (c) =>
  pagosService.exportarFacturas(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

pagos.get('/facturas/:id', lectura, tabPago, handler(async (c) =>
  pagosService.detalleFactura(idParam(c), await verPii(c), esBoolQ(c.req.query('borrados')), c.get('accessToken'))))

// Las respuestas de las mutaciones traen la fila de la vista (CBU/alias del
// proveedor): el service las enmascara sin `ver_pii`, igual que los GET.

// Cargar factura. Con `orden` («Ya está pagada») hace falta registrar_pagos o
// admin (2026-09-23; antes Compras podía con tarjeta/efectivo, decisión 3).
pagos.post('/facturas', creacion, tabFactura, zValidator('json', CreateFacturaSchema), handler(async (c) => {
  const userId = c.get('user').id
  return pagosService.crearFactura(c.req.valid('json'), userId, await perfilDe(userId))
}))

pagos.patch('/facturas/:id', actualizacion, tabFactura, zValidator('json', UpdateFacturaSchema), handler(async (c) =>
  pagosService.editarFactura(idParam(c), c.req.valid('json'), c.get('user').id, await verPii(c))))

// Aprobar en lote: aplica las que puede y devuelve `omitidas` (propias, no
// pendientes, paga_cliente, proveedor inactivo). Va antes de /:id/aprobar.
pagos.post('/facturas/aprobar', lectura, aprobarFacturas, tabFactura, zValidator('json', AprobarLoteSchema), handler(async (c) => {
  return pagosService.aprobarLote(c.req.valid('json').ids, c.get('user').id)
}))

// Aprobar una (o sellar una «pagada al cargar» sin revisar). «No aprobás lo
// que cargaste» salvo admin (decisiones 1 y 2).
pagos.post('/facturas/:id/aprobar', lectura, aprobarFacturas, tabFactura, handler(async (c) => {
  const userId = c.get('user').id
  return pagosService.aprobarFactura(idParam(c), userId, await perfilDe(userId))
}))

// Marcar corregida: observada → pendiente (nunca a aprobada).
pagos.post('/facturas/:id/corregida', actualizacion, tabFactura, zValidator('json', CorregidaSchema), handler(async (c) =>
  pagosService.marcarCorregida(idParam(c), c.req.valid('json').comentario, c.get('user').id, await verPii(c))))

// Observar (para el aprobador es «Rechazar»): contador o aprobador o admin.
pagos.post('/facturas/:id/observar', lectura, tabPago, zValidator('json', MotivoSchema), handler(async (c) => {
  const userId = c.get('user').id
  const perfil = await perfilDe(userId)
  if (!(esAdmin(perfil) || flagPagos(perfil, 'registrar_pagos') || flagPagos(perfil, 'aprobar_facturas'))) {
    throw new PagosHttpError(403, 'SIN_PERMISO', { flag: 'registrar_pagos' })
  }
  return pagosService.observarFactura(idParam(c), c.req.valid('json').motivo, userId, verPiiDe(perfil))
}))

// Anular: quién puede depende del estado (ver pagosService.anularFactura).
pagos.post('/facturas/:id/anular', lectura, tabFactura, zValidator('json', MotivoSchema), handler(async (c) => {
  const userId = c.get('user').id
  return pagosService.anularFactura(idParam(c), c.req.valid('json').motivo, userId, await perfilDe(userId))
}))

// Adjuntos de factura (3 pasos; el adjunto no es obligatorio).
pagos.get('/facturas/:id/adjuntos', lectura, tabPago, handler(async (c) =>
  pagosAdjuntosService.listar('facturas', idParam(c), esBoolQ(c.req.query('borrados')), c.get('accessToken'))))

pagos.post('/facturas/:id/adjuntos/upload-url', creacion, tabFactura, zValidator('json', UploadUrlFacturaSchema), handler(async (c) =>
  pagosAdjuntosService.uploadUrl('facturas', idParam(c), c.req.valid('json'))))

pagos.post('/facturas/:id/adjuntos', creacion, tabFactura, zValidator('json', RegistrarAdjFacturaSchema), handler(async (c) =>
  pagosAdjuntosService.registrar('facturas', idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

pagos.get('/facturas/:id/adjuntos/:adjId/signed-url', lectura, tabPago, handler(async (c) =>
  pagosAdjuntosService.signedUrl('facturas', idParam(c), idParam(c, 'adjId'), c.get('accessToken'))))

pagos.delete('/facturas/:id/adjuntos/:adjId', actualizacion, tabFactura, handler(async (c) =>
  pagosAdjuntosService.softDelete('facturas', idParam(c), idParam(c, 'adjId'), c.get('user').id, c.get('accessToken'))))

// ═══════════════════════════════════ Órdenes de pago ════════════════════════

pagos.get('/ordenes', lectura, tabPago, zValidator('query', ListOrdenesQuerySchema), handler(async (c) =>
  pagosService.listarOrdenes(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

pagos.get('/ordenes/resumen', lectura, tabPago, zValidator('query', OrdenesResumenQuerySchema), handler(async (c) =>
  pagosService.resumenOrdenes(c.req.valid('query'))))

// Literal antes de `/ordenes/:id`, como el resto.
pagos.get('/ordenes/export', lectura, tabPago, zValidator('query', ListOrdenesQuerySchema), handler(async (c) =>
  pagosService.exportarOrdenes(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

// El paquete para el contador: cuelga de ÓRDENES, no de facturas, porque va
// sobre lo PAGADO en el período (decisión del dueño 21/09). Devuelve el
// manifiesto con URLs firmadas a 15 min; el ZIP lo arma el navegador.
pagos.get('/ordenes/paquete', lectura, tabPago, zValidator('query', ListOrdenesQuerySchema), handler(async (c) =>
  pagosService.paqueteContador(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

// Comprobante ANTES de la fila: `ordenes/pendientes/<uuid>.<ext>`.
pagos.post('/ordenes/upload-comprobante', lectura, registrarPagos, tabPago, zValidator('json', UploadComprobantePendienteSchema), handler(async (c) =>
  pagosAdjuntosService.uploadUrlPendiente(c.req.valid('json'))))

// El modal se cerró sin guardar.
pagos.delete('/ordenes/comprobante-pendiente', lectura, registrarPagos, tabPago, zValidator('json', BorrarPendienteSchema), handler(async (c) =>
  pagosAdjuntosService.borrarPendiente(c.req.valid('json').storage_path)))

pagos.get('/ordenes/:id', lectura, tabPago, handler(async (c) =>
  pagosService.detalleOrden(idParam(c), await verPii(c), c.get('accessToken'))))

// Registrar pago (todo o nada). Solo sobre aprobadas (`_pagos_validar_pagable`
// en la RPC); separación de funciones acá; NC como línea (decisión 7).
pagos.post('/ordenes', lectura, registrarPagos, tabPago, zValidator('json', CreateOrdenSchema), handler(async (c) => {
  const userId = c.get('user').id
  return pagosService.registrarOrden(c.req.valid('json'), userId, await perfilDe(userId))
}))

pagos.patch('/ordenes/:id', lectura, registrarPagos, tabPago, zValidator('json', UpdateOrdenSchema), handler(async (c) =>
  pagosService.editarOrden(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

// Anular OP: propia del día con `registrar_pagos`, cualquiera con `anular_pagos`
// (el contador lo tiene desde el arranque, decisión 12), admin bypass.
pagos.post('/ordenes/:id/anular', lectura, tabPago, zValidator('json', MotivoSchema), handler(async (c) => {
  const userId = c.get('user').id
  return pagosService.anularOrden(idParam(c), c.req.valid('json').motivo, userId, await perfilDe(userId))
}))

// Registro contable (20260923c): el contador marca la OP como pasada a
// Finnegans con el número de allá. Mismo flag que emitir: lo tiene el
// contador y quien paga; Compras no.
pagos.post('/ordenes/:id/registrar-finnegans', lectura, registrarPagos, tabPago, zValidator('json', RegistrarFinnegansSchema), handler(async (c) =>
  pagosService.registrarFinnegans(idParam(c), c.req.valid('json'), c.get('user').id)))

pagos.post('/ordenes/:id/deshacer-registro', lectura, registrarPagos, tabPago, handler(async (c) =>
  pagosService.deshacerRegistroFinnegans(idParam(c), c.get('user').id)))

// Adjuntos de OP (comprobantes posteriores, PDF de NC, otro).
// ── Aviso de pago por mail (20260921m) ─────────────────────────────────────
// Con UN CLIC, no automático al emitir: de 9 proveedores 1 tiene mail cargado,
// así que automático no saldría casi nunca y quien emitió creería que el
// proveedor se enteró. Cada intento queda registrado en pagos_ordenes_avisos.

// Diagnóstico: ¿este servidor puede mandar mail? Literal antes de `/ordenes/:id`.
pagos.get('/mail/estado', lectura, tabPago, handler(async () => avisoPagoService.estado()))

pagos.post('/ordenes/:id/avisar', lectura, registrarPagos, tabPago, zValidator('json', AvisarPagoSchema), handler(async (c) =>
  avisoPagoService.avisar(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

pagos.get('/ordenes/:id/avisos', lectura, tabPago, handler(async (c) =>
  avisoPagoService.historial(idParam(c), c.get('accessToken'))))

pagos.get('/ordenes/:id/adjuntos', lectura, tabPago, handler(async (c) =>
  pagosAdjuntosService.listar('ordenes', idParam(c), esBoolQ(c.req.query('borrados')), c.get('accessToken'))))

pagos.post('/ordenes/:id/adjuntos/upload-url', lectura, registrarPagos, tabPago, zValidator('json', UploadUrlOrdenSchema), handler(async (c) =>
  pagosAdjuntosService.uploadUrl('ordenes', idParam(c), c.req.valid('json'))))

pagos.post('/ordenes/:id/adjuntos', lectura, registrarPagos, tabPago, zValidator('json', RegistrarAdjOrdenSchema), handler(async (c) =>
  pagosAdjuntosService.registrar('ordenes', idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

pagos.get('/ordenes/:id/adjuntos/:adjId/signed-url', lectura, tabPago, handler(async (c) =>
  pagosAdjuntosService.signedUrl('ordenes', idParam(c), idParam(c, 'adjId'), c.get('accessToken'))))

pagos.delete('/ordenes/:id/adjuntos/:adjId', lectura, registrarPagos, tabPago, handler(async (c) =>
  pagosAdjuntosService.softDelete('ordenes', idParam(c), idParam(c, 'adjId'), c.get('user').id, c.get('accessToken'))))

// ═══════════════════════════════════ Proveedores (padrón propio) ════════════

pagos.get('/proveedores', lectura, tabProvLect, zValidator('query', ListProveedoresQuerySchema), handler(async (c) =>
  proveedoresService.listar(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

pagos.get('/proveedores/saldos', lectura, tabProvLect, handler(async (c) =>
  proveedoresService.saldos(await verPii(c), c.get('accessToken'))))

pagos.get('/proveedores/export', lectura, tabProveedores, handler(async (c) =>
  proveedoresService.exportar(await verPii(c), c.get('accessToken'))))

pagos.get('/proveedores/:id', lectura, tabProvLect, handler(async (c) =>
  proveedoresService.detalle(idParam(c), await verPii(c), c.get('accessToken'))))

// Alta (tab Proveedores o «alta rápida» desde el modal de factura → tab facturas).
pagos.post('/proveedores', creacion, tabFacturaOProveedores, zValidator('json', CreateProveedorSchema), handler(async (c) => {
  const r = await proveedoresService.crear(c.req.valid('json'), c.get('user').id, esBoolQ(c.req.query('forzar')), c.get('accessToken'))
  return { ...r, proveedor: enmascararProveedor(r.proveedor, await verPii(c)) }
}))

pagos.patch('/proveedores/:id', actualizacion, tabProveedores, zValidator('json', UpdateProveedorSchema), handler(async (c) => {
  const r = await proveedoresService.editar(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))
  return { ...r, proveedor: enmascararProveedor(r.proveedor, await verPii(c)) }
}))

// La puerta del contador: `registrar_pagos` + `ver_pii`; razón social y CUIT no pasan por acá.
pagos.patch('/proveedores/:id/datos-pago', lectura, registrarPagos, verPiiFlag, tabProvLect, zValidator('json', DatosPagoSchema), handler(async (c) =>
  proveedoresService.datosPago(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

pagos.post('/proveedores/:id/baja', actualizacion, tabProveedores, zValidator('json', MotivoSchema), handler(async (c) =>
  proveedoresService.baja(idParam(c), c.req.valid('json').motivo, c.get('user').id, c.get('accessToken'))))

pagos.post('/proveedores/:id/reactivar', actualizacion, tabProveedores, handler(async (c) =>
  proveedoresService.reactivar(idParam(c), c.get('user').id, c.get('accessToken'))))

// ═══════════════════════════════════ Catálogos ══════════════════════════════

pagos.get('/catalogos/obras', lectura, handler(async () => pagosService.catalogoObras()))

export default pagos
