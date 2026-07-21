// Endpoint de lectura para el tab "Cuenta del cliente" de certificaciones.
//
// Pensado para la vista que necesita el user: ver qué le debe el cliente
// (`pagado_por='cadinc'`) y qué pagó directo (`pagado_por='cliente'`) por
// obra, agregado en KPIs y desglosado en una tabla. Los cobros pueden imputar
// items puntuales del MCC (2026-07-21) — el registro va por RPC transaccional.

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { cuentaClienteService, CcHttpError } from './cuenta-cliente.service.js'
import { CrearCobroSchema, EditarCobroSchema, UploadComprobanteCobroSchema } from './cuenta-cliente.schema.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const cuentaCliente = new Hono()

cuentaCliente.use('*', authMiddleware)

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

// GET /api/cuenta-cliente?obra_cod=X  (opcional)
//   - sin `obra_cod`: devuelve MCC de TODAS las obras del usuario (scope).
//   - con `obra_cod`: valida que el user tenga acceso y filtra.
cuentaCliente.get('/', requirePermiso('certificaciones', 'lectura'), async (c) => {
  const obraCod = c.req.query('obra_cod')
  const token   = c.get('accessToken')
  const userId  = c.get('user').id

  if (obraCod) {
    await validarObraDelUsuario(userId, obraCod, 'certificaciones')
    const data = await cuentaClienteService.getByObra(obraCod, token)
    return c.json(data)
  }

  const allowed = await getObrasDelUsuarioCached(userId, 'certificaciones')
  // `null` significa scope global (admin/all): no filtramos por obras.
  if (allowed == null) {
    // Para evitar dump del MCC entero del proyecto, exigimos obra_cod cuando
    // el user tiene scope global. Si más adelante se necesita "todas las
    // obras" para admin, agregar paginación.
    return c.json({ error: 'obra_cod es requerido' }, 400)
  }
  if (allowed.length === 0) return c.json([])

  const data = await cuentaClienteService.getByObras(allowed, token)
  return c.json(data)
})

// GET /api/cuenta-cliente/pendientes-precio
// Conteo de materiales sin precio (a tasar) por obra, en las obras del usuario.
cuentaCliente.get('/pendientes-precio', requirePermiso('certificaciones', 'lectura'), async (c) => {
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
cuentaCliente.get('/cobros', requirePermiso('certificaciones', 'lectura'), async (c) => {
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

// POST /api/cuenta-cliente/cobros — registra el cobro imputando items (RPC).
cuentaCliente.post('/cobros', requirePermiso('certificaciones', 'creacion'), zValidator('json', CrearCobroSchema), handler(async (c) => {
  const dto = c.req.valid('json')
  await validarObraDelUsuario(c.get('user').id, dto.obra_cod, 'certificaciones')
  const data = await cuentaClienteService.crearCobro(dto, c.get('accessToken'), c.get('user').id)
  return c.json(data, 201)
}))

// POST /api/cuenta-cliente/cobros/upload-comprobante — firma URL de subida.
cuentaCliente.post('/cobros/upload-comprobante', requirePermiso('certificaciones', 'creacion'), zValidator('json', UploadComprobanteCobroSchema), handler(async (c) => {
  const data = await cuentaClienteService.firmarUploadComprobante(c.req.valid('json').content_type)
  return c.json(data)
}))

// GET /api/cuenta-cliente/cobros/:id/comprobante-url — firma URL de descarga.
cuentaCliente.get('/cobros/:id/comprobante-url', requirePermiso('certificaciones', 'lectura'), handler(async (c) => {
  const id = Number(c.req.param('id'))
  const obraCod = await cuentaClienteService.getCobroObra(id, c.get('accessToken'))
  if (!obraCod) return c.json({ error: 'Cobro no encontrado' }, 404)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  const data = await cuentaClienteService.getComprobanteUrl(id)
  return c.json(data)
}))

// PATCH /api/cuenta-cliente/cobros/:id
cuentaCliente.patch('/cobros/:id', requirePermiso('certificaciones', 'actualizacion'), zValidator('json', EditarCobroSchema), handler(async (c) => {
  const id = Number(c.req.param('id'))
  const obraCod = await cuentaClienteService.getCobroObra(id, c.get('accessToken'))
  if (!obraCod) return c.json({ error: 'Cobro no encontrado' }, 404)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  const data = await cuentaClienteService.editarCobro(id, c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
}))

// DELETE /api/cuenta-cliente/cobros/:id — desimputa items y borra (RPC).
cuentaCliente.delete('/cobros/:id', requirePermiso('certificaciones', 'eliminacion'), handler(async (c) => {
  const id = Number(c.req.param('id'))
  const obraCod = await cuentaClienteService.getCobroObra(id, c.get('accessToken'))
  if (!obraCod) return c.json({ error: 'Cobro no encontrado' }, 404)
  await validarObraDelUsuario(c.get('user').id, obraCod, 'certificaciones')
  const data = await cuentaClienteService.eliminarCobro(id, c.get('accessToken'), c.get('user').id)
  return c.json(data)
}))

export default cuentaCliente
