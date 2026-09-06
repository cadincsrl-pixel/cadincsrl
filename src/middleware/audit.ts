import type { Context, Next } from 'hono'
import { auditService, type AuditEntry } from '../modules/admin/audit.service.js'
import { supabase } from '../lib/supabase.js'

/**
 * Auditoría automática de la API.
 *
 * Corre después del handler y deja una fila en audit_log por cada request
 * mutativo (POST/PATCH/PUT/DELETE) que terminó en 2xx, y una fila con
 * accion='denegado' por cada 403. No se escribe auditoría manual en los
 * handlers: todo pasa por acá, más los triggers `audit_cambios` de la base
 * (migración 20260906l) que guardan el ANTES/DESPUÉS de las tablas sensibles.
 *
 * Qué guarda de cada request:
 *   - modulo / entidad / accion legibles, a partir de la ruta (parseRoute).
 *   - entidad_id: el id de la URL o, en un POST que crea, el id que devolvió
 *     la respuesta.
 *   - detalle: el body resumido ("campo=valor · ..."); los textos de
 *     motivo/obs/nota van completos (hasta 300 caracteres).
 *   - user_id + user_nombre (cacheado 10 min) + la IP real del cliente.
 *
 * Excepción: la carga de horas de tarja (PUT /api/horas, una request por
 * celda) se acumula en memoria y se escribe UNA fila por usuario+obra+semana
 * cuando pasan 90 s sin cargas, o al apagarse el proceso. Antes eran ~120
 * filas por día que tapaban todo lo demás.
 */

// ── Qué es cada ruta ───────────────────────────────────────────────────────

export interface RutaAuditada {
  modulo: string
  entidad: string
  accion: string
  entidadId?: string
}

/** POSTs que son consultas (geocoding, sugerencia de km): no son mutaciones. */
const SIN_AUDITAR = [/^logistica\/maps\//]

/**
 * Verbo al final de la ruta → acción legible. Se sacan de la cola todos los
 * verbos encadenados (/presupuestos/5/doc/upload-url) y el ÚLTIMO manda.
 * Si agregás una ruta con verbo al final, sumala acá; si no, la palabra
 * quedaría como si fuera un id.
 */
export const VERBOS: Record<string, string> = {
  // Obras
  archivar: 'archivar', desarchivar: 'desarchivar', 'auto-archivar': 'auto-archivar',
  // Ítems de solicitud
  comprar: 'comprar', despachar: 'despachar de depósito', enviar: 'marcar enviado',
  rechazar: 'rechazar', revertir: 'revertir', 'revertir-envio': 'revertir envío',
  'comprar-faltante': 'comprar faltante', 'recibir-devolucion': 'recibir devolución',
  'stock-cliente': 'resolver con stock del cliente',
  // Liquidaciones / gastos / cobros
  cerrar: 'cerrar', reabrir: 'reabrir', aprobar: 'aprobar', 'aprobar-lote': 'aprobar en bloque',
  'marcar-pagado': 'marcar pagado', cobrar: 'cobrar', 'contra-factura': 'contra factura',
  // Tramos
  descarga: 'registrar descarga', 'revertir-descarga': 'revertir descarga',
  // Personal / usuarios / tarja
  baja: 'dar de baja', 'reset-password': 'resetear contraseña', semana: 'borrar semana',
  // Varios
  traspaso: 'traspasar', fusionar: 'fusionar', retirar: 'retirar de proveedor',
  'sync-todos': 'sincronizar GPS', 'id-vehiculo': 'vincular GPS',
  'upload-url': 'subir adjunto', 'upload-comprobante': 'subir adjunto', 'comprobante-upload-url': 'subir adjunto',
  remito: 'adjuntar remito', orden: 'reordenar', bulk: 'confirmar en bloque', lote: 'cargar en lote',
  aumento: 'aumento general', chat: 'consultar', entrada: 'entrada', salida: 'salida',
}

/** Entidad legible por "modulo", "modulo/sub" o "modulo/sub/sub2". */
export const ENTIDADES: Record<string, string> = {
  // Tarja y personal
  horas: 'tarja', 'hs-extras': 'hs extra', asignaciones: 'asignación', cierres: 'cierre de semana',
  tarifas: 'tarifa de obra', categorias: 'categoría', 'cat-obra': 'categoría por obra',
  personal: 'trabajador', 'personal/documentos': 'documento de trabajador',
  prestamos: 'préstamo', ropa: 'ropa', 'ropa/categorias': 'categoría de ropa', 'ropa/entregas': 'entrega de ropa',
  obras: 'obra', usuarios: 'usuario', 'usuarios/obras': 'obras del usuario', me: 'mi perfil',
  contratistas: 'contratista', 'contratistas/cert': 'certificación de contratista',
  'contratistas/presupuestos': 'presupuesto de contratista', 'contratistas/asig': 'asignación de contratista',
  // Compras y stock
  solicitudes: 'solicitud', 'solicitudes/items': 'ítem de solicitud',
  proveedores: 'proveedor', 'facturas-compra': 'factura de compra',
  stock: 'stock', 'stock/materiales': 'material', 'stock/rubros': 'rubro', 'stock/movimientos': 'movimiento de stock',
  'stock-proveedor': 'retiro de proveedor', 'stock-cliente': 'stock del cliente',
  'cuenta-cliente': 'cuenta corriente', 'cuenta-cliente/cobros': 'pago del cliente',
  certificaciones: 'certificación', 'certificaciones/materiales': 'material certificado', 'certificaciones/adicionales': 'adicional',
  'remitos-envio': 'remito de envío',
  // Herramientas
  herramientas: 'ficha de herramienta', 'herramientas/movimientos': 'movimiento de herramienta',
  'herramientas/fotos': 'foto de herramienta', 'herramientas/config': 'configuración de herramientas',
  'herramientas/config/tipos': 'categoría de ficha', 'herramientas/config/mov-tipos': 'tipo de movimiento',
  'herramientas/marcas': 'marca', 'herramientas/marcas/modelos': 'modelo', 'herramientas/modelos': 'modelo',
  'herramientas/entregas': 'entrega del pañol', 'herramientas/entregas/retornos': 'retorno del pañol',
  'herramientas/tipos': 'tipo de herramienta',
  // Logística
  logistica: 'logística',
  'logistica/choferes': 'chofer', 'logistica/choferes/documentos': 'documento de chofer',
  'logistica/camiones': 'camión', 'logistica/camiones/documentos': 'documento de camión',
  'logistica/bateas': 'batea', 'logistica/bateas/documentos': 'documento de batea',
  'logistica/lugares': 'lugar', 'logistica/lugares/canteras': 'cantera', 'logistica/lugares/depositos': 'depósito',
  'logistica/lugares/rutas': 'ruta', 'logistica/lugares/operativos': 'operativo',
  'logistica/viajes': 'viaje', 'logistica/viajes/carga': 'carga de viaje', 'logistica/viajes/descarga': 'descarga de viaje',
  'logistica/tramos': 'tramo', 'logistica/tramos/relevo': 'relevo de tramo',
  'logistica/liquidaciones': 'liquidación', 'logistica/liquidaciones/adelantos': 'adelanto',
  'logistica/liquidaciones/estadias': 'estadía', 'logistica/liquidaciones/adjuntos': 'adjunto de liquidación',
  'logistica/tarifas': 'tarifa de cantera', 'logistica/tarifas/canteras': 'tarifa de cantera',
  'logistica/empresas': 'empresa transportista', 'logistica/empresas/tarifas': 'tarifa de empresa',
  'logistica/cobros': 'cobro de flete', 'logistica/cobros/adjuntos': 'adjunto de cobro',
  'logistica/gastos': 'gasto de flota',
  'logistica/rentabilidad': 'rentabilidad', 'logistica/rentabilidad/parametros': 'parámetros de rentabilidad',
  'logistica/rentabilidad/viajes': 'viaje simulado',
  'logistica/camion-services': 'service de camión', 'logistica/camion-cubiertas': 'cubierta',
  'logistica/gps': 'GPS', 'logistica/gps/sync': 'GPS', 'logistica/gps/camion': 'GPS de camión',
  // Flota
  flota: 'flota', 'flota/vehiculos': 'vehículo', 'flota/vehiculos/documentos': 'documento de vehículo',
  'flota/servicios': 'service de vehículo', 'flota/tipos-servicio': 'tipo de service',
  'flota/gastos': 'gasto de vehículo', 'flota/gastos-categorias': 'categoría de gasto', 'flota/gps': 'GPS',
  // Áridos
  aridos: 'áridos', 'aridos/materiales': 'material de áridos', 'aridos/clientes': 'cliente de áridos',
  'aridos/precios': 'precio de áridos', 'aridos/precios-global': 'precio global de áridos',
  'aridos/movimientos': 'venta de áridos', 'aridos/canteras': 'cantera de áridos', 'aridos/unidades': 'unidad de áridos',
  'aridos/municipios': 'municipio', 'aridos/costos-cantera': 'costo de cantera', 'aridos/cobros': 'cobro de áridos',
  'aridos/pagos-cantera': 'pago a cantera',
  // Alquiler
  alquiler: 'alquiler', 'alquiler/maquinas': 'máquina', 'alquiler/maquinas/seguro-poliza': 'póliza de máquina',
  'alquiler/obras': 'obra de alquiler', 'alquiler/obras/maquinas': 'máquina en obra', 'alquiler/obra-maquinas': 'máquina en obra',
  'alquiler/clientes': 'cliente de alquiler', 'alquiler/partes': 'parte diario', 'alquiler/remitos': 'remito de alquiler',
  'alquiler/cobros': 'cobro de alquiler',
  // Otros
  caja: 'caja', 'caja/movimientos': 'movimiento de caja', 'caja/conceptos': 'concepto de caja', 'caja/centros-costo': 'centro de costo',
  oficina: 'oficina', 'oficina/personas': 'persona de oficina', 'oficina/personas/sueldos': 'sueldo de oficina',
  'oficina/sueldos': 'sueldos de oficina',
  asistente: 'asistente IA', admin: 'administración',
}

/** Palabras que aparecen como segmentos de ruta: nunca son un id. */
const PALABRAS_DE_RUTA = new Set<string>([
  ...Object.keys(ENTIDADES).flatMap(k => k.split('/')),
  ...Object.keys(VERBOS),
  'items', 'dni', 'doc', 'carga', 'documentos', 'adjuntos', 'fotos', 'sueldos', 'presupuestos',
])

/**
 * Un segmento es un id si es número, uuid o cualquier cosa que no sea una
 * palabra conocida de ruta: así entran los códigos de obra ("CC PODA",
 * "cc 24"), los legajos, los sem_key y las claves de configuración, y NO
 * entran "adelantos", "tramos" o "auto-archivar" (que antes quedaban
 * guardados como si fueran el id de algo).
 */
export function esId(seg: string): boolean {
  if (!seg) return false
  if (/^\d+$/.test(seg)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true
  return !PALABRAS_DE_RUTA.has(seg.toLowerCase())
}

export function parseRoute(path: string, method: string, opts: { incluirGet?: boolean } = {}): RutaAuditada | null {
  if (method === 'GET' && !opts.incluirGet) return null

  const parts = path.replace(/^\/api\//, '').split('/').filter(Boolean).map(s => {
    try { return decodeURIComponent(s) } catch { return s }
  })
  const modulo = parts[0] ?? ''
  if (!modulo) return null
  if (SIN_AUDITAR.some(re => re.test(parts.join('/')))) return null
  // Rutas de mantenimiento/bulk: no loguear (se dispararían en cada mount).
  if (parts.includes('mover')) return null

  // Verbos encadenados al final: el último manda.
  const resto = parts.slice(1)
  let accion: string | null = null
  while (resto.length > 0) {
    const ultimo = resto[resto.length - 1] ?? ''
    const verbo = VERBOS[ultimo]
    if (verbo === undefined) break
    resto.pop()
    accion ??= verbo
  }
  if (!accion) {
    accion = method === 'POST' ? 'crear'
      : method === 'PATCH' || method === 'PUT' ? 'actualizar'
      : method === 'DELETE' ? 'eliminar'
      : method.toLowerCase()
  }

  // Sub-recursos e ids. Dos ids seguidos (cierres/CC-025/2026-09-04) forman
  // una clave compuesta; si hay un sub-recurso en el medio
  // (personal/060/documentos/12) manda el último id.
  const subs: string[] = []
  const idsSeguidos: string[] = []
  let ultimoId: string | undefined
  for (const seg of resto) {
    if (esId(seg)) {
      idsSeguidos.push(seg)
      ultimoId = seg
    } else {
      subs.push(seg)
      idsSeguidos.length = 0
    }
  }
  const entidadId = idsSeguidos.length > 1 ? idsSeguidos.join(' · ') : ultimoId

  const entidad = ENTIDADES[`${modulo}/${subs.join('/')}`]
    ?? (subs.length > 1 ? ENTIDADES[`${modulo}/${subs[subs.length - 1]}`] : undefined)
    ?? (subs.length > 0 ? ENTIDADES[`${modulo}/${subs[0]}`] : undefined)
    ?? ENTIDADES[modulo]
    ?? modulo

  return { modulo, entidad, accion, ...(entidadId !== undefined ? { entidadId } : {}) }
}

// ── Resumen del body ───────────────────────────────────────────────────────

const CLAVES_OMITIDAS = new Set([
  'password', 'token', 'access_token', 'refresh_token',
  'created_by', 'updated_by',
])
/** Textos que sí queremos enteros: son el "por qué" de la acción. */
const CLAVES_LARGAS = new Set([
  'obs', 'observaciones', 'motivo', 'nota', 'notas', 'comentario', 'comentarios',
  'descripcion', 'detalle', 'mensaje', 'pregunta', 'justificacion',
])
const MAX_TEXTO_LARGO = 300
const MAX_DETALLE = 1000

/** "[n] clave: a, b, c (+k)" para arrays de objetos; "[n] a, b, c" para escalares. */
function resumirArray(arr: unknown[]): string {
  const n = arr.length
  if (n === 0) return '[0]'
  const cabeza = `[${n}]`
  if (arr.every(x => typeof x === 'number' || (typeof x === 'string' && x.length <= 30))) {
    return `${cabeza} ${arr.slice(0, 10).join(', ')}${n > 10 ? ` (+${n - 10})` : ''}`
  }
  const primero = arr[0]
  if (primero && typeof primero === 'object' && !Array.isArray(primero)) {
    const clave = ['id', 'item_id', 'leg', 'herramienta_id', 'material_id', 'tramo_id', 'gasto_id', 'obra_cod']
      .find(k => (primero as Record<string, unknown>)[k] !== undefined)
    if (clave) {
      const valores = [...new Set(arr
        .map(x => (x && typeof x === 'object') ? (x as Record<string, unknown>)[clave] : undefined)
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map(String))]
      return `${cabeza} ${clave}: ${valores.slice(0, 10).join(', ')}${valores.length > 10 ? ` (+${valores.length - 10})` : ''}`
    }
  }
  return cabeza
}

/** Resume el body como texto plano: "campo=valor · campo=valor". */
export function formatearBody(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  if (Array.isArray(body)) return resumirArray(body)
  const partes: string[] = []
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (CLAVES_OMITIDAS.has(k)) continue
    if (v === null || v === undefined || v === '') continue
    let val: string
    if (typeof v === 'string') {
      if (CLAVES_LARGAS.has(k)) {
        val = v.length > MAX_TEXTO_LARGO ? v.slice(0, MAX_TEXTO_LARGO - 1) + '…' : v
      } else {
        if (v.length > 80) continue // URLs, paths de storage, base64
        val = v
      }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      val = String(v)
    } else if (Array.isArray(v)) {
      val = resumirArray(v)
    } else {
      continue
    }
    partes.push(`${k}=${val}`)
  }
  const out = partes.join(' · ')
  return out.length > MAX_DETALLE ? out.slice(0, MAX_DETALLE - 3) + '...' : out
}

/** Id del registro creado, según cómo lo devuelva el handler. */
export function extraerId(j: unknown): string | undefined {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const o = j as Record<string, unknown>
  for (const k of ['id', 'cod', 'leg', 'numero']) {
    const v = o[k]
    if (typeof v === 'number' || (typeof v === 'string' && v !== '')) return String(v)
  }
  for (const k of ['data', 'item', 'solicitud', 'remito', 'movimiento', 'tramo', 'liquidacion']) {
    const v = o[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const id = extraerId(v)
      if (id) return id
    }
  }
  return undefined
}

async function idDeRespuesta(res: Response | null): Promise<string | undefined> {
  if (!res) return undefined
  try {
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return undefined
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > 200_000) return undefined
    return extraerId(await res.json())
  } catch {
    return undefined
  }
}

function clonarRespuesta(c: Context): Response | null {
  try { return c.res.clone() } catch { return null }
}

// ── Usuario e IP ───────────────────────────────────────────────────────────

const NOMBRE_TTL_MS = 10 * 60_000
const nombres = new Map<string, { nombre: string; hasta: number }>()

async function nombreDe(userId: string): Promise<string> {
  const ahora = Date.now()
  const hit = nombres.get(userId)
  if (hit && hit.hasta > ahora) return hit.nombre
  try {
    const { data } = await supabase.from('profiles').select('nombre').eq('id', userId).maybeSingle()
    const nombre = (data as { nombre?: string | null } | null)?.nombre ?? ''
    nombres.set(userId, { nombre, hasta: ahora + NOMBRE_TTL_MS })
    return nombre
  } catch {
    return hit?.nombre ?? ''
  }
}

/** La IP del cliente: el primer salto de x-forwarded-for (después vienen Cloudflare/Render). */
function ipCliente(c: Context): string {
  const xff = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? ''
  return (xff.split(',')[0] ?? '').trim()
}

async function guardar(entry: Omit<AuditEntry, 'user_nombre'>): Promise<void> {
  try {
    const user_nombre = await nombreDe(entry.user_id)
    await auditService.log({ ...entry, user_nombre })
  } catch {
    // auditService.log ya reporta por console.error; acá solo evitamos el
    // "unhandled promise rejection".
  }
}

// ── Tarja: una fila por obra+semana en lugar de una por celda ──────────────

interface LoteTarja {
  userId: string
  obra: string
  semana: string
  celdas: Map<string, number> // `${leg}|${fecha}` → último valor cargado
  primero: number
  ultimo: number
  ip: string
  timer: ReturnType<typeof setTimeout>
}

const TARJA_ESPERA_MS = 90_000
const TARJA_MAX_CELDAS = 400
const lotesTarja = new Map<string, LoteTarja>()

/** Viernes de la semana CADINC (viernes → jueves) a la que pertenece la fecha. */
export function viernesDe(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number)
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  const diff = (dt.getUTCDay() - 5 + 7) % 7
  dt.setUTCDate(dt.getUTCDate() - diff)
  return dt.toISOString().slice(0, 10)
}

const fmtHoraArg = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false,
})
const fmtHs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','))

function listarLegajos(legajos: Iterable<string>): string {
  const lista = [...new Set(legajos)].sort()
  return `legajos ${lista.slice(0, 15).join(', ')}${lista.length > 15 ? ` (+${lista.length - 15})` : ''}`
}

interface CeldaTarja { obra_cod: string; fecha: string; leg: string; horas: number }

function acumularCelda(userId: string, ip: string, celda: CeldaTarja): void {
  const semana = viernesDe(celda.fecha)
  const key = `${userId}|${celda.obra_cod}|${semana}`
  const ahora = Date.now()
  let lote = lotesTarja.get(key)
  if (lote) {
    clearTimeout(lote.timer)
  } else {
    lote = { userId, obra: celda.obra_cod, semana, celdas: new Map(), primero: ahora, ultimo: ahora, ip, timer: setTimeout(() => {}, 0) }
    lotesTarja.set(key, lote)
  }
  lote.timer = setTimeout(() => { void flushLote(key) }, TARJA_ESPERA_MS)
  lote.timer.unref?.()
  lote.celdas.set(`${celda.leg}|${celda.fecha}`, celda.horas)
  lote.ultimo = ahora
  if (lote.celdas.size >= TARJA_MAX_CELDAS) void flushLote(key)
}

async function flushLote(key: string): Promise<void> {
  const lote = lotesTarja.get(key)
  if (!lote) return
  lotesTarja.delete(key)
  clearTimeout(lote.timer)
  const legajos = [...lote.celdas.keys()].map(k => k.split('|')[0] ?? '')
  const totalHs = [...lote.celdas.values()].reduce((a, b) => a + b, 0)
  const n = lote.celdas.size
  const detalle = [
    `semana del ${lote.semana}`,
    `${n} ${n === 1 ? 'celda' : 'celdas'}`,
    listarLegajos(legajos),
    `${fmtHs(totalHs)} hs`,
    `${fmtHoraArg.format(lote.primero)}–${fmtHoraArg.format(lote.ultimo)}`,
  ].join(' · ')
  await guardar({
    user_id: lote.userId, modulo: 'horas', accion: 'cargar horas', entidad: 'tarja',
    entidad_id: lote.obra, detalle, ip: lote.ip,
  })
}

/** Escribe todo lo acumulado. Se llama al apagar el proceso (y en tests). */
export async function flushAuditoriaPendiente(): Promise<void> {
  await Promise.all([...lotesTarja.keys()].map(k => flushLote(k)))
}

/** Resumen del PUT /api/horas/lote (copia de semana / placeholders). */
export function resumirLoteTarja(body: unknown): { accion: string; detalle: string } {
  const b = (body ?? {}) as { horas?: unknown; solo_nuevas?: boolean }
  const celdas = (Array.isArray(b.horas) ? b.horas : [])
    .filter((x): x is { fecha: string; leg: string; horas: number } => !!x && typeof x === 'object')
  const semanas = [...new Set(celdas.map(x => viernesDe(String(x.fecha))))].sort()
  const total = celdas.reduce((a, x) => a + (Number(x.horas) || 0), 0)
  const partes = [
    semanas.length ? `semana del ${semanas.join(', ')}` : null,
    `${celdas.length} ${celdas.length === 1 ? 'celda' : 'celdas'}`,
    celdas.length ? listarLegajos(celdas.map(x => String(x.leg))) : null,
    `${fmtHs(total)} hs`,
    b.solo_nuevas ? 'solo celdas nuevas (placeholders)' : null,
  ].filter((p): p is string => !!p)
  return { accion: b.solo_nuevas ? 'poblar semana' : 'cargar en lote', detalle: partes.join(' · ') }
}

// ── Intentos rechazados ────────────────────────────────────────────────────

function mensajeDeError(texto: string): string {
  const t = texto.trim().slice(0, 200)
  try {
    const j = JSON.parse(t) as { error?: unknown; message?: unknown }
    const m = j.error ?? j.message
    if (typeof m === 'string') return m
  } catch { /* texto plano */ }
  return t
}

function registrarDenegado(c: Context, userId: string, path: string, method: string): void {
  // Los GET rechazados solo interesan en admin/usuarios: en el resto suelen
  // ser la UI pidiendo algo antes de tener los permisos cargados.
  const esAdminGet = method === 'GET' && /^\/api\/(admin|usuarios)(\/|$)/.test(path)
  if (method === 'GET' && !esAdminGet) return
  const parsed = parseRoute(path, method, { incluirGet: true })
  const modulo = parsed?.modulo ?? (path.split('/')[2] ?? '?')
  const resClone = clonarRespuesta(c)
  const ip = ipCliente(c)
  void (async () => {
    let msg = ''
    try { msg = resClone ? mensajeDeError(await resClone.text()) : '' } catch { /* sin body */ }
    await guardar({
      user_id: userId, modulo, accion: 'denegado', entidad: parsed?.entidad ?? modulo,
      ...(parsed?.entidadId ? { entidad_id: parsed.entidadId } : {}),
      detalle: `HTTP 403 ${method} ${path}${msg ? ` · ${msg}` : ''}`, ip,
    })
  })()
}

// ── Middleware ─────────────────────────────────────────────────────────────

export async function auditMiddleware(c: Context, next: Next) {
  const method = c.req.method

  // Clonamos el request antes del next() (el handler consume el body). El
  // parse JSON se difiere a después: no se paga en requests que terminan en
  // 4xx. DELETE incluido: algunos borrados llevan el motivo o un flag de
  // override en el body.
  let rawBodyClone: Request | null = null
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    try { rawBodyClone = c.req.raw.clone() } catch { /* noop */ }
  }

  await next()

  const user = c.get('user') as { id: string } | undefined
  if (!user) return
  const status = c.res.status
  const path = c.req.path

  if (status === 403) {
    registrarDenegado(c, user.id, path, method)
    return
  }
  if (status < 200 || status >= 300) return

  const parsed = parseRoute(path, method)
  if (!parsed) return

  let body: unknown = null
  if (rawBodyClone) {
    try { body = await rawBodyClone.json() } catch { /* body vacío o no-JSON */ }
  }
  const ip = ipCliente(c)

  // Tarja: por celda se acumula; el lote se resume en una fila.
  if (parsed.modulo === 'horas' && method === 'PUT') {
    const b = body as Partial<CeldaTarja & { horas: unknown; solo_nuevas: boolean }> | null
    if (path.replace(/\/+$/, '').endsWith('/lote')) {
      const { accion, detalle } = resumirLoteTarja(body)
      void guardar({
        user_id: user.id, modulo: 'horas', accion, entidad: 'tarja',
        ...(b?.obra_cod ? { entidad_id: String(b.obra_cod) } : {}), detalle, ip,
      })
      return
    }
    if (b && typeof b.obra_cod === 'string' && typeof b.fecha === 'string' && typeof b.leg === 'string' && typeof b.horas === 'number') {
      acumularCelda(user.id, ip, { obra_cod: b.obra_cod, fecha: b.fecha, leg: b.leg, horas: b.horas })
      return
    }
  }

  // En un POST que crea, el id está en la respuesta, no en la URL.
  const resClone = method === 'POST' && !parsed.entidadId ? clonarRespuesta(c) : null
  const detalle = formatearBody(body)

  // Fire-and-forget: la response ya se devuelve al cliente.
  void (async () => {
    const entidadId = parsed.entidadId ?? await idDeRespuesta(resClone)
    await guardar({
      user_id: user.id, modulo: parsed.modulo, accion: parsed.accion, entidad: parsed.entidad,
      ...(entidadId ? { entidad_id: entidadId } : {}),
      ...(detalle ? { detalle } : {}),
      ip,
    })
  })()
}
