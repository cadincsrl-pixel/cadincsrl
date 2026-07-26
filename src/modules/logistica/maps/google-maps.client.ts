// Cliente de Google Maps Platform.
// - Geocoding API:        para resolver direcciones (ej. "CRISTAMINE, Salta") → {lat, lng}
// - Distance Matrix API:  para calcular distancia/duración por carretera entre 2 coords
//
// Autenticación: API key vía env GOOGLE_MAPS_API_KEY. La restricción por
// IP/dominio se configura en Google Cloud Console.

const GEOCODE_URL  = 'https://maps.googleapis.com/maps/api/geocode/json'
const DM_URL       = 'https://maps.googleapis.com/maps/api/distancematrix/json'

export class GoogleMapsError extends Error {
  constructor(public code: string, public detail?: unknown) {
    super(code)
    this.name = 'GoogleMapsError'
  }
}

function getKey(): string {
  const k = process.env.GOOGLE_MAPS_API_KEY
  if (!k) throw new GoogleMapsError('GOOGLE_MAPS_API_KEY_MISSING')
  return k
}

// ── Geocoding ──────────────────────────────────────────────────────

export interface GeocodeResult {
  lat:               number
  lng:               number
  formatted_address: string
}

export async function geocode(direccion: string): Promise<GeocodeResult> {
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(direccion)}&key=${getKey()}`
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) throw new GoogleMapsError('GEOCODE_HTTP_FAIL', { status: res.status })
  const json = await res.json() as any
  if (json.status !== 'OK') {
    throw new GoogleMapsError('GEOCODE_FAIL', { status: json.status, message: json.error_message })
  }
  const result = json.results?.[0]
  if (!result) throw new GoogleMapsError('GEOCODE_NO_RESULTS')
  return {
    lat:               result.geometry.location.lat,
    lng:               result.geometry.location.lng,
    formatted_address: result.formatted_address,
  }
}

// ── Resolver pin de un link de Google Maps ────────────────────────
//
// Los usuarios cargan `maps_url` (Compartir → Copiar link) que apunta al
// punto EXACTO del lugar. Geocodificar por nombre+localidad muchas veces
// cae en el centro del pueblo (caso MARCAMPO: ~19 km de la planta real).
// Esta función saca lat/lng del propio link: resuelve el shortlink
// (maps.app.goo.gl) siguiendo el redirect y extrae las coords de la URL
// final. No usa la API de Google → no necesita key ni tiene costo.

export interface PinResult {
  lat:    number
  lng:    number
  // 'pin' = coordenadas exactas del marcador (!3d/!4d o ?q=).
  // 'aprox' = solo se pudo leer el centro del mapa (@lat,lng) — cercano
  // al pin en links de Compartir, pero no exacto.
  fuente: 'pin' | 'aprox'
}

const HOSTS_MAPS_CORTOS = new Set(['maps.app.goo.gl', 'goo.gl'])

function esHostGoogleMaps(hostname: string): boolean {
  if (HOSTS_MAPS_CORTOS.has(hostname)) return true
  // google.com, www.google.com, maps.google.com, google.com.ar, etc.
  return /^(www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(hostname)
}

function extraerCoords(url: string): PinResult | null {
  const valida = (lat: number, lng: number) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

  // Pin exacto: último par !3d<lat>!4d<lng> de la URL (el marcador del lugar).
  const pin = [...url.matchAll(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/g)].at(-1)
  if (pin) {
    const lat = Number(pin[1]), lng = Number(pin[2])
    if (valida(lat, lng)) return { lat, lng, fuente: 'pin' }
  }
  // Forma ?q=lat,lng (links armados a mano o viejos).
  const q = url.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/)
  if (q) {
    const lat = Number(q[1]), lng = Number(q[2])
    if (valida(lat, lng)) return { lat, lng, fuente: 'pin' }
  }
  // Centro del viewport @lat,lng — aproximado, último recurso.
  const at = url.match(/\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/)
  if (at) {
    const lat = Number(at[1]), lng = Number(at[2])
    if (valida(lat, lng)) return { lat, lng, fuente: 'aprox' }
  }
  return null
}

export async function resolverPinDeUrl(mapsUrl: string): Promise<PinResult> {
  let parsed: URL
  try {
    parsed = new URL(mapsUrl)
  } catch {
    throw new GoogleMapsError('MAPS_URL_INVALIDA')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !esHostGoogleMaps(parsed.hostname)) {
    throw new GoogleMapsError('MAPS_URL_INVALIDA')
  }

  // Si el link largo ya trae coords, no hace falta pegarle a Google.
  const directo = extraerCoords(mapsUrl)
  if (directo) return directo

  // Shortlink (o link largo sin coords): seguir redirects y leer la URL final.
  let finalUrl: string
  try {
    const res = await fetch(mapsUrl, {
      method:   'GET',
      redirect: 'follow',
      headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; cadinc-erp/1.0)' },
    })
    finalUrl = res.url
    // Cortamos el body: solo nos interesa la URL resuelta.
    await res.body?.cancel()
  } catch (err) {
    throw new GoogleMapsError('MAPS_URL_FETCH_FAIL', { message: (err as Error)?.message })
  }

  const coords = extraerCoords(finalUrl)
  if (!coords) throw new GoogleMapsError('MAPS_URL_SIN_COORDS', { finalUrl })
  return coords
}

// ── Distance Matrix ───────────────────────────────────────────────

export interface DistanceResult {
  // Distancia en metros por carretera.
  distancia_m:    number
  // Duración estimada en segundos (sin tráfico).
  duracion_s:     number
  // Duración estimada en segundos CON tráfico (si Google la provee).
  duracion_traffic_s: number | null
}

export async function distancia(
  origenLat: number, origenLng: number,
  destinoLat: number, destinoLng: number,
): Promise<DistanceResult> {
  const params = new URLSearchParams({
    origins:      `${origenLat},${origenLng}`,
    destinations: `${destinoLat},${destinoLng}`,
    mode:         'driving',
    units:        'metric',
    departure_time: 'now',  // habilita duracion_traffic
    key:          getKey(),
  })
  const res = await fetch(`${DM_URL}?${params.toString()}`, { method: 'GET' })
  if (!res.ok) throw new GoogleMapsError('DM_HTTP_FAIL', { status: res.status })
  const json = await res.json() as any
  if (json.status !== 'OK') {
    throw new GoogleMapsError('DM_FAIL', { status: json.status, message: json.error_message })
  }
  const elem = json.rows?.[0]?.elements?.[0]
  if (!elem || elem.status !== 'OK') {
    throw new GoogleMapsError('DM_ELEMENT_FAIL', { status: elem?.status })
  }
  return {
    distancia_m:        elem.distance.value,
    duracion_s:         elem.duration.value,
    duracion_traffic_s: elem.duration_in_traffic?.value ?? null,
  }
}

// ── Cache simple en memoria del proceso ──────────────────────────
//
// Distance Matrix cuesta $5/1000 elementos. Cacheamos por par
// (origen redondeado a 100m × destino redondeado a 100m) por 5 minutos.
// Eso evita pegarle 100 veces a Google por el mismo camión que
// reportó posiciones casi idénticas en cada poll.

interface CacheEntry {
  result:    DistanceResult
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const TTL_MS = 5 * 60 * 1000

// Redondea coords a 4 decimales (~11 metros) para mejorar hits de cache.
function cacheKey(oLat: number, oLng: number, dLat: number, dLng: number): string {
  const r = (n: number) => n.toFixed(4)
  return `${r(oLat)},${r(oLng)}|${r(dLat)},${r(dLng)}`
}

export async function distanciaCacheada(
  origenLat: number, origenLng: number,
  destinoLat: number, destinoLng: number,
): Promise<DistanceResult> {
  const k = cacheKey(origenLat, origenLng, destinoLat, destinoLng)
  const now = Date.now()
  const cached = cache.get(k)
  if (cached && cached.expiresAt > now) return cached.result

  const result = await distancia(origenLat, origenLng, destinoLat, destinoLng)
  cache.set(k, { result, expiresAt: now + TTL_MS })

  // Limpiar entradas viejas si la cache crece (prevención de leak).
  if (cache.size > 500) {
    for (const [key, val] of cache.entries()) {
      if (val.expiresAt < now) cache.delete(key)
    }
  }
  return result
}
