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
  if (parts.includes('mover')) return null

  // Acciones especiales de solicitudes
  if (parts.includes('comprar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'comprar' }
  if (parts.includes('despachar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'despachar de depósito' }
  if (parts.includes('enviar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'marcar enviado' }
  if (parts.includes('rechazar')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'rechazar' }
  if (parts.includes('revertir')) return { modulo: 'solicitudes', entidad: 'ítem', accion: 'revertir' }

  // Acciones especiales de obras (archivar/desarchivar individual)
  if (parts.includes('archivar')) return { modulo: 'obras', entidad: 'obra', accion: 'archivar' }
  if (parts.includes('desarchivar')) return { modulo: 'obras', entidad: 'obra', accion: 'desarchivar' }

  // Ciclo de vida de una liquidación de chofer. Sin esto quedaban registradas
  // como 'actualizar liquidación' y era imposible distinguir un cierre de una
  // reapertura: reconstruir el incidente del 2026-07-26 (las cáscaras 23 y 25)
  // requirió aparear timestamps al milisegundo.
  if (parts.includes('liquidaciones')) {
    if (parts.includes('cerrar'))  return { modulo: 'liquidaciones', entidad: 'liquidación', accion: 'cerrar' }
    if (parts.includes('reabrir')) return { modulo: 'liquidaciones', entidad: 'liquidación', accion: 'reabrir' }
  }

  // Mapeo de módulos
  const ENTIDADES: Record<string, string> = {
    solicitudes: 'solicitud',
    proveedores: 'proveedor',
    'facturas-compra': 'factura',
    stock: parts[1] === 'materiales' ? 'material' : parts[1] === 'rubros' ? 'rubro' : parts[1] === 'movimientos' ? 'movimiento stock' : 'stock',
    obras: 'obra',
    personal: 'personal',
    horas: 'hora',
    'hs-extras': 'hs extra',
    categorias: 'categoría',
    tarifas: 'tarifa',
    contratistas: parts[1] === 'cert' ? 'certificación contratista'
      : parts[1] === 'presupuestos' ? 'presupuesto contratista'
      : parts[1] === 'asig' ? 'asignación contratista'
      : 'contratista',
    certificaciones: parts[1] === 'materiales' ? 'material cert.' : parts[1] === 'adicionales' ? 'adicional' : 'certificación',
    usuarios: 'usuario',
    herramientas: 'herramienta',
    caja: 'movimiento caja',
  }

  const entidad = ENTIDADES[modulo] ?? modulo

  return { modulo, entidad, accion }
}

// Resume el body del request como texto plano: "campo=valor · campo=valor".
// Omite claves sensibles, valores vacíos y valores demasiado largos (URLs).
const CLAVES_OMITIDAS = new Set([
  'password', 'token', 'access_token', 'refresh_token',
  'created_by', 'updated_by',
])
function formatearBody(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const partes: string[] = []
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (CLAVES_OMITIDAS.has(k)) continue
    if (v === null || v === undefined || v === '') continue
    let val: string
    if (typeof v === 'string') {
      if (v.length > 80) continue // URLs largas u observaciones extensas
      val = v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      val = String(v)
    } else if (Array.isArray(v)) {
      val = `[${v.length}]`
    } else {
      continue
    }
    partes.push(`${k}=${val}`)
  }
  const out = partes.join(' · ')
  return out.length > 500 ? out.slice(0, 497) + '...' : out
}

export async function auditMiddleware(c: Context, next: Next) {
  const method = c.req.method

  // Clonamos el request antes del next() (el handler puede consumir el body).
  // El parse JSON lo diferimos a después del next() — así no pagamos
  // JSON.parse en requests que terminan en 4xx (validación zod, etc.).
  let rawBodyClone: Request | null = null
  // DELETE incluido: algunos borrados destructivos llevan body con el motivo o
  // con un flag de override (ej. `confirmar_pisar_historico` al borrar una
  // tarifa ya cobrada). Sin esto, forzar ese borrado quedaba en el log
  // indistinguible de borrar una tarifa que no se usó nunca. Los DELETE sin
  // body siguen logueando detalle vacío: el parse ya está en try/catch.
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    try { rawBodyClone = c.req.raw.clone() } catch { /* noop */ }
  }

  await next()

  // Solo loguear si la respuesta fue exitosa (2xx).
  if (c.res.status < 200 || c.res.status >= 300) return

  const path = c.req.path
  const parsed = parseRoute(path, method)
  if (!parsed) return

  const user = c.get('user') as { id: string } | undefined
  if (!user) return

  // Parse del body diferido: solo ejecutamos JSON.parse si vamos a loguear.
  let detalle = ''
  if (rawBodyClone) {
    try {
      const body = await rawBodyClone.json()
      detalle = formatearBody(body)
    } catch { /* body no-JSON o vacío */ }
  }

  // Extraer ID de entidad de la URL. Para rutas con verbo al final
  // (/obras/:cod/archivar, /solicitudes/:id/comprar, etc.) el ID es el
  // penúltimo segmento.
  // Todo segmento final que sea una ACCIÓN o un sub-recurso sobre un id: el id
  // es el penúltimo. Sin esto `entidad_id` guardaba la palabra del verbo
  // ("cerrar") en lugar del número, y la auditoría no servía para rastrear qué
  // registro se tocó — el agujero que hizo imposible reconstruir de un vistazo
  // lo del 2026-07-26. La lista sale de barrer las rutas mutativas del repo:
  //   grep -rhoE "\.(post|patch|put|delete)\('/[^']*:[a-zA-Z]+/[a-z-]+'" src/modules/
  // Si agregás una ruta con verbo al final, sumala acá.
  const VERBOS_SUFIJO = new Set([
    'archivar', 'desarchivar',
    'comprar', 'despachar', 'enviar', 'rechazar', 'revertir',
    'mover',
    // Liquidaciones de chofer
    'cerrar', 'reabrir',
    // Gastos de logística
    'aprobar', 'marcar-pagado',
    // Tramos
    'descarga', 'revertir-descarga',
    // Facturación
    'cobrar',
    // Solicitudes
    'revertir-envio',
    // Personal / usuarios
    'baja', 'reset-password', 'semana',
    // Sub-recursos colgados de un id
    'seguro-poliza', 'remito', 'modelos',
    // Adjuntos de contratistas: /:id/dni, /presupuestos/:id/doc y sus
    // /upload-url (se saltan en cadena: /presupuestos/5/doc/upload-url → 5)
    'dni', 'doc', 'upload-url',
    // OJO: 'maquinas' y 'obras' NO van acá aunque existan como
    // /maquinas/:id/... — también son colecciones (`POST /api/alquiler/maquinas`,
    // `POST /api/alquiler/obras`), y ahí el penúltimo segmento es el módulo, no
    // un id: guardaría entidad_id='alquiler'. Antes de sumar un nombre a esta
    // lista, verificá que no exista también como ruta de colección.
  ])
  const urlParts = path.split('/')
  // Se saltan todos los sufijos encadenados: /presupuestos/5/doc/upload-url
  // → 'upload-url' y 'doc' son sufijos → el id es '5'.
  let idx = urlParts.length - 1
  while (idx > 0 && VERBOS_SUFIJO.has(urlParts[idx] ?? '')) idx--
  const entidadId = urlParts.length > 3 ? urlParts[idx] : undefined

  const token = c.get('accessToken') as string
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? ''

  // Fire-and-forget: la Promise se ejecuta en el event loop mientras la
  // response ya se devuelve al cliente. auditService.log tiene su propio
  // try/catch; el .catch() acá es solo para evitar el warning de
  // "unhandled promise rejection" en algunas versiones de Node.
  auditService.log({
    user_id: user.id,
    user_nombre: '',
    modulo: parsed.modulo,
    accion: parsed.accion,
    entidad: parsed.entidad,
    entidad_id: entidadId !== parsed.modulo ? entidadId : undefined,
    detalle: detalle || undefined,
    ip,
  }, token).catch(() => {/* service ya loguea errores con console.error */})
}
