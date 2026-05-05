// Cliente para la API de Mobile Quest.
// - Cachea el token en memoria del proceso con TTL conservador.
// - Adapter `parseVehiculoData` aísla el shape concreto del response: si la
//   API devuelve campos con otro nombre, sólo se cambia ese mapper.
//
// Endpoints utilizados:
// - POST {LOGIN_URL}/Login                          → { token }
// - GET  {DATA_URL}/vehiculos                       → lista catálogo
// - GET  {DATA_URL}/vehiculos/datos-ultimos         → última posición/km
//
// Shape de los responses de Mobile Quest (confirmado contra el endpoint real):
//
// GET /vehiculos (catálogo):
//   { id_vehiculo, Alias, Patente }
//   - Patente (mayúscula) es la patente real del vehículo.
//   - Alias es el nombre del chofer (NO sirve como patente).
//
// GET /vehiculos/datos-ultimos (lecturas GPS):
//   { id_vehiculo, VehiculoAlias, TerminalID, FechaHoraAvl,
//     FechaHoraDeLlegadaDeTrama, Latitud, Longitud, velocidad,
//     direcc, hdop, km_total }
//   - NO trae patente. El campo "VehiculoAlias" es el nombre del chofer.
//   - Para conocer la patente hay que hacer JOIN con /vehiculos por id_vehiculo.

// Mobile Quest expone todo bajo UN solo base URL.
// Ej. https://mobilequest.com.ar/gis-api  →  /Login, /vehiculos, /vehiculos/datos-ultimos
const BASE_URL = process.env.MOBILE_QUEST_BASE_URL ?? 'https://mobilequest.com.ar/gis-api'

// TTL del token cacheado (en ms). Conservador: 50 min asumiendo tokens de 1h.
const TOKEN_TTL_MS = 50 * 60 * 1000

interface CachedToken {
  token:     string
  expiresAt: number
}

let cachedToken: CachedToken | null = null

export class MobileQuestError extends Error {
  constructor(public code: string, public detail?: unknown) {
    super(code)
    this.name = 'MobileQuestError'
  }
}

async function fetchToken(): Promise<string> {
  const username = process.env.MOBILE_QUEST_USERNAME
  const password = process.env.MOBILE_QUEST_PASSWORD
  if (!username || !password) {
    throw new MobileQuestError('MQ_CREDENCIALES_MISSING')
  }

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    throw new MobileQuestError('MQ_LOGIN_FAILED', { status: res.status, body: await res.text().catch(() => '') })
  }
  const json = await res.json() as Record<string, unknown>
  // Mobile Quest devuelve el JWT bajo `result`. Aceptamos otros shapes
  // comunes como fallback por si la API cambia.
  const token = (json.result ?? json.token ?? json.accessToken ?? json.access_token ?? json.jwt) as string | undefined
  if (!token || typeof token !== 'string') {
    throw new MobileQuestError('MQ_LOGIN_NO_TOKEN', { json })
  }
  return token
}

async function getToken(forzarRefresh = false): Promise<string> {
  const now = Date.now()
  if (!forzarRefresh && cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token
  }
  const token = await fetchToken()
  cachedToken = { token, expiresAt: now + TOKEN_TTL_MS }
  return token
}

// Wrapper que hace una request autenticada y reintenta una vez si el token
// está vencido (401/403) — refresca y repite.
async function authedGet(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`
  for (let intento = 0; intento < 2; intento++) {
    const token = await getToken(intento > 0)
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401 || res.status === 403) {
      cachedToken = null
      continue
    }
    if (!res.ok) {
      throw new MobileQuestError('MQ_REQUEST_FAILED', { status: res.status, path, body: await res.text().catch(() => '') })
    }
    return res.json()
  }
  throw new MobileQuestError('MQ_AUTH_FAILED', { path })
}

// ── Tipos internos (ya normalizados) ──────────────────────────────────

export interface VehiculoGPS {
  id_vehiculo:    string         // id estable de Mobile Quest (string para evitar pérdida)
  patente:        string         // patente como vino (sin normalizar; eso lo hacemos al matchear)
  modelo?:        string | null
  observaciones?: string | null
}

export interface DatosUltimosGPS {
  id_vehiculo:  string
  patente?:     string | null
  km:           number | null    // null si no vino
  velocidad:    number | null    // km/h
  latitud:      number | null
  longitud:     number | null
  fecha:        string | null    // ISO timestamp si fue parseable
  raw:          unknown          // payload original para debug
}

// Adapter — toma un objeto desconocido y extrae los campos que nos importan.
// Si Mobile Quest cambia los nombres, sólo se toca acá.
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (v != null && typeof v === 'string' && v.trim() !== '') return v.trim()
    if (v != null && typeof v === 'number') return String(v)
  }
  return undefined
}
function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  }
  return null
}
function pickDate(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') {
      const d = new Date(v)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
    if (typeof v === 'number') {
      // timestamps en segundos vs milisegundos
      const ms = v < 1e12 ? v * 1000 : v
      const d = new Date(ms)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
  }
  return null
}

// Mobile Quest expone vehículos "_M" (motor / GPS de respaldo) con patentes
// como `AH568GP_M`. Los km de esos no están actualizados — los ignoramos.
function esVehiculoRespaldo(patente: string): boolean {
  return /_M\b|_M$/i.test(patente.trim())
}

function parseVehiculo(raw: unknown): VehiculoGPS | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id      = pickString(o, ['id_vehiculo', 'id', 'idVehiculo', 'vehicleId', 'codigo'])
  // En el catálogo, la patente real viene en `Patente` (mayúscula).
  const patente = pickString(o, ['Patente', 'patente', 'dominio', 'placa', 'matricula'])
  if (!id || !patente) return null
  // Filtramos los GPS de respaldo "_M" — no son vehículos distintos, son un
  // segundo dispositivo del mismo camión cuyo odómetro no está al día.
  if (esVehiculoRespaldo(patente)) return null
  return {
    id_vehiculo:   id,
    patente,
    // En el catálogo, `Alias` es el nombre del chofer.
    modelo:        pickString(o, ['Alias', 'modelo', 'descripcion']) ?? null,
    observaciones: pickString(o, ['observaciones', 'obs', 'comentario']) ?? null,
  }
}

function parseDatosUltimos(raw: unknown): DatosUltimosGPS | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id_vehiculo = pickString(o, ['id_vehiculo', 'id', 'idVehiculo', 'vehicleId'])
  if (!id_vehiculo) return null
  return {
    id_vehiculo,
    // datos-ultimos NO trae patente — VehiculoAlias es nombre de chofer.
    // Dejamos null y el service hace JOIN con el catálogo.
    patente:   null,
    km:        pickNumber(o, ['km_total', 'km', 'kilometraje', 'kilometros', 'odometro', 'odometer']),
    velocidad: pickNumber(o, ['velocidad', 'speed']),
    latitud:   pickNumber(o, ['Latitud', 'latitud', 'latitude', 'lat']),
    longitud:  pickNumber(o, ['Longitud', 'longitud', 'longitude', 'lng', 'lon']),
    // Preferimos FechaHoraAvl (timestamp del GPS); fallback a fecha de
    // llegada al servidor o nombres genéricos.
    fecha:     pickDate(o,   ['FechaHoraAvl', 'FechaHoraDeLlegadaDeTrama', 'fecha', 'fechaHora', 'fecha_hora', 'timestamp', 'datetime', 'date']),
    raw,
  }
}

// ── API pública ────────────────────────────────────────────────────────

export const mobileQuestClient = {
  /** Lista de vehículos del catálogo. */
  async listarVehiculos(): Promise<VehiculoGPS[]> {
    const json = await authedGet('/vehiculos')
    const arr = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : []
    return (arr as unknown[]).map(parseVehiculo).filter((v): v is VehiculoGPS => v !== null)
  },

  /** Última posición/km de cada vehículo. */
  async datosUltimos(): Promise<DatosUltimosGPS[]> {
    const json = await authedGet('/vehiculos/datos-ultimos')
    const arr = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : []
    return (arr as unknown[]).map(parseDatosUltimos).filter((v): v is DatosUltimosGPS => v !== null)
  },

  /** Útil para tests/debug — no usar en handlers normales. */
  _resetCache() {
    cachedToken = null
  },
}
