/**
 * Rutas del módulo Facturación (montado en `/api/facturacion`). Fases 1, 5 y 6:
 * Factura A/B, NC A/B y FCE MiPyME A (201/203) contra ARCA (la letra la
 * decide el cliente; Factura A vs FCE, WSFECRED). Contrato de la API: scratchpad
 * `facturacion-api-contrato.md` (2026-09-24), espejado en el frontend.
 *
 * Permisos: `permisos.facturacion = { lectura, creacion, actualizacion,
 * eliminacion, tabs: ['facturas','clientes','finnegans'], emitir_facturas,
 * emitir_notas_credito, registrar_finnegans }`. Flags default false; admin
 * bypass. Guardias POR RUTA (patrón pagos.routes.ts).
 *
 * Tabs: los catálogos (clientes, obras —cada obra es su centro de costo—, condiciones de IVA,
 * estado de ARCA) los necesita el formulario de la factura, así que el tab
 * `facturas` también los habilita; la bandeja de Finnegans lista facturas.
 *
 * Emitir: el flag depende del tipo (NC → `emitir_notas_credito`), por eso se
 * chequea inline después de leer la factura. La RPC lo vuelve a chequear.
 *
 * Rutas literales (`/facturas/resumen`) van ANTES de `/:id`.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requirePermisoOr, requireFlag, requireTab, tieneFlag } from '../../middleware/permission.js'
import { perfilDe, esAdmin } from '../pagos/pagos.service.js'
import { FacturacionHttpError, cuerpoError } from './facturacion.errors.js'
import { ambienteProceso, dbDe } from './comun.js'
import { clientesService } from './clientes.service.js'
import { facturasService } from './facturas.service.js'
import { emisionService } from './emision.service.js'
import { cuentasService } from './cuentas.service.js'
import { fceService } from './fce.service.js'
import { padronService } from './padron.service.js'
import { cobrosService } from './cobros.service.js'
import { externosService } from './externos.service.js'
import { deudoresService } from './deudores.service.js'
import { lidVentasService } from './lid-ventas.service.js'
import { aAnsi, nombreArchivo } from './lid-ventas.js'
import { lidComprasService } from './lid-compras.service.js'
import { productosService } from './productos.service.js'
import { puntosVentaService } from './puntos-venta.service.js'
import { parametrosService } from './parametros.service.js'
import { retencionTiposService, ventasConfigService } from './retencion-tipos.service.js'
import { nombreArchivoCompras } from './lid-compras.js'
import { CONDICIONES_IVA, esNC } from './reglas.js'
import {
  ListClientesQuerySchema, CreateClienteSchema, UpdateClienteSchema, ObrasClienteSchema,
  GuardarFacturaSchema, ListFacturasQuerySchema, ResumenQuerySchema,
  EmitirSchema, MotivoSchema, RegistrarFinnegansSchema,
  FceClienteQuerySchema, CuentaSchema, UpdateCuentaSchema, ListCuentasQuerySchema, esBoolQ,
  RegistrarCobroSchema, ImputarSchema, CompensarSchema, AnularCobroSchema, AnularImputacionSchema,
  ListCobrosQuerySchema, ListImputacionesQuerySchema, UploadRetencionSchema, AdjuntoRetencionSchema, AdjuntoCobroSchema,
  PendientesQuerySchema, DeudoresQuerySchema, EstadoCuentaQuerySchema, VencimientoSchema,
  CreateExternoSchema, UpdateExternoSchema, LiquidoExternoSchema, ListExternosQuerySchema, ImportarExternosSchema, MarcarExternosSchema,
  ProductoCreateSchema, ProductoUpdateSchema, ListProductosQuerySchema,
  PuntoVentaCreateSchema, PuntoVentaUpdateSchema, ListPuntosVentaQuerySchema,
  ParametroCreateSchema, ListParametrosQuerySchema, ParametrosVigentesQuerySchema,
  RetencionTipoCreateSchema, RetencionTipoUpdateSchema, ListRetencionTiposQuerySchema, VentasConfigPatchSchema,
  CLAVE_RETENCION_RE,
  ContactosSchema, LidVentasQuerySchema, LidVentasDescargarQuerySchema, LidComprasQuerySchema, LidComprasDescargarQuerySchema,
} from './facturacion.schema.js'
import { z } from 'zod'

const MOD = 'facturacion'
const fact = new Hono()
fact.use('*', authMiddleware)

// ── Guardias ────────────────────────────────────────────────────────────────
const lectura       = requirePermiso(MOD, 'lectura')
const creacion      = requirePermiso(MOD, 'creacion')
const actualizacion = requirePermiso(MOD, 'actualizacion')
const eliminacion   = requirePermiso(MOD, 'eliminacion')
const tabFacturas   = requireTab(MOD, 'facturas')
const tabClientes   = requireTab(MOD, 'clientes')
const tabFinnegans  = requireTab(MOD, 'finnegans')
// Libros de IVA y posición del mes (24/09). Acepta también `finnegans`, la tab
// que tenía el libro de ventas antes: la migración 20260924x la renombra en
// profiles/roles, y esto cubre el rato entre el deploy y la migración.
const tabImpuestos  = requireTab(MOD, ['impuestos', 'finnegans'])
const tabCatalogos  = requireTab(MOD, ['facturas', 'clientes', 'finnegans'])
const tabListado    = requireTab(MOD, ['facturas', 'finnegans'])
const tabLeerClientes = requireTab(MOD, ['facturas', 'clientes'])
const registrarFinnegans = requireFlag(MOD, 'registrar_finnegans')
// Cobranzas (20260924k…o). Tabs: cobranzas (cobros e imputaciones), deudores
// (deudores y estado de cuenta), saldos_iniciales (externos, importar, marcar).
const tabCobranzas    = requireTab(MOD, 'cobranzas')
const tabDeudores     = requireTab(MOD, 'deudores')
const tabSaldos       = requireTab(MOD, 'saldos_iniciales')
const tabLeerCobros   = requireTab(MOD, ['cobranzas', 'deudores'])
// La compensación y la anulación de una imputación se hacen también desde la ficha de la NC (tab facturas).
const tabCompensar    = requireTab(MOD, ['cobranzas', 'facturas'])
const tabImputaciones = requireTab(MOD, ['cobranzas', 'deudores', 'facturas', 'saldos_iniciales'])
const tabVencimiento  = requireTab(MOD, ['facturas', 'cobranzas', 'deudores'])
const registrarCobros = requireFlag(MOD, 'registrar_cobros')
// Configuración (tanda 6, 20260929b…): leer es `lectura` (el formulario de la
// factura lee el catálogo); escribir pide la tab y el flag `configurar`.
const tabConfiguracion = requireTab(MOD, 'configuracion')
const configurar       = requireFlag(MOD, 'configurar')
const anularCobros    = requireFlag(MOD, 'anular_cobros')

/** Errores tipados → `{ error, campo?, detail?, ...extra }`. Lo demás sube al onError global. */
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return data instanceof Response ? data : c.json(data)
    } catch (err: any) {
      if (err instanceof FacturacionHttpError) return c.json(cuerpoError(err), err.status as any)
      throw err
    }
  }
}

/** zValidator con errores en la forma del módulo: 400 DATOS_INVALIDOS { campo, mensaje }. */
function valida<T extends ZodType>(target: 'json' | 'query', schema: T) {
  return zValidator(target, schema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const campo = issue?.path?.join('.') || null
      return c.json({ error: 'DATOS_INVALIDOS', campo, detail: { campo, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  })
}

/** Body opcional (emitir, descartar): vacío = `{}`. */
async function bodyOpcional<T>(c: any, schema: ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}))
  const r = schema.safeParse(raw ?? {})
  if (!r.success) {
    const issue = r.error.issues[0]
    const campo = issue?.path?.join('.') || null
    throw new FacturacionHttpError(400, 'DATOS_INVALIDOS', { campo, mensaje: issue?.message ?? 'dato inválido' })
  }
  return r.data
}

const idParam = (c: any, name = 'id') => {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n <= 0) throw new FacturacionHttpError(400, 'ID_INVALIDO', { campo: name })
  return n
}
const db = (c: any) => dbDe(c.get('accessToken'))
const uid = (c: any): string => c.get('user').id

/** Flag de emisión según el tipo del comprobante (403 SIN_PERMISO { flag } como requireFlag). */
async function exigirFlagEmision(c: any, id: number): Promise<void> {
  const tipo = await facturasService.tipoDe(id, db(c))
  const flag = esNC(tipo) ? 'emitir_notas_credito' : 'emitir_facturas'
  if (!(await tieneFlag(uid(c), MOD, flag, false))) throw new FacturacionHttpError(403, 'SIN_PERMISO', { flag })
}

// ═══════════════════════════════════ Estado y catálogos ═════════════════════

fact.get('/arca/ambiente', lectura, handler(async (c) => emisionService.ambiente(db(c))))
fact.get('/arca/estado', lectura, tabCatalogos, handler(async (c) => emisionService.estado(db(c))))

fact.get('/condiciones-iva', lectura, tabCatalogos, handler(async () => CONDICIONES_IVA))

fact.get('/obras', lectura, tabCatalogos, handler(async (c) => clientesService.obras(db(c))))

// ═══════════════════════════════════ Productos de venta (20260929b) ═════════
// GET sin tab: lo usan el formulario de la factura y los filtros. POST/PATCH:
// tab configuracion + flag configurar (la RPC vuelve a chequear el flag). Sin
// DELETE: se desactivan (`activo: false`). Validación → 400 PRODUCTO_INVALIDO.

function validaProducto<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const campo = claves[0] ?? (issue?.path?.join('.') || null)
      return c.json({ error: 'PRODUCTO_INVALIDO', campo, detail: { campo, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  })
}

fact.get('/productos', lectura, valida('query', ListProductosQuerySchema), handler(async (c) =>
  productosService.listar(esBoolQ(c.req.valid('query').incluir_inactivos), db(c))))

fact.post('/productos', lectura, tabConfiguracion, configurar, validaProducto(ProductoCreateSchema), handler(async (c) =>
  c.json(await productosService.crear(c.req.valid('json'), uid(c), db(c)), 201)))

fact.patch('/productos/:id', lectura, tabConfiguracion, configurar, validaProducto(ProductoUpdateSchema), handler(async (c) =>
  productosService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

// ═══════════════════════════════════ Puntos de venta (20260929d) ════════════
// GET sin tab (lo lee el formulario de la factura). Escribir: tab
// configuracion + flag configurar. El ambiente es siempre el del proceso;
// sin DELETE (se desactivan). Validación → 400 PV_INVALIDO.

function validaPv<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const campo = claves[0] ?? (issue?.path?.join('.') || null)
      return c.json({ error: 'PV_INVALIDO', campo, detail: { campo, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  })
}

fact.get('/puntos-venta', lectura, valida('query', ListPuntosVentaQuerySchema), handler(async (c) =>
  puntosVentaService.listar(c.req.valid('query').ambiente ?? ambienteProceso(), db(c))))

fact.post('/puntos-venta', lectura, tabConfiguracion, configurar, validaPv(PuntoVentaCreateSchema), handler(async (c) =>
  c.json(await puntosVentaService.crear(c.req.valid('json'), uid(c), db(c)), 201)))

fact.patch('/puntos-venta/:id', lectura, tabConfiguracion, configurar, validaPv(PuntoVentaUpdateSchema), handler(async (c) =>
  puntosVentaService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

fact.post('/puntos-venta/:id/verificar', lectura, tabConfiguracion, configurar, handler(async (c) =>
  puntosVentaService.verificar(idParam(c), uid(c), db(c))))

// ═══════════════════════════════════ Montos de ARCA (20260929e) ═════════════
// GET sin tab (el formulario de la factura lee los vigentes a su fecha).
// POST/DELETE: tab configuracion + flag configurar (la RPC vuelve a chequear
// el flag). Sin PATCH: la tabla no se edita en el lugar, un valor nuevo es
// una vigencia nueva; solo se borra una futura. Validación → 400 PARAMETRO_INVALIDO.

function validaParametro<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const campo = claves[0] ?? (issue?.path?.join('.') || null)
      return c.json({ error: 'PARAMETRO_INVALIDO', campo, detail: { campo, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  })
}

fact.get('/parametros', lectura, valida('query', ListParametrosQuerySchema), handler(async (c) =>
  parametrosService.listar(c.req.valid('query').clave, db(c))))

fact.get('/parametros/vigentes', lectura, valida('query', ParametrosVigentesQuerySchema), handler(async (c) =>
  parametrosService.vigentes(c.req.valid('query').fecha, db(c))))

fact.post('/parametros', lectura, tabConfiguracion, configurar, validaParametro(ParametroCreateSchema), handler(async (c) =>
  c.json(await parametrosService.crear(c.req.valid('json'), uid(c), db(c)), 201)))

fact.delete('/parametros/:id', lectura, tabConfiguracion, configurar, handler(async (c) =>
  parametrosService.borrar(idParam(c), uid(c), db(c))))

// ═══════════════════════════════════ Tipos de retención (20260929g) ═════════
// GET sin tab (el modal de cobro lee los activos). POST/PATCH: tab
// configuracion + flag configurar (la RPC vuelve a chequear el flag). La
// clave no se edita; sin DELETE (se desactivan). Validación → 400
// RETENCION_TIPO_INVALIDA.

function validaRetTipo<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const campo = claves[0] ?? (issue?.path?.join('.') || null)
      return c.json({ error: 'RETENCION_TIPO_INVALIDA', campo, detail: { campo, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  })
}

const claveParam = (c: any): string => {
  const k = String(c.req.param('clave') ?? '')
  if (!CLAVE_RETENCION_RE.test(k)) throw new FacturacionHttpError(400, 'RETENCION_TIPO_INVALIDA', { campo: 'clave' })
  return k
}

fact.get('/retencion-tipos', lectura, valida('query', ListRetencionTiposQuerySchema), handler(async (c) =>
  retencionTiposService.listar(esBoolQ(c.req.valid('query').incluir_inactivos), db(c))))

fact.post('/retencion-tipos', lectura, tabConfiguracion, configurar, validaRetTipo(RetencionTipoCreateSchema), handler(async (c) =>
  c.json(await retencionTiposService.crear(c.req.valid('json'), uid(c), db(c)), 201)))

fact.patch('/retencion-tipos/:clave', lectura, tabConfiguracion, configurar, validaRetTipo(RetencionTipoUpdateSchema), handler(async (c) =>
  retencionTiposService.editar(claveParam(c), c.req.valid('json'), uid(c), db(c))))

// ═══════════════════════════════════ Configuración de Ventas (20260929g) ════
// Por ahora solo `retencion_tipo_default` (el ítem 9 suma los valores por
// defecto de la factura). GET: lectura; PATCH: tab + configurar.

fact.get('/config', lectura, handler(async (c) => ventasConfigService.obtener(db(c))))

fact.patch('/config', lectura, tabConfiguracion, configurar,
  zValidator('json', VentasConfigPatchSchema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const clave = claves[0] ?? (issue?.path?.join('.') || null)
      return c.json({ error: 'CONFIG_INVALIDA', campo: clave, detail: { clave, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  }),
  handler(async (c) => ventasConfigService.guardar(c.req.valid('json'), uid(c), db(c))))

// ═══════════════════════════════════ Clientes ═══════════════════════════════

fact.get('/clientes', lectura, tabLeerClientes, valida('query', ListClientesQuerySchema), handler(async (c) =>
  clientesService.listar(c.req.valid('query'), db(c))))

// Padrón de ARCA (fase 7): los datos de un CUIT para precargar el alta. NO
// guarda nada. Pide `creacion` porque es parte de cargar un cliente.
fact.get('/clientes/padron/:cuit', creacion, tabClientes, handler(async (c) =>
  padronService.consultar(c.req.param('cuit'))))

fact.get('/clientes/:id', lectura, tabLeerClientes, handler(async (c) =>
  clientesService.detalle(idParam(c), db(c))))

fact.post('/clientes', creacion, tabClientes, valida('json', CreateClienteSchema), handler(async (c) =>
  clientesService.crear(c.req.valid('json'), uid(c), db(c))))

fact.patch('/clientes/:id', actualizacion, tabClientes, valida('json', UpdateClienteSchema), handler(async (c) =>
  clientesService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

// Pisa domicilio y provincia con los del padrón; razón social y condición de
// IVA solo si están vacías o con `?todo=1`. Devuelve { cliente, diferencias, padron }.
fact.post('/clientes/:id/actualizar-desde-arca', actualizacion, tabClientes, handler(async (c) =>
  padronService.actualizarCliente(idParam(c), { todo: esBoolQ(c.req.query('todo')) }, uid(c), db(c))))

fact.post('/clientes/:id/baja', actualizacion, tabClientes, handler(async (c) =>
  clientesService.setActivo(idParam(c), false, uid(c), db(c))))

fact.post('/clientes/:id/alta', actualizacion, tabClientes, handler(async (c) =>
  clientesService.setActivo(idParam(c), true, uid(c), db(c))))

// FCE MiPyME (fase 6): ¿el cliente está obligado a recibir FCE y desde qué
// monto? Cache de 30 días; `?refrescar=1` vuelve a preguntarle a WSFECRED.
// Nunca falla por ARCA: si WSFECRED no responde vuelve con `error`.
fact.get('/clientes/:id/fce', lectura, tabLeerClientes, valida('query', FceClienteQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return fceService.info(idParam(c), { refrescar: esBoolQ(q.refrescar), fecha: q.fecha }, db(c))
}))

// Lista entera de contactos (nombre, rol, email, teléfono, recibe avisos).
// Creación O actualización: quien da de alta un cliente también le carga sus contactos.
const creacionOActualizacion = requirePermisoOr([{ modulo: MOD, accion: 'creacion' }, { modulo: MOD, accion: 'actualizacion' }])
fact.put('/clientes/:id/contactos', creacionOActualizacion, tabClientes, valida('json', ContactosSchema), handler(async (c) =>
  clientesService.setContactos(idParam(c), c.req.valid('json').contactos, uid(c), db(c))))

fact.put('/clientes/:id/obras', actualizacion, tabClientes, valida('json', ObrasClienteSchema), handler(async (c) =>
  clientesService.setObras(idParam(c), c.req.valid('json').obra_cods, db(c))))

// ═══════════════════════════════════ Cuentas bancarias (FCE) ════════════════
// Las lee el formulario de la factura (tab facturas) y la pestaña Clientes;
// se editan desde Clientes con `actualizacion`.

fact.get('/cuentas', lectura, tabLeerClientes, valida('query', ListCuentasQuerySchema), handler(async (c) =>
  cuentasService.listar(esBoolQ(c.req.valid('query').incluir_inactivas), db(c))))

fact.post('/cuentas', actualizacion, tabClientes, valida('json', CuentaSchema), handler(async (c) =>
  cuentasService.crear(c.req.valid('json'), uid(c), db(c))))

fact.patch('/cuentas/:id', actualizacion, tabClientes, valida('json', UpdateCuentaSchema), handler(async (c) =>
  cuentasService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

fact.post('/cuentas/:id/baja', actualizacion, tabClientes, handler(async (c) =>
  cuentasService.setActivo(idParam(c), false, uid(c), db(c))))

fact.post('/cuentas/:id/alta', actualizacion, tabClientes, handler(async (c) =>
  cuentasService.setActivo(idParam(c), true, uid(c), db(c))))

// ═══════════════════════════════════ Facturas ═══════════════════════════════

fact.get('/facturas', lectura, tabListado, valida('query', ListFacturasQuerySchema), handler(async (c) =>
  facturasService.listar(c.req.valid('query'), db(c))))

fact.get('/facturas/resumen', lectura, tabListado, valida('query', ResumenQuerySchema), handler(async (c) =>
  facturasService.resumen(c.req.valid('query'), db(c))))

fact.get('/facturas/:id', lectura, tabListado, handler(async (c) =>
  facturasService.detalle(idParam(c), db(c))))

fact.post('/facturas', creacion, tabFacturas, valida('json', GuardarFacturaSchema), handler(async (c) =>
  facturasService.guardar(c.req.valid('json'), null, uid(c), esAdmin(await perfilDe(uid(c))), db(c))))

fact.patch('/facturas/:id', actualizacion, tabFacturas, valida('json', GuardarFacturaSchema), handler(async (c) =>
  facturasService.guardar(c.req.valid('json'), idParam(c), uid(c), esAdmin(await perfilDe(uid(c))), db(c))))

fact.delete('/facturas/:id', eliminacion, tabFacturas, handler(async (c) => {
  await facturasService.borrar(idParam(c), db(c))
  return c.body(null, 204)
}))

fact.post('/facturas/:id/descartar', eliminacion, tabFacturas, handler(async (c) => {
  const { motivo } = await bodyOpcional(c, MotivoSchema)
  return facturasService.descartar(idParam(c), motivo, uid(c), db(c))
}))

fact.post('/facturas/:id/emitir', lectura, tabFacturas, handler(async (c) => {
  const id = idParam(c)
  await exigirFlagEmision(c, id)
  const { forzar } = await bodyOpcional(c, EmitirSchema)
  if (forzar && !esAdmin(await perfilDe(uid(c)))) throw new FacturacionHttpError(403, 'FORZAR_SOLO_ADMIN')
  return emisionService.emitir(id, uid(c), !!forzar, db(c))
}))

// Reconciliar pide el mismo flag que emitir ESE tipo (una NC la reconcilia
// quien puede emitir NC), para que el polling tras un 202 no rebote.
fact.post('/facturas/:id/reconciliar', lectura, tabFacturas, handler(async (c) => {
  const id = idParam(c)
  await exigirFlagEmision(c, id)
  return emisionService.reconciliar(id, uid(c), db(c))
}))

fact.post('/facturas/:id/volver-a-borrador', actualizacion, tabFacturas, handler(async (c) =>
  facturasService.volverABorrador(idParam(c), uid(c), db(c))))

fact.post('/facturas/:id/registrar-finnegans', lectura, registrarFinnegans, tabFinnegans, valida('json', RegistrarFinnegansSchema), handler(async (c) =>
  facturasService.registrarFinnegans(idParam(c), c.req.valid('json').numero_finnegans, uid(c), db(c))))

fact.post('/facturas/:id/deshacer-registro', lectura, registrarFinnegans, tabFinnegans, handler(async (c) =>
  facturasService.deshacerRegistro(idParam(c), uid(c), db(c))))

fact.patch('/facturas/:id/vencimiento', actualizacion, tabVencimiento, valida('json', VencimientoSchema), handler(async (c) =>
  deudoresService.cambiarVencimiento(idParam(c), c.req.valid('json').vence_el, uid(c), db(c))))

// ═══════════════════════════════════ Cobranzas ══════════════════════════════
// Contrato «Ventas — Cobranzas y estado de deudores (v1)». Todo filtra
// ambiente='prod' salvo `?ambiente=homo`. Las RPC vuelven a chequear los flags.

fact.get('/cobros', lectura, tabLeerCobros, valida('query', ListCobrosQuerySchema), handler(async (c) =>
  cobrosService.listar(c.req.valid('query'), db(c))))

// Certificados de retención: literales ANTES de /cobros/:id.
fact.post('/cobros/retenciones/upload-url', lectura, registrarCobros, tabCobranzas, valida('json', UploadRetencionSchema), handler(async (c) =>
  cobrosService.uploadUrlRetencion(c.req.valid('json'))))

fact.post('/cobros/retenciones/descartar-pendiente', lectura, registrarCobros, tabCobranzas,
  valida('json', z.object({ storage_path: z.string().min(1).max(300) })), handler(async (c) =>
    cobrosService.descartarPendiente(c.req.valid('json').storage_path)))

const urlRetencion = handler(async (c) => cobrosService.urlRetencion(idParam(c), db(c)))
fact.get('/cobros/retenciones/:id/url', lectura, tabLeerCobros, urlRetencion)
fact.get('/retenciones/:id/url', lectura, tabLeerCobros, urlRetencion)

fact.post('/cobros/retenciones/:id/adjunto', lectura, registrarCobros, tabCobranzas, valida('json', AdjuntoRetencionSchema), handler(async (c) =>
  cobrosService.adjuntarRetencion(idParam(c), c.req.valid('json'), uid(c), db(c))))

// Documentación del cliente en el cobro (20260924q): comprobante de pago,
// orden de pago del cliente u otro. Literales ANTES de /cobros/:id.
fact.post('/cobros/adjuntos/upload-url', lectura, registrarCobros, tabCobranzas, valida('json', UploadRetencionSchema), handler(async (c) =>
  cobrosService.uploadUrlAdjunto(c.req.valid('json'))))

fact.post('/cobros/adjuntos/descartar-pendiente', lectura, registrarCobros, tabCobranzas,
  valida('json', z.object({ storage_path: z.string().min(1).max(300) })), handler(async (c) =>
    cobrosService.descartarAdjuntoPendiente(c.req.valid('json').storage_path)))

fact.get('/cobros/adjuntos/:id/url', lectura, tabLeerCobros, handler(async (c) =>
  cobrosService.urlAdjunto(idParam(c), db(c))))

// Borrar: quien registra o quien anula cobros. De un cobro anulado, no (COBRO_ANULADO).
fact.delete('/cobros/adjuntos/:id', lectura, tabCobranzas, handler(async (c) => {
  const puede = (await tieneFlag(uid(c), MOD, 'registrar_cobros', false)) || (await tieneFlag(uid(c), MOD, 'anular_cobros', false))
  if (!puede) throw new FacturacionHttpError(403, 'SIN_PERMISO', { flag: 'registrar_cobros|anular_cobros' })
  return cobrosService.borrarAdjunto(idParam(c), uid(c), db(c))
}))

fact.get('/cobros/:id/adjuntos', lectura, tabLeerCobros, handler(async (c) =>
  cobrosService.listarAdjuntos(idParam(c), db(c))))

fact.post('/cobros/:id/adjuntos', lectura, registrarCobros, tabCobranzas, valida('json', AdjuntoCobroSchema), handler(async (c) =>
  cobrosService.adjuntar(idParam(c), c.req.valid('json'), uid(c), db(c))))

fact.get('/cobros/:id', lectura, tabLeerCobros, handler(async (c) =>
  cobrosService.detalle(idParam(c), db(c))))

fact.post('/cobros', lectura, registrarCobros, tabCobranzas, valida('json', RegistrarCobroSchema), handler(async (c) =>
  cobrosService.registrar(c.req.valid('json'), c.req.query('ambiente'), uid(c), db(c))))

fact.post('/cobros/:id/imputar', lectura, registrarCobros, tabCobranzas, valida('json', ImputarSchema), handler(async (c) =>
  cobrosService.imputar(idParam(c), c.req.valid('json'), uid(c), db(c))))

fact.post('/cobros/:id/anular', lectura, anularCobros, tabCobranzas, valida('json', AnularCobroSchema), handler(async (c) =>
  cobrosService.anular(idParam(c), c.req.valid('json').motivo, uid(c), db(c))))

fact.post('/compensaciones', lectura, registrarCobros, tabCompensar, valida('json', CompensarSchema), handler(async (c) =>
  cobrosService.compensar(c.req.valid('json'), uid(c), db(c))))

fact.get('/imputaciones', lectura, tabImputaciones, valida('query', ListImputacionesQuerySchema), handler(async (c) =>
  cobrosService.imputaciones(c.req.valid('query'), db(c))))

fact.post('/imputaciones/:id/anular', lectura, anularCobros, tabCompensar, handler(async (c) => {
  const { motivo } = await bodyOpcional(c, AnularImputacionSchema)
  return cobrosService.anularImputacion(idParam(c), motivo, uid(c), db(c))
}))

// Débitos con saldo (grilla «Aplicación de comprobantes») + créditos libres (popup de compensación).
fact.get('/clientes/:id/pendientes', lectura, requireTab(MOD, ['cobranzas', 'deudores', 'facturas']), valida('query', PendientesQuerySchema), handler(async (c) =>
  deudoresService.pendientes(idParam(c), c.req.valid('query'), db(c))))

// ═══════════════════════════════════ Deudores ═══════════════════════════════

fact.get('/deudores', lectura, tabDeudores, valida('query', DeudoresQuerySchema), handler(async (c) =>
  deudoresService.deudores(c.req.valid('query'), db(c))))

fact.get('/clientes/:id/estado-cuenta', lectura, tabDeudores, valida('query', EstadoCuentaQuerySchema), handler(async (c) =>
  deudoresService.estadoCuenta(idParam(c), c.req.valid('query'), db(c))))

// ═══════════════════════════════════ Saldos iniciales (externos) ════════════

fact.get('/externos', lectura, tabSaldos, valida('query', ListExternosQuerySchema), handler(async (c) =>
  externosService.listar(c.req.valid('query'), db(c))))

// Vista previa (confirmar=false) o importación todo-o-nada. Literales ANTES de /externos/:id.
fact.post('/externos/importar', creacion, tabSaldos, valida('json', ImportarExternosSchema), handler(async (c) =>
  externosService.importar(c.req.valid('json'), uid(c), db(c))))

fact.post('/externos/marcar', actualizacion, tabSaldos, valida('json', MarcarExternosSchema), handler(async (c) =>
  externosService.marcar(c.req.valid('json'), uid(c), db(c))))

fact.get('/externos/:id', lectura, tabSaldos, handler(async (c) =>
  externosService.detalle(idParam(c), db(c))))

fact.post('/externos', creacion, tabSaldos, valida('json', CreateExternoSchema), handler(async (c) =>
  externosService.crear(c.req.valid('json'), uid(c), db(c))))

fact.patch('/externos/:id', actualizacion, tabSaldos, valida('json', UpdateExternoSchema), handler(async (c) =>
  externosService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

// Líquido de una CVLP (20260927d): lo usa el motor de asientos. Se carga desde
// Saldos iniciales o desde Impuestos.
fact.patch('/externos/:id/liquido', actualizacion, requireTab(MOD, ['saldos_iniciales', 'impuestos']), valida('json', LiquidoExternoSchema), handler(async (c) =>
  externosService.liquido(idParam(c), c.req.valid('json').liquido, uid(c), db(c))))

fact.delete('/externos/:id', eliminacion, tabSaldos, handler(async (c) => {
  await externosService.borrar(idParam(c), db(c))
  return c.body(null, 204)
}))

// ═══════════════════════════════════ Impuestos: Libro IVA Digital ═══════════
// Es trabajo del contador: lectura + tab `impuestos`. Ventas: lo emitido por el
// ERP (prod, autorizadas) + lo importado de ARCA del período. Compras: las
// facturas de proveedor del módulo Compras. Diseño de registro y fuentes en
// lid-ventas.ts y lid-compras.ts.

fact.get('/lid-ventas', lectura, tabImpuestos, valida('query', LidVentasQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return lidVentasService.libro(q.periodo, esBoolQ(q.incluir_cvlp), db(c))
}))

// El .txt tal cual se importa en el LID: ANSI (Latin-1 / Windows-1252), CRLF.
fact.get('/lid-ventas/descargar', lectura, tabImpuestos, valida('query', LidVentasDescargarQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  const libro = await lidVentasService.libro(q.periodo, esBoolQ(q.incluir_cvlp), db(c))
  const bytes = aAnsi(q.archivo === 'cbte' ? libro.archivos.cbte : libro.archivos.alicuotas)
  return new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=windows-1252',
      'Content-Disposition': `attachment; filename="${nombreArchivo(q.periodo, q.archivo)}"`,
    },
  })
}))

fact.get('/lid-compras', lectura, tabImpuestos, valida('query', LidComprasQuerySchema), handler(async (c) =>
  lidComprasService.libro(c.req.valid('query').periodo, db(c))))

fact.get('/lid-compras/descargar', lectura, tabImpuestos, valida('query', LidComprasDescargarQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  const libro = await lidComprasService.libro(q.periodo, db(c))
  const bytes = aAnsi(q.archivo === 'cbte' ? libro.archivos.cbte : libro.archivos.alicuotas)
  return new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=windows-1252',
      'Content-Disposition': `attachment; filename="${nombreArchivoCompras(q.periodo, q.archivo)}"`,
    },
  })
}))

// Débito − crédito − percepciones − retenciones. Ayuda para el contador, no la DDJJ.
fact.get('/posicion-iva', lectura, tabImpuestos, valida('query', LidVentasQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return lidComprasService.posicion(q.periodo, esBoolQ(q.incluir_cvlp), db(c))
}))

export default fact
