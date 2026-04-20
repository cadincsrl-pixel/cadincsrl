import type { Context, Next } from 'hono'
import { auditService } from '../modules/admin/audit.service.js'

// Mapeo de rutas a entidades legibles
function parseRoute(path: string, method: string): { modulo: string; entidad: string; accion: string } | null {
  // Ignorar GETs y rutas internas
  if (method === 'GET') return null

  const parts = path.replace('/api/', '').split('/')
  const modulo = parts[0] ?? ''
  const accion = method === 'POST' ? 'crear' : method === 'PATCH' || method === 'PUT' ? 'actualizar' : method === 'DELETE' ? 'eliminar' : method

  // Rutas de mantenimiento/bulk: no loguear (se dispararían en cada mount)
  if (parts.includes('auto-archivar')) return null

  // Acciones especiales de solicitudes
  if (parts.includes('comprar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'comprar' }
  if (parts.includes('despachar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'despachar de depósito' }
  if (parts.includes('enviar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'marcar enviado' }
  if (parts.includes('rechazar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'rechazar' }
  if (parts.includes('revertir')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'revertir' }

  // Acciones especiales de obras (archivar/desarchivar individual)
  if (parts.includes('archivar')) return { modulo: 'obras', entidad: 'obra', accion: 'archivar' }
  if (parts.includes('desarchivar')) return { modulo: 'obras', entidad: 'obra', accion: 'desarchivar' }

  // Mapeo de módulos
  const ENTIDADES: Record<string, string> = {
    solicitudes: 'solicitud',
    proveedores: 'proveedor',
    'facturas-compra': 'factura',
    stock: parts[1] === 'materiales' ? 'material' : parts[1] === 'rubros' ? 'rubro' : parts[1] === 'movimientos' ? 'movimiento stock' : 'stock',
    obras: 'obra',
    personal: 'personal',
    horas: 'hora',
    categorias: 'categoría',
    tarifas: 'tarifa',
    contratistas: 'contratista',
    certificaciones: parts[1] === 'materiales' ? 'material cert.' : parts[1] === 'adicionales' ? 'adicional' : 'certificación',
    usuarios: 'usuario',
    herramientas: 'herramienta',
    caja: 'movimiento caja',
  }

  const entidad = ENTIDADES[modulo] ?? modulo

  return { modulo, entidad, accion }
}

export async function auditMiddleware(c: Context, next: Next) {
  await next()

  // Solo loguear si la respuesta fue exitosa (2xx)
  if (c.res.status < 200 || c.res.status >= 300) return

  const method = c.req.method
  const path = c.req.path
  const parsed = parseRoute(path, method)
  if (!parsed) return

  const user = c.get('user') as { id: string } | undefined
  if (!user) return

  // Extraer ID de entidad de la URL. Para rutas con verbo al final
  // (/obras/:cod/archivar, /solicitudes/:id/comprar, etc.) el ID es el
  // penúltimo segmento.
  const VERBOS_SUFIJO = new Set([
    'archivar', 'desarchivar',
    'comprar', 'despachar', 'enviar', 'rechazar', 'revertir',
  ])
  const urlParts = path.split('/')
  const last = urlParts[urlParts.length - 1] ?? ''
  const prev = urlParts[urlParts.length - 2] ?? ''
  const entidadId = urlParts.length > 3
    ? (VERBOS_SUFIJO.has(last) ? prev : last)
    : undefined

  // Nombre del usuario (del perfil en el token o del contexto)
  const token = c.get('accessToken') as string
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? ''

  auditService.log({
    user_id: user.id,
    user_nombre: '', // Se llena desde el perfil si se necesita
    modulo: parsed.modulo,
    accion: parsed.accion,
    entidad: parsed.entidad,
    entidad_id: entidadId !== parsed.modulo ? entidadId : undefined,
    ip,
  }, token)
}
