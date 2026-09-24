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
import { requirePermiso, requireFlag, requireTab, tieneFlag } from '../../middleware/permission.js'
import { perfilDe, esAdmin } from '../pagos/pagos.service.js'
import { FacturacionHttpError, cuerpoError } from './facturacion.errors.js'
import { dbDe } from './comun.js'
import { clientesService } from './clientes.service.js'
import { facturasService } from './facturas.service.js'
import { emisionService } from './emision.service.js'
import { cuentasService } from './cuentas.service.js'
import { fceService } from './fce.service.js'
import { padronService } from './padron.service.js'
import { CONDICIONES_IVA, esNC } from './reglas.js'
import {
  ListClientesQuerySchema, CreateClienteSchema, UpdateClienteSchema, ObrasClienteSchema,
  GuardarFacturaSchema, ListFacturasQuerySchema, ResumenQuerySchema,
  EmitirSchema, MotivoSchema, RegistrarFinnegansSchema,
  FceClienteQuerySchema, CuentaSchema, UpdateCuentaSchema, ListCuentasQuerySchema, esBoolQ,
} from './facturacion.schema.js'

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
const tabCatalogos  = requireTab(MOD, ['facturas', 'clientes', 'finnegans'])
const tabListado    = requireTab(MOD, ['facturas', 'finnegans'])
const tabLeerClientes = requireTab(MOD, ['facturas', 'clientes'])
const registrarFinnegans = requireFlag(MOD, 'registrar_finnegans')

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

fact.get('/arca/estado', lectura, tabCatalogos, handler(async () => emisionService.estado()))

fact.get('/condiciones-iva', lectura, tabCatalogos, handler(async () => CONDICIONES_IVA))

fact.get('/obras', lectura, tabCatalogos, handler(async (c) => clientesService.obras(db(c))))

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

export default fact
