// Cuenta corriente de obras (pestaña "Cuenta corriente" de certificaciones).
//
// Una sola vista para lo que se le cobra al cliente y lo que gastó CADINC:
// renglones paginados y resumen por grupo (20260904ap), pendientes de tasar y
// los cobros del cliente, que pueden imputar items puntuales del MCC
// (2026-07-21) vía RPC transaccional. El listado viejo (GET /) y el resumen de
// gastos (GET /gastos-cadinc) se fueron en la fase 3 (20260904aq).

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireTab, tieneFlag } from '../../middleware/permission.js'
import { cuentaClienteService, CcHttpError } from './cuenta-cliente.service.js'
import {
  CrearCobroSchema, EditarCobroSchema, UploadComprobanteCobroSchema,
  CuentaCorrienteQuerySchema, CUENTA_ESTADOS, ImputarPagadoSchema, type CuentaCorrienteQuery,
  EmitirCertificadoSchema, AnularCertificadoSchema, MarcarConsumibleSchema, MarcarEppACargoSchema,
} from './cuenta-cliente.schema.js'
import type { CuentaFiltro } from './cuenta-cliente.service.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'
import { cargarResumenObras } from './resumen-obras.service.js'

const cuentaCliente = new Hono()

cuentaCliente.use('*', authMiddleware)
// Guardia por tab (2026-09-06): la tab de la pantalla también vale en la API.
//
// Son DOS tabs sobre el mismo módulo y no una: quien carga los pedidos del
// pañol necesita ver lo que gastó el pañol, y no puede ver de paso la deuda
// viva de todos los clientes. Así que acá se admiten las dos, y cada ruta que
// muestra plata de clientes vuelve a exigir 'cuenta-corriente' por su cuenta.
cuentaCliente.use('*', requireTab('certificaciones', ['cuenta-corriente', 'gasto-interno']))
const soloCuenta = requireTab('certificaciones', 'cuenta-corriente')

// Wrapper de error → respeta CcHttpError con status/code/detail.
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      return await fn(c)
    } catch (err: any) {
      if (err instanceof CcHttpError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      throw err
    }
  }
}

// ── Cuenta corriente (20260904ap) ─────────────────────────────────────
// Una sola vista para lo que se le cobra al cliente y lo que gastó CADINC.
// Los dos endpoints comparten los filtros (CuentaCorrienteQuerySchema) y el
// alcance de obras; con obra_cod se valida que el user tenga acceso.

function filtroDeQuery(f: CuentaCorrienteQuery): CuentaFiltro {
  const bool = (v?: string) => v === '1' || v === 'true'
  const estados = (f.estado ?? '').split(',').map(s => s.trim())
    .filter(s => (CUENTA_ESTADOS as readonly string[]).includes(s))
  return {
    obra_cod: f.obra_cod, estados, tipo: f.tipo, sin_precio: bool(f.sin_precio),
    proveedor_id: f.proveedor_id, origen: f.origen, desde: f.desde, hasta: f.hasta,
    q: f.q, archivadas: bool(f.archivadas),
  }
}

// GET /api/cuenta-cliente/renglones — listado paginado y filtrado en el server.
cuentaCliente.get('/renglones', soloCuenta, requirePermiso('certificaciones', 'lectura'), zValidator('query', CuentaCorrienteQuerySchema), async (c) => {
  const f = c.req.valid('query')
  const userId = c.get('user').id
  if (f.obra_cod) await validarObraDelUsuario(userId, f.obra_cod, 'certificaciones')
  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  if (allowed != null && allowed.length === 0) return c.json({ items: [], total: 0, limit: f.limit, offset: f.offset })
  return c.json(await cuentaClienteService.getRenglones(allowed, filtroDeQuery(f), f.limit, f.offset, c.get('accessToken')))
})

// GET /api/cuenta-cliente/resumen-obras — cuánto debe cada obra (17/09).
//
// Una fila por obra de cliente con jornales, contratistas y materiales (cada
// pata con su %), total, pagado, notas de crédito y saldo. Es la cuenta "POR
// ADMINISTRACIÓN" de una obra, calculada en el servidor para todas a la vez:
// hacerlo en el navegador era bajar las horas de 30 obras cada vez (el
// tráfico que fundió Render en agosto) y pisar el tope de 1000 filas.
//
// Jornales y contratistas son COSTO, así que van con la misma llave que
// GET /api/horas/costo-obra: lectura de tarja + flag ver_costos. Sin eso la
// fila viene sin esas dos patas y marcada `parcial` — nunca un total que
// parezca completo sin serlo.
cuentaCliente.get('/resumen-obras', soloCuenta, requirePermiso('certificaciones', 'lectura'), async (c) => {
  const userId = c.get('user').id
  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  if (allowed != null && allowed.length === 0) return c.json({ filas: [], con_tarja: false, generado_en: new Date().toISOString() })
  const conTarja = (await tieneFlag(userId, 'tarja', 'lectura', false)) && (await tieneFlag(userId, 'tarja', 'ver_costos', true))
  return c.json(await cargarResumenObras(allowed, conTarja))
})

// GET /api/cuenta-cliente/resumen — totales por grupo (obra | mes | proveedor)
// × estado × tipo del conjunto filtrado, más pagos por obra.
cuentaCliente.get('/resumen', soloCuenta, requirePermiso('certificaciones', 'lectura'), zValidator('query', CuentaCorrienteQuerySchema), async (c) => {
  const f = c.req.valid('query')
  const userId = c.get('user').id
  if (f.obra_cod) await validarObraDelUsuario(userId, f.obra_cod, 'certificaciones')
  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  if (allowed != null && allowed.length === 0) return c.json({ grupos: [], pagos: [] })
  return c.json(await cuentaClienteService.getResumen(allowed, filtroDeQuery(f), f.grupo, c.get('accessToken')))
})

// ── Gasto interno (2026-09-08) ────────────────────────────────────────
// El gasto propio de CADINC: pañol, mantenimiento, herreros, logística, poda.
//
// Son dos endpoints espejo de /resumen y /renglones, y existen por el permiso:
// quien carga los pedidos del pañol tiene que poder ver lo que gastó sin que se
// le abra la deuda de los clientes. Por eso `solo_internas` se FUERZA acá y no
// se lee del query: aunque alguien arme la URL a mano, de estas dos rutas no
// sale un renglón de una obra de cliente.

// GET /api/cuenta-cliente/interno/resumen — totales por mes u obra + herramientas.
cuentaCliente.get('/interno/resumen', requirePermiso('certificaciones', 'lectura'), zValidator('query', CuentaCorrienteQuerySchema), async (c) => {
  const f = c.req.valid('query')
  const userId = c.get('user').id
  if (f.obra_cod) await validarObraDelUsuario(userId, f.obra_cod, 'certificaciones')
  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  const filtro = { ...filtroDeQuery(f), solo_internas: true }
  return c.json(await cuentaClienteService.getGastoInterno(allowed, filtro, f.grupo, c.get('accessToken')))
})

// GET /api/cuenta-cliente/interno/renglones — el detalle, renglón por renglón.
cuentaCliente.get('/interno/renglones', requirePermiso('certificaciones', 'lectura'), zValidator('query', CuentaCorrienteQuerySchema), async (c) => {
  const f = c.req.valid('query')
  const userId = c.get('user').id
  if (f.obra_cod) await validarObraDelUsuario(userId, f.obra_cod, 'certificaciones')
  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  const filtro = { ...filtroDeQuery(f), solo_internas: true }
  return c.json(await cuentaClienteService.getRenglones(allowed, filtro, f.limit, f.offset, c.get('accessToken')))
})

// POST /api/cuenta-cliente/imputar-pagado — reparte lo pagado sobre lo
// facturable, primero lo viejo, y congela lo cubierto (materiales a "Cobrado",
// semanas de jornales/contratistas a cuenta_admin_imputaciones). Idempotente.
cuentaCliente.post('/imputar-pagado', soloCuenta, requirePermiso('certificaciones', 'creacion'),
  zValidator('json', ImputarPagadoSchema), handler(async (c) => {
    const { obra_cod } = c.req.valid('json')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, obra_cod, 'certificaciones')
    return c.json(await cuentaClienteService.imputarPagado(obra_cod, userId))
  }))

// POST /api/cuenta-cliente/consumible
// Marca (o desmarca) renglones como consumible propio de CADINC: lo que ponemos
// nosotros para ejecutar la tarea y no se le cobra al cliente.
//
// Pide `actualizacion` y NO `creacion`: no crea nada, cambia quién paga un
// renglón que ya existe. Y pide UNO de dos flags: `cargar_precios`, el que
// habilita tocar la cuenta del cliente y el catálogo (CLAUDE.md §5.14), o
// `marcar_consumibles` (20260917n), que es sólo esta capacidad: decidir qué
// pone CADINC sin poder valuar la cuenta, aprobar precios ni certificar. Nació
// para Diego en las obras de presupuesto cerrado; la RPC ya rechaza las obras
// por administración y las llave en mano, así que el flag no llega más lejos.
cuentaCliente.post('/consumible', soloCuenta, requirePermiso('certificaciones', 'actualizacion'),
  zValidator('json', MarcarConsumibleSchema), handler(async (c) => {
    const dto = c.req.valid('json')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'certificaciones')
    // Mismo código de error y mismo default que usa emitir certificado, para
    // que el frontend no tenga que aprender una variante nueva.
    const puede = (await tieneFlag(userId, 'certificaciones', 'cargar_precios', false))
               || (await tieneFlag(userId, 'certificaciones', 'marcar_consumibles', false))
    if (!puede) return c.json({ error: 'SIN_PERMISO_MARCAR_CONSUMIBLES' }, 403)
    return c.json(await cuentaClienteService.marcarConsumible(dto, userId))
  }))

// POST /api/cuenta-cliente/epp-a-cargo
// EPP que se le cobra al cliente (20261002a, pedido del dueño 26/09): la
// excepción a «el EPP es gasto de CADINC», renglón por renglón desde Cargar
// precios. Mete plata en la deuda del cliente, así que pide `cargar_precios`
// (no alcanza `marcar_consumibles`, que sólo SACA de la deuda). La RPC rechaza
// llave en mano, cobrados, certificados y lo que no es EPP.
cuentaCliente.post('/epp-a-cargo', soloCuenta, requirePermiso('certificaciones', 'actualizacion'),
  zValidator('json', MarcarEppACargoSchema), handler(async (c) => {
    const dto = c.req.valid('json')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'certificaciones')
    if (!(await tieneFlag(userId, 'certificaciones', 'cargar_precios', false))) {
      return c.json({ error: 'SIN_PERMISO_CARGAR_PRECIOS' }, 403)
    }
    return c.json(await cuentaClienteService.marcarEppACargo(dto, userId))
  }))

// GET /api/cuenta-cliente/pendientes-precio
// Conteo de materiales sin precio (a tasar) por obra, en las obras del usuario.
cuentaCliente.get('/pendientes-precio', soloCuenta, requirePermiso('certificaciones', 'lectura'), async (c) => {
  const allowed = await getObrasDelUsuarioCached(c.get('user').id, 'certificaciones')
  // allowed === null → scope global (admin): todas las obras.
  const data = await cuentaClienteService.pendientesDePrecio(allowed, c.get('accessToken'))
  return c.json(data)
})

// ── Cobros (pagos del cliente a cuenta de la obra) ─────────────────────
// El saldo lo calcula el frontend (adeudado del MCC − Σ cobros). El registro
// y la eliminación van por RPC transaccional (imputación de items).

// GET /api/cuenta-cliente/cobros?obra_cod=X (opcional — sin obra: scope user,
// para que los KPIs de "todas mis obras" incluyan los pagos)
cuentaCliente.get('/cobros', soloCuenta, requirePermiso('certificaciones', 'lectura'), async (c) => {
  const obraCod = c.req.query('obra_cod')
  const userId  = c.get('user').id
  if (obraCod) {
    await validarObraDelUsuario(userId, obraCod, 'certificaciones')
    const data = await cuentaClienteService.getCobros(obraCod, c.get('accessToken'))
    return c.json(data)
  }
  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  if (allowed == null) return c.json({ error: 'obra_cod es requerido' }, 400)
  if (allowed.length === 0) return c.json([])
  const data = await cuentaClienteService.getCobrosByObras(allowed, c.get('accessToken'))
  return c.json(data)
})

// GET /api/cuenta-cliente/notas-credito?obra_cod=… — devoluciones que ya
// estaban cobradas. Solo lectura del módulo: quien ve la cuenta ve el saldo a
// favor. Emitirlas es otra cosa y pide `cargar_precios` (ver el endpoint de
// devolución en solicitudes).
cuentaCliente.get('/notas-credito', soloCuenta, requirePermiso('certificaciones', 'lectura'), async (c) => {
  const obraCod = c.req.query('obra_cod')
  if (!obraCod) return c.json({ error: 'obra_cod es requerido' }, 400)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  return c.json(await cuentaClienteService.getNotasCredito(obraCod, c.get('accessToken')))
})

// GET /api/cuenta-cliente/devoluciones?obra_cod=… — todo lo que volvió al
// depósito desde esta obra, haya dejado nota de crédito o no (20260914ai).
// Sin esto, una devolución sobre un renglón no cobrado desaparece de la
// cuenta sin rastro. Solo lectura, misma guardia que las notas.
cuentaCliente.get('/devoluciones', soloCuenta, requirePermiso('certificaciones', 'lectura'), async (c) => {
  const obraCod = c.req.query('obra_cod')
  if (!obraCod) return c.json({ error: 'obra_cod es requerido' }, 400)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  return c.json(await cuentaClienteService.getDevoluciones(obraCod, c.get('accessToken')))
})

// POST /api/cuenta-cliente/cobros — registra el cobro imputando items (RPC).
cuentaCliente.post('/cobros', soloCuenta, requirePermiso('certificaciones', 'creacion'), zValidator('json', CrearCobroSchema), handler(async (c) => {
  const dto = c.req.valid('json')
  await validarObraDelUsuario(c.get('user').id, dto.obra_cod, 'certificaciones')
  const data = await cuentaClienteService.crearCobro(dto, c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
}))

// POST /api/cuenta-cliente/cobros/upload-comprobante — firma URL de subida.
cuentaCliente.post('/cobros/upload-comprobante', soloCuenta, requirePermiso('certificaciones', 'creacion'), zValidator('json', UploadComprobanteCobroSchema), handler(async (c) => {
  const data = await cuentaClienteService.firmarUploadComprobante(c.req.valid('json').content_type)
  return c.json(data)
}))

// GET /api/cuenta-cliente/cobros/:id/comprobante-url — firma URL de descarga.
cuentaCliente.get('/cobros/:id/comprobante-url', soloCuenta, requirePermiso('certificaciones', 'lectura'), handler(async (c) => {
  const id = Number(c.req.param('id'))
  const obraCod = await cuentaClienteService.getCobroObra(id, c.get('accessToken'))
  if (!obraCod) return c.json({ error: 'Cobro no encontrado' }, 404)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  const data = await cuentaClienteService.getComprobanteUrl(id)
  return c.json(data)
}))

// PATCH /api/cuenta-cliente/cobros/:id
cuentaCliente.patch('/cobros/:id', soloCuenta, requirePermiso('certificaciones', 'actualizacion'), zValidator('json', EditarCobroSchema), handler(async (c) => {
  const id = Number(c.req.param('id'))
  const obraCod = await cuentaClienteService.getCobroObra(id, c.get('accessToken'))
  if (!obraCod) return c.json({ error: 'Cobro no encontrado' }, 404)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  const data = await cuentaClienteService.editarCobro(id, c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
}))

// DELETE /api/cuenta-cliente/cobros/:id — desimputa items y borra (RPC).
cuentaCliente.delete('/cobros/:id', soloCuenta, requirePermiso('certificaciones', 'eliminacion'), handler(async (c) => {
  const id = Number(c.req.param('id'))
  const obraCod = await cuentaClienteService.getCobroObra(id, c.get('accessToken'))
  if (!obraCod) return c.json({ error: 'Cobro no encontrado' }, 404)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  const data = await cuentaClienteService.eliminarCobro(id, c.get('accessToken'), c.get('user').id)
  return c.json(data)
}))

// ── Certificados al cliente (20260911h/i/j) ─────────────────────────────
// Emitir es un acto de facturacion: pide `creacion` + el flag cargar_precios
// (o admin), el mismo que "Cargar precios". Anular, solo admin: deshace una
// presentacion que el cliente puede tener en la mano.

// GET /api/cuenta-cliente/certificados?obra_cod=
cuentaCliente.get('/certificados', soloCuenta, requirePermiso('certificaciones', 'lectura'), handler(async (c) => {
  const obraCod = c.req.query('obra_cod')
  if (!obraCod) return c.json({ error: 'OBRA_REQUERIDA' }, 400)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  return c.json(await cuentaClienteService.getCertificados(obraCod, c.get('accessToken')))
}))

// GET /api/cuenta-cliente/certificados/:id — el certificado con renglones y cobros.
cuentaCliente.get('/certificados/:id', soloCuenta, requirePermiso('certificaciones', 'lectura'), handler(async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'ID_INVALIDO' }, 400)
  const obraCod = await cuentaClienteService.getCertificadoObra(id)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  return c.json(await cuentaClienteService.getCertificado(id, c.get('accessToken')))
}))

// POST /api/cuenta-cliente/certificados — emitir (RPC transaccional).
cuentaCliente.post('/certificados', soloCuenta, requirePermiso('certificaciones', 'creacion'), zValidator('json', EmitirCertificadoSchema), handler(async (c) => {
  const dto = c.req.valid('json')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod, 'certificaciones')
  if (!(await tieneFlag(userId, 'certificaciones', 'cargar_precios', false))) {
    return c.json({ error: 'SIN_PERMISO_CARGAR_PRECIOS' }, 403)
  }
  return c.json(await cuentaClienteService.emitirCertificado(dto, userId), 201)
}))

// POST /api/cuenta-cliente/certificados/:id/anular — solo admin.
cuentaCliente.post('/certificados/:id/anular', soloCuenta, requirePermiso('certificaciones', 'eliminacion'), zValidator('json', AnularCertificadoSchema), handler(async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'ID_INVALIDO' }, 400)
  const userId = c.get('user').id
  if (!(await tieneFlag(userId, 'certificaciones', 'anular_certificados', false))) {
    return c.json({ error: 'SOLO_ADMIN' }, 403)
  }
  const obraCod = await cuentaClienteService.getCertificadoObra(id)
  await validarObraDelUsuario(userId, obraCod, 'certificaciones')
  return c.json(await cuentaClienteService.anularCertificado(id, c.req.valid('json').motivo, userId))
}))

export default cuentaCliente
