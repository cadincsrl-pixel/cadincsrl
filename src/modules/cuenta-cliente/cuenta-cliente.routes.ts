// Endpoint de lectura para el tab "Cuenta del cliente" de certificaciones.
//
// Pensado para la vista que necesita el user: ver qué le debe el cliente
// (`pagado_por='cadinc'`) y qué pagó directo (`pagado_por='cliente'`) por
// obra, agregado en KPIs y desglosado en una tabla.

import { Hono } from 'hono'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { cuentaClienteService } from './cuenta-cliente.service.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const cuentaCliente = new Hono()

cuentaCliente.use('*', authMiddleware)

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

export default cuentaCliente
