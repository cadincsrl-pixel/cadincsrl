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
 * `/facturas/periodo-iva-sugerido`, `/facturas/importar-arca`, `/facturas/imputar-lote`,
 * `/facturas/marcar-pagadas`,
 * `/ordenes/resumen`, `/ordenes/lote`, `/ordenes/upload-comprobante`, `/ordenes/comprobante-pendiente`,
 * `/proveedores/saldos`, `/proveedores/export`) van ANTES de `/:id`.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, requireTab, tieneFlag } from '../../middleware/permission.js'
import { PagosHttpError } from './pagos.errors.js'
import { pagosService, perfilDe, esAdmin, flagPagos, verPiiDe } from './pagos.service.js'
import { avisoPagoService } from './aviso-pago.service.js'
import { proveedoresService, enmascararProveedor } from './proveedores.service.js'
import { pagosAdjuntosService } from './adjuntos.service.js'
import { lecturaService } from './lectura.service.js'
import { desgloseService } from './desglose.service.js'
import { comprobantesPagoService } from './comprobantes-pago.service.js'
import { conceptosService } from './conceptos.service.js'
import { chequesService } from './cheques.service.js'
import { importarArcaService } from './importar-arca.service.js'
import { imputarService } from './imputar.service.js'
import { marcarPagadasService } from './marcar-pagadas.service.js'
import { pagosConfigService, PagosConfigPatchSchema } from './config.service.js'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import {
  TAB_FACTURA, TAB_PAGO, TAB_PROV_LECTURA, TAB_CUENTAS, CuentaCorrienteQuerySchema, esBoolQ,
  ListFacturasQuerySchema, FacturasResumenQuerySchema, CreateFacturaSchema, UpdateFacturaSchema,
  MotivoSchema, CorregidaSchema, AprobarLoteSchema,
  UploadUrlFacturaSchema, RegistrarAdjFacturaSchema, UploadUrlOrdenSchema, RegistrarAdjOrdenSchema,
  UploadComprobantePendienteSchema, BorrarPendienteSchema, UploadUrlLecturaSchema, LeerFacturaSchema, LeerChequeSchema, LeerComprobantePagoSchema, ReconstruirPagoSchema, CompletarConLecturaSchema,
  CompletarDesgloseSchema, LeerAdjuntoSchema,
  ListOrdenesQuerySchema, OrdenesResumenQuerySchema, CreateOrdenSchema, LoteOrdenesSchema, UpdateOrdenSchema, AvisarPagoSchema, RegistrarFinnegansSchema, AplicarNcSchema, ContactosProveedorSchema,
  ListProveedoresQuerySchema, CreateProveedorSchema, UpdateProveedorSchema, DatosPagoSchema,
  ListConceptosQuerySchema, CreateConceptoSchema, UpdateConceptoSchema,
  PeriodoIvaSugeridoQuerySchema, ImportarRecibidosSchema, DeshacerImportacionSchema, ImputarFacturaSchema, ImputarLoteSchema, MarcarPagadasSchema,
  CuentaOrigenSugeridaSchema,
} from './pagos.schema.js'
import { quiereDescargar } from '../../lib/signed-url.js'

const pagos = new Hono()
pagos.use('*', authMiddleware)

// ── Guardias ────────────────────────────────────────────────────────────────
const lectura       = requirePermiso('pagos', 'lectura')
const creacion      = requirePermiso('pagos', 'creacion')
const actualizacion = requirePermiso('pagos', 'actualizacion')
const tabFactura    = requireTab('pagos', [...TAB_FACTURA])
const tabPago       = requireTab('pagos', [...TAB_PAGO])
const tabProvLect   = requireTab('pagos', [...TAB_PROV_LECTURA])
const tabCuentas    = requireTab('pagos', [...TAB_CUENTAS])
const tabProveedores = requireTab('pagos', 'proveedores')
const tabFacturaOProveedores = requireTab('pagos', ['facturas', 'proveedores'])
const aprobarFacturas = requireFlag('pagos', 'aprobar_facturas')
const registrarPagos  = requireFlag('pagos', 'registrar_pagos')
const verPiiFlag      = requireFlag('pagos', 'ver_pii')
// Alta masiva desde «Mis Comprobantes Recibidos» de ARCA (20260927b/c). Default false.
const importarComprobantes = requireFlag('pagos', 'importar_comprobantes')

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

// «Archivo primero» (20260924u): subir la factura, leerla (QR de ARCA + IA) y
// devolver una propuesta SIN crear nada. Quien carga facturas lo puede usar.
// Literales antes de `/:id`.
pagos.post('/facturas/upload-lectura', creacion, tabFactura, zValidator('json', UploadUrlLecturaSchema), handler(async (c) =>
  lecturaService.uploadUrl(c.req.valid('json'))))

pagos.post('/facturas/leer', creacion, tabFactura, zValidator('json', LeerFacturaSchema), handler(async (c) =>
  lecturaService.leer(c.req.valid('json'), c.get('user').id)))

pagos.delete('/facturas/lectura-pendiente', creacion, tabFactura, zValidator('json', BorrarPendienteSchema), handler(async (c) =>
  lecturaService.descartar(c.req.valid('json').storage_path)))

// Período IVA sugerido para una fecha (20260927a): el mes de la fecha, o el
// primer mes abierto si ese está cerrado en Contabilidad. Lo usa el modal de
// carga mientras el usuario no toque el campo.
pagos.get('/facturas/periodo-iva-sugerido', lectura, tabFactura,
  zValidator('query', PeriodoIvaSugeridoQuerySchema, (r, c) => {
    if (!r.success) return c.json({ error: 'DATOS_INVALIDOS', campo: 'fecha', detail: { campo: 'fecha', mensaje: 'fecha YYYY-MM-DD' } }, 400)
  }),
  handler(async (c) => pagosService.periodoIvaSugerido(c.req.valid('query').fecha)))

// Importar «Mis Comprobantes Recibidos» de ARCA (20260927b/c): vista previa
// (confirmar=false) o todo o nada. Entran impagas y SIN IMPUTAR.
pagos.post('/facturas/importar-arca', creacion, tabFactura, importarComprobantes, zValidator('json', ImportarRecibidosSchema), handler(async (c) =>
  importarArcaService.importar(c.req.valid('json'), c.get('user').id)))

// Imputar en lote: un concepto y una obra al 100 %. Literal antes de /:id.
pagos.post('/facturas/imputar-lote', actualizacion, tabFactura, zValidator('json', ImputarLoteSchema), handler(async (c) =>
  imputarService.imputarLote(c.req.valid('json'), c.get('user').id)))

// Pagadas en lote con tarjeta o billetera (20260927h): una OP por factura,
// hecho consumado (sin aprobación previa). Quien carga facturas o admin: lo
// mira el service (no hay requirePermiso «creación o admin» distinto del normal).
pagos.post('/facturas/marcar-pagadas', lectura, tabFactura, zValidator('json', MarcarPagadasSchema), handler(async (c) => {
  const userId = c.get('user').id
  return marcarPagadasService.marcar(c.req.valid('json'), userId, await perfilDe(userId))
}))

pagos.get('/importaciones', lectura, tabFactura, handler(async () => importarArcaService.listar()))

// Deshacer una importación (20260929k). GET = vista previa (lectura + tab
// facturas + importar_comprobantes); POST = aplicar, además con
// pagos.eliminacion. Todo o nada: 409 IMPORTACION_CON_MOVIMIENTOS { bloqueos }.
// La RPC vuelve a chequear el flag.
pagos.get('/importaciones/:id/deshacer', lectura, tabFactura, importarComprobantes, handler(async (c) =>
  importarArcaService.deshacerVista(idParam(c), c.get('user').id)))

pagos.post('/importaciones/:id/deshacer', lectura, tabFactura, importarComprobantes, requirePermiso('pagos', 'eliminacion'),
  zValidator('json', DeshacerImportacionSchema, (r, c) => {
    if (!r.success) return c.json({ error: 'MOTIVO_REQUERIDO', campo: 'motivo', detail: { campo: 'motivo' } }, 400)
  }),
  handler(async (c) => importarArcaService.deshacer(idParam(c), c.req.valid('json').motivo, c.get('user').id)))

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

// Completar el desglose impositivo (20260924v): aunque la factura esté
// pagada, sin cambiar total ni percepciones (lo valida la RPC). `forzar`
// sólo admin (lo mira el service). `leer-adjunto` corre QR + IA sobre el
// adjunto ya guardado y NO guarda nada.
pagos.post('/facturas/:id/leer-adjunto', actualizacion, tabFactura, zValidator('json', LeerAdjuntoSchema), handler(async (c) =>
  desgloseService.leerAdjunto(idParam(c), c.req.valid('json'))))

pagos.post('/facturas/:id/desglose', actualizacion, tabFactura, zValidator('json', CompletarDesgloseSchema), handler(async (c) => {
  const userId = c.get('user').id
  const perfil = await perfilDe(userId)
  return desgloseService.completar(idParam(c), c.req.valid('json'), userId, esAdmin(perfil), verPiiDe(perfil))
}))

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

// Aplicar el crédito sobrante de una NC aprobada (20260925c). Lo puede hacer
// quien aprueba facturas O quien registra pagos (decisión del dueño 24/09):
// no hay un requireFlag de «uno u otro», así que se mira inline como en
// /observar. Tabs: la ficha se abre desde facturas y desde pagos.
pagos.post('/facturas/:id/aplicar-nc', lectura, tabPago, zValidator('json', AplicarNcSchema), handler(async (c) => {
  const userId = c.get('user').id
  const perfil = await perfilDe(userId)
  if (!(esAdmin(perfil) || flagPagos(perfil, 'aprobar_facturas') || flagPagos(perfil, 'registrar_pagos'))) {
    throw new PagosHttpError(403, 'SIN_PERMISO', { flag: 'aprobar_facturas|registrar_pagos' })
  }
  return pagosService.aplicarNc(idParam(c), c.req.valid('json'), userId, verPiiDe(perfil))
}))

// «Completar la ya cargada» (20260925): el archivo leído va a la factura que
// ya existía (FACTURA_YA_CARGADA), en vez de cargarla de nuevo.
pagos.post('/facturas/:id/completar-con-lectura', creacion, tabFactura, zValidator('json', CompletarConLecturaSchema), handler(async (c) =>
  pagosService.completarConLectura(idParam(c), c.req.valid('json').lectura_id, c.get('user').id, await verPii(c))))

// «Es deuda: no se pagó» (20260929n): la importó el ARCA de meses ya pagados
// pero se debe. Saca la marca pago_a_reconstruir y vuelve al circuito normal.
pagos.post('/facturas/:id/pasar-a-deuda', lectura, tabFactura, handler(async (c) => {
  const userId = c.get('user').id
  const perfil = await perfilDe(userId)
  if (!(esAdmin(perfil) || flagPagos(perfil, 'aprobar_facturas'))) {
    throw new PagosHttpError(403, 'SIN_PERMISO', { flag: 'aprobar_facturas' })
  }
  return pagosService.pasarADeuda(idParam(c), userId, verPiiDe(perfil))
}))

// Imputar una importada de ARCA: concepto + reparto por obra (20260927b).
pagos.post('/facturas/:id/imputar', actualizacion, tabFactura, zValidator('json', ImputarFacturaSchema), handler(async (c) =>
  imputarService.imputar(idParam(c), c.req.valid('json'), c.get('user').id, await verPii(c))))

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
  pagosAdjuntosService.signedUrl('facturas', idParam(c), idParam(c, 'adjId'), c.get('accessToken'), quiereDescargar(c.req.query('descargar')))))

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

// Foto del cheque (20260925p): se sube con /ordenes/upload-comprobante
// (tipo 'cheque') y se lee acá. NO crea nada; 422 CHEQUE_ILEGIBLE si la IA no
// puede. Mismas guardias que subir el comprobante: quien registra pagos, desde
// pagos o desde «Ya está pagada» en facturas.
pagos.get('/cheques/cartera', lectura, registrarPagos, tabPago, handler(async () =>
  chequesService.cartera()))

pagos.post('/cheques/leer', lectura, registrarPagos, tabPago, zValidator('json', LeerChequeSchema), handler(async (c) =>
  chequesService.leer(c.req.valid('json'))))

// «Pagar en lote» (20260929t): N OP, una por proveedor, todo o nada. Mismas
// guardias que POST /ordenes; el error de un bloque trae { indice, proveedor_id }.
// «Soltá acá los comprobantes de pagos» (2026-09-25): lee transferencia,
// e-cheq, cheque, recibo del proveedor o resumen de cuenta. NO crea nada.
pagos.post('/comprobantes/leer', lectura, registrarPagos, tabPago, zValidator('json', LeerComprobantePagoSchema), handler(async (c) =>
  comprobantesPagoService.leer(c.req.valid('json'))))

// Registrar un pago que YA SE HIZO (conciliación): OP reconstruida para
// facturas «pago a reconstruir». Literal antes de /ordenes/:id.
pagos.post('/ordenes/reconstruir', lectura, registrarPagos, tabPago, zValidator('json', ReconstruirPagoSchema), handler(async (c) =>
  comprobantesPagoService.reconstruir(c.req.valid('json'), c.get('user').id)))

pagos.post('/ordenes/lote', lectura, registrarPagos, tabPago, zValidator('json', LoteOrdenesSchema), handler(async (c) => {
  const userId = c.get('user').id
  return pagosService.registrarOrdenesLote(c.req.valid('json'), userId, await perfilDe(userId))
}))

pagos.get('/ordenes/:id', lectura, tabPago, handler(async (c) =>
  pagosService.detalleOrden(idParam(c), await verPii(c), c.get('accessToken'))))

// Registrar pago (todo o nada). Solo sobre aprobadas (`_pagos_validar_pagable`
// en la RPC); separación de funciones acá. Tope por factura = `saldo_pagable`
// (lo reservado por NC sin aprobar no se paga). Una NC no es línea (20260925a).
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

// Adjuntos de OP (comprobantes posteriores u otro).
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
  pagosAdjuntosService.signedUrl('ordenes', idParam(c), idParam(c, 'adjId'), c.get('accessToken'), quiereDescargar(c.req.query('descargar')))))

// `?motivo=` (opcional, 20260929x): queda en el obs del adjunto quitado.
pagos.delete('/ordenes/:id/adjuntos/:adjId', lectura, registrarPagos, tabPago, handler(async (c) =>
  pagosAdjuntosService.softDelete('ordenes', idParam(c), idParam(c, 'adjId'), c.get('user').id, c.get('accessToken'), c.req.query('motivo'))))

// ═══════════════════════════════════ Proveedores (padrón propio) ════════════

pagos.get('/proveedores', lectura, tabProvLect, zValidator('query', ListProveedoresQuerySchema), handler(async (c) =>
  proveedoresService.listar(c.req.valid('query'), await verPii(c), c.get('accessToken'))))

pagos.get('/proveedores/saldos', lectura, tabProvLect, handler(async (c) =>
  proveedoresService.saldos(await verPii(c), c.get('accessToken'))))

pagos.get('/proveedores/export', lectura, tabProveedores, handler(async (c) =>
  proveedoresService.exportar(await verPii(c), c.get('accessToken'))))

// Padrón de ARCA (20260925o). Consultar NO guarda: precarga el alta (tab
// Proveedores o «alta rápida» del modal de factura). Literal antes de /:id.
pagos.get('/proveedores/padron/:cuit', creacion, tabFacturaOProveedores, handler(async (c) =>
  proveedoresService.padron(c.req.param('cuit'))))

// Masivo: todos los activos con CUIT, de a uno. No pisa razón social.
pagos.post('/proveedores/actualizar-desde-arca', actualizacion, tabProveedores, handler(async (c) =>
  proveedoresService.actualizarTodosDesdeArca(c.get('user').id, c.get('accessToken'))))

// Compras › Cuentas (20260929s): la cuenta corriente con el proveedor entre dos fechas.
pagos.get('/proveedores/:id/cuenta-corriente', lectura, tabCuentas, zValidator('query', CuentaCorrienteQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return proveedoresService.cuentaCorriente(idParam(c), q.desde, q.hasta)
}))

pagos.get('/proveedores/:id', lectura, tabProvLect, handler(async (c) =>
  proveedoresService.detalle(idParam(c), await verPii(c), c.get('accessToken'))))

// Alta (tab Proveedores o «alta rápida» desde el modal de factura → tab facturas).
pagos.post('/proveedores', creacion, tabFacturaOProveedores, zValidator('json', CreateProveedorSchema), handler(async (c) => {
  const r = await proveedoresService.crear(c.req.valid('json'), c.get('user').id, esBoolQ(c.req.query('forzar')), c.get('accessToken'))
  return { ...r, proveedor: enmascararProveedor(r.proveedor, await verPii(c)) }
}))

// Lista entera de contactos (nombre, rol, email, teléfono, recibe avisos de pago).
pagos.put('/proveedores/:id/contactos', actualizacion, tabProveedores, zValidator('json', ContactosProveedorSchema), handler(async (c) =>
  proveedoresService.setContactos(idParam(c), c.req.valid('json').contactos, c.get('user').id, c.get('accessToken'))))

pagos.patch('/proveedores/:id', actualizacion, tabProveedores, zValidator('json', UpdateProveedorSchema), handler(async (c) => {
  const r = await proveedoresService.editar(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))
  return { ...r, proveedor: enmascararProveedor(r.proveedor, await verPii(c)) }
}))

// La puerta del contador: `registrar_pagos` + `ver_pii`; razón social y CUIT no pasan por acá.
pagos.patch('/proveedores/:id/datos-pago', lectura, registrarPagos, verPiiFlag, tabProvLect, zValidator('json', DatosPagoSchema), handler(async (c) =>
  proveedoresService.datosPago(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

// Uno: pisa domicilio, provincia, condición, tipo y actividad; `?todo=1`
// también la razón social. Devuelve { proveedor, diferencias }.
pagos.post('/proveedores/:id/actualizar-desde-arca', actualizacion, tabProveedores, handler(async (c) => {
  const r = await proveedoresService.actualizarDesdeArca(idParam(c), { todo: esBoolQ(c.req.query('todo')) }, c.get('user').id, c.get('accessToken'))
  return { ...r, proveedor: enmascararProveedor(r.proveedor, await verPii(c)) }
}))

// Vencimiento de sus facturas impagas con la regla actual: `?aplicar=1` lo
// guarda; sin eso es vista previa y no cambia nada.
pagos.post('/proveedores/:id/recalcular-vencimientos', actualizacion, tabProveedores, handler(async (c) =>
  proveedoresService.recalcularVencimientos(idParam(c), esBoolQ(c.req.query('aplicar')), c.get('user').id, c.get('accessToken'))))

pagos.post('/proveedores/:id/baja', actualizacion, tabProveedores, zValidator('json', MotivoSchema), handler(async (c) =>
  proveedoresService.baja(idParam(c), c.req.valid('json').motivo, c.get('user').id, c.get('accessToken'))))

pagos.post('/proveedores/:id/reactivar', actualizacion, tabProveedores, handler(async (c) =>
  proveedoresService.reactivar(idParam(c), c.get('user').id, c.get('accessToken'))))

// ═══════════════════════════════════ Conceptos de compra (20260925i) ═══════
// La lista la usan el modal de carga (facturas), los filtros de la bandeja y
// la ficha, que también se abre desde pagos: cualquier tab de pagos la lee.
// La ajusta quien tiene `pagos.actualizacion` (el contador). Sin DELETE: se
// da de baja con `activo=false`, y nunca el último activo.

pagos.get('/conceptos', lectura, tabProvLect, zValidator('query', ListConceptosQuerySchema), handler(async (c) =>
  conceptosService.listar(c.req.valid('query'), c.get('accessToken'))))

pagos.post('/conceptos', actualizacion, tabProvLect, zValidator('json', CreateConceptoSchema), handler(async (c) =>
  conceptosService.crear(c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

pagos.patch('/conceptos/:id', actualizacion, tabProvLect, zValidator('json', UpdateConceptoSchema), handler(async (c) =>
  conceptosService.editar(idParam(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

// ═══════════════════════════════════ Catálogos ══════════════════════════════

pagos.get('/catalogos/obras', lectura, handler(async () => pagosService.catalogoObras()))

// De qué cuenta propia sale la plata («Sale de la cuenta», 20260926g). La
// leen el modal de pago y el de factura ya pagada.
pagos.get('/cuentas-origen', lectura, tabPago, handler(async (c) => pagosService.cuentasOrigen(c.get('accessToken'))))

// La que la OP toma sola si nadie la elige (20261009e). POST por los cheques;
// no crea nada (sin auditoría: SIN_AUDITAR en audit.ts).
pagos.post('/cuentas-origen/sugerida', lectura, tabPago, zValidator('json', CuentaOrigenSugeridaSchema), handler(async (c) =>
  pagosService.cuentaOrigenSugerida(c.req.valid('json'), c.get('accessToken'))))

// ═══════════════════════════════════ Configuración (20260929f) ══════════════
// GET: lectura, sin tab (el alta de la factura lee la jurisdicción por
// defecto del tributo). PATCH: tab configuracion + flag configurar (la RPC
// vuelve a chequear el flag). Validación → 400 CONFIG_INVALIDA { clave }.

const dbPagos = (c: any) => {
  const t = c.get('accessToken') as string | undefined
  return t ? createSupabaseClient(t) : supabase
}

pagos.get('/config', lectura, handler(async (c) => pagosConfigService.obtener(dbPagos(c))))

pagos.patch('/config', lectura, requireTab('pagos', 'configuracion'), requireFlag('pagos', 'configurar'),
  zValidator('json', PagosConfigPatchSchema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const clave = claves[0] ?? (issue?.path?.map(String).join('.') || null)
      // EMAIL_INVALIDO y PIE_CON_CBU tienen su propio mensaje en la pantalla;
      // el resto es CONFIG_INVALIDA con el motivo en el detalle.
      const msg = issue?.message ?? ''
      const error = msg === 'EMAIL_INVALIDO' || msg === 'PIE_CON_CBU' ? msg : 'CONFIG_INVALIDA'
      return c.json({ error, campo: clave, detail: { clave, motivo: /^[A-Z_]+$/.test(msg) ? msg.toLowerCase() : null, mensaje: msg || 'dato inválido' } }, 400)
    }
  }),
  handler(async (c) => pagosConfigService.guardar(c.req.valid('json'), c.get('user').id, dbPagos(c))))

// Mail de prueba con el remitente, el Reply-To y el pie configurados (20260929i).
// Mismo guard que PATCH: es parte de configurar los avisos.
pagos.post('/config/probar-mail', lectura, requireTab('pagos', 'configuracion'), requireFlag('pagos', 'configurar'),
  zValidator('json', z.object({ para: z.string().trim().max(254) }), (r, c) => {
    if (!r.success) return c.json({ error: 'EMAIL_INVALIDO', campo: 'para' }, 400)
  }),
  handler(async (c) => avisoPagoService.probar(c.req.valid('json').para)))

export default pagos
