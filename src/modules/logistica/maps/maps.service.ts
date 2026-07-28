import { createSupabaseClient } from '../../../lib/supabase.js'
import { distanciaCacheada, geocode, resolverPinDeUrl, GoogleMapsError } from './google-maps.client.js'

export class MapsError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'MapsError'
  }
}

export interface TramoEnRuta {
  tramo_id:        number
  // 'cargado' = camión llevando producto cantera→depósito.
  // 'vacio'   = camión volviendo depósito→cantera para nueva carga.
  tipo:            'cargado' | 'vacio'
  // Identificación visible
  patente:         string | null
  chofer_nombre:   string | null
  cantera_nombre:  string | null
  deposito_nombre: string | null
  // Nombre del destino para la UI ("hacia X"). Para cargado es el depósito,
  // para vacío es la cantera.
  destino_nombre:  string | null
  // Estado del viaje
  fecha_carga:     string | null
  toneladas:       number | null
  // Posición del camión
  gps_lat:         number | null
  gps_lng:         number | null
  gps_velocidad:   number | null
  gps_lectura_en:  string | null
  // Coordenadas del destino (depósito si cargado, cantera si vacío).
  destino_lat:     number | null
  destino_lng:     number | null
  // Cálculo de distancia (null si falta algún dato)
  distancia_m:        number | null
  duracion_s:         number | null
  duracion_traffic_s: number | null
  // Razón si no se pudo calcular
  motivo_sin_calcular: string | null
}

export const mapsService = {

  async geocodeDireccion(direccion: string) {
    try {
      return await geocode(direccion)
    } catch (err) {
      if (err instanceof GoogleMapsError) {
        if (err.code === 'GOOGLE_MAPS_API_KEY_MISSING') {
          throw new MapsError(503, 'GOOGLE_API_KEY_MISSING')
        }
        throw new MapsError(502, err.code, err.detail)
      }
      throw err
    }
  },

  /**
   * Km sugerido para una ruta: distancia por carretera cantera→depósito
   * según Google Distance Matrix, usando las lat/lng de cada lugar.
   * Es una SUGERENCIA — el usuario la verifica con el link del trayecto
   * y puede editarla antes de guardar. 422 si falta alguna coordenada.
   */
  async sugerirKm(token: string, canteraId: number, depositoId: number) {
    const sb = createSupabaseClient(token)
    const [{ data: c }, { data: d }] = await Promise.all([
      sb.from('canteras').select('id, nombre, lat, lng').eq('id', canteraId).single(),
      sb.from('depositos').select('id, nombre, lat, lng').eq('id', depositoId).single(),
    ])
    if (!c || !d) throw new MapsError(404, 'LUGAR_NO_ENCONTRADO')
    const sinCoords = [
      c.lat == null || c.lng == null ? c.nombre : null,
      d.lat == null || d.lng == null ? d.nombre : null,
    ].filter(Boolean)
    if (sinCoords.length) {
      throw new MapsError(422, 'SIN_COORDENADAS', { lugares: sinCoords })
    }
    try {
      const r = await distanciaCacheada(Number(c.lat), Number(c.lng), Number(d.lat), Number(d.lng))
      return {
        km:         Math.round(r.distancia_m / 1000),
        duracion_s: r.duracion_s,
      }
    } catch (err) {
      if (err instanceof GoogleMapsError) {
        if (err.code === 'GOOGLE_MAPS_API_KEY_MISSING') {
          throw new MapsError(503, 'GOOGLE_API_KEY_MISSING')
        }
        throw new MapsError(502, err.code, err.detail)
      }
      throw err
    }
  },

  /**
   * Completa los pares cantera×depósito que todavía no tienen ruta, con el km
   * de Google. Las crea `verificada: false` — el km se usa para pagarle al
   * chofer, así que un número que nadie miró no puede nacer marcado como bueno.
   *
   * `preview` NO llama a Google ni escribe: sirve para decirle al usuario
   * cuántas se van a calcular antes de gastar la cuota.
   *
   * Un fallo puntual de Google no aborta el resto: se reporta par por par.
   */
  async completarMatriz(token: string, userId: string, preview: boolean) {
    const sb = createSupabaseClient(token)
    const [{ data: canteras }, { data: depositos }, { data: rutas }] = await Promise.all([
      sb.from('canteras').select('id, nombre, lat, lng'),
      sb.from('depositos').select('id, nombre, lat, lng'),
      sb.from('rutas').select('cantera_id, deposito_id'),
    ])
    if (!canteras || !depositos || !rutas) throw new MapsError(500, 'DB_ERROR')

    const yaHay = new Set(rutas.map(r => `${r.cantera_id}-${r.deposito_id}`))
    type Par = { cantera_id: number; deposito_id: number; nombre: string; c: typeof canteras[0]; d: typeof depositos[0] }
    const faltantes: Par[] = []
    const sinCoords: string[] = []

    for (const c of canteras) {
      for (const d of depositos) {
        if (yaHay.has(`${c.id}-${d.id}`)) continue
        const nombre = `${c.nombre} → ${d.nombre}`
        if (c.lat == null || c.lng == null || d.lat == null || d.lng == null) {
          sinCoords.push(nombre)
          continue
        }
        faltantes.push({ cantera_id: c.id, deposito_id: d.id, nombre, c, d })
      }
    }

    if (preview) {
      return { preview: true, a_calcular: faltantes.length, sin_coordenadas: sinCoords, creadas: 0, fallidas: [] }
    }

    // De a 5 en paralelo: 263 requests simultáneos a Google es un buen modo de
    // comerse un rate limit y quedarse sin ninguna. `distanciaCacheada` ya
    // memoiza, así que reintentar sale gratis.
    const LOTE = 5
    const hoy = new Date().toISOString().slice(0, 10)
    const nuevas: Array<Record<string, unknown>> = []
    const fallidas: Array<{ par: string; motivo: string }> = []

    for (let i = 0; i < faltantes.length; i += LOTE) {
      const lote = faltantes.slice(i, i + LOTE)
      const res = await Promise.allSettled(lote.map(p =>
        distanciaCacheada(Number(p.c.lat), Number(p.c.lng), Number(p.d.lat), Number(p.d.lng)),
      ))
      res.forEach((r, j) => {
        const p = lote[j]!
        if (r.status === 'rejected') {
          const e = r.reason
          // Sin API key no tiene sentido seguir intentando los 260 restantes.
          if (e instanceof GoogleMapsError && e.code === 'GOOGLE_MAPS_API_KEY_MISSING') {
            throw new MapsError(503, 'GOOGLE_API_KEY_MISSING')
          }
          fallidas.push({ par: p.nombre, motivo: e instanceof GoogleMapsError ? e.code : 'ERROR_DESCONOCIDO' })
          return
        }
        const km = Math.round(r.value.distancia_m / 1000)
        // Google devolviendo 0 km para dos lugares distintos es basura, no un dato.
        if (!Number.isFinite(km) || km <= 0) {
          fallidas.push({ par: p.nombre, motivo: 'KM_INVALIDO' })
          return
        }
        nuevas.push({
          cantera_id:    p.cantera_id,
          deposito_id:   p.deposito_id,
          km_ida_vuelta: km,
          obs:           `Sugerido por Google el ${hoy} — sin verificar`,
          verificada:    false,
          origen_km:     'google',
          created_by:    userId,
          updated_by:    userId,
        })
      })
    }

    let creadas = 0
    if (nuevas.length > 0) {
      // ignoreDuplicates: si alguien cargó el par a mano mientras corría esto,
      // gana lo suyo. Nunca pisamos una ruta existente.
      const { data, error } = await sb
        .from('rutas')
        .upsert(nuevas, { onConflict: 'cantera_id,deposito_id', ignoreDuplicates: true })
        .select('id')
      if (error) throw new MapsError(500, 'DB_ERROR', error.message)
      creadas = data?.length ?? 0
    }

    return { preview: false, a_calcular: faltantes.length, creadas, fallidas, sin_coordenadas: sinCoords }
  },

  // Saca lat/lng del pin de un link de Google Maps (resuelve shortlinks).
  // 400 si la URL no es de Maps; 422 si no se pudieron extraer coords.
  async resolverMapsUrl(url: string) {
    try {
      return await resolverPinDeUrl(url)
    } catch (err) {
      if (err instanceof GoogleMapsError) {
        if (err.code === 'MAPS_URL_INVALIDA') throw new MapsError(400, err.code)
        if (err.code === 'MAPS_URL_SIN_COORDS') throw new MapsError(422, err.code, err.detail)
        throw new MapsError(502, err.code, err.detail)
      }
      throw err
    }
  },

  /**
   * Lista tramos en curso (cargado + vacio) enriquecidos con distancia
   * GPS→destino calculada vía Google Distance Matrix.
   *
   * Para cargados: destino = depósito (donde van a descargar).
   * Para vacíos:   destino = cantera (donde van a buscar la próxima carga).
   */
  async listarEnRuta(token: string): Promise<TramoEnRuta[]> {
    const sb = createSupabaseClient(token)

    // Traemos tramos en curso (cargado o vacío) con joins. Cantera y depósito
    // ahora SIEMPRE incluyen lat/lng, porque dependiendo del tipo la coord
    // de destino sale de uno u otro.
    const { data: tramos, error } = await sb
      .from('tramos')
      .select(`
        id, tipo, fecha_carga, toneladas_descarga, toneladas_carga,
        chofer:choferes(id, nombre),
        camion:camiones(id, patente, gps_ultima_lat, gps_ultima_lng, gps_ultima_velocidad, gps_ultima_lectura_en),
        cantera:canteras(id, nombre, lat, lng),
        deposito:depositos(id, nombre, lat, lng)
      `)
      .in('tipo', ['cargado', 'vacio'])
      .eq('estado', 'en_curso')
      .order('id', { ascending: false })
    if (error) throw new MapsError(500, 'DB_ERROR', error.message)

    // Para cada tramo, intentamos calcular distancia.
    const out: TramoEnRuta[] = []
    for (const t of (tramos ?? []) as any[]) {
      const cam = t.camion ?? null
      const can = t.cantera ?? null
      const dep = t.deposito ?? null

      // El destino depende del tipo: cargado→depósito, vacío→cantera.
      const tipo: 'cargado' | 'vacio' = t.tipo === 'vacio' ? 'vacio' : 'cargado'
      const destino = tipo === 'cargado' ? dep : can

      const fila: TramoEnRuta = {
        tramo_id:            t.id,
        tipo,
        patente:             cam?.patente ?? null,
        chofer_nombre:       t.chofer?.nombre ?? null,
        cantera_nombre:      can?.nombre ?? null,
        deposito_nombre:     dep?.nombre ?? null,
        destino_nombre:      destino?.nombre ?? null,
        fecha_carga:         t.fecha_carga,
        toneladas:           t.toneladas_descarga ?? t.toneladas_carga,
        gps_lat:             cam?.gps_ultima_lat ? Number(cam.gps_ultima_lat) : null,
        gps_lng:             cam?.gps_ultima_lng ? Number(cam.gps_ultima_lng) : null,
        gps_velocidad:       cam?.gps_ultima_velocidad ? Number(cam.gps_ultima_velocidad) : null,
        gps_lectura_en:      cam?.gps_ultima_lectura_en ?? null,
        destino_lat:         destino?.lat ? Number(destino.lat) : null,
        destino_lng:         destino?.lng ? Number(destino.lng) : null,
        distancia_m:         null,
        duracion_s:          null,
        duracion_traffic_s:  null,
        motivo_sin_calcular: null,
      }

      // Validamos que tengamos las 4 coords antes de pegarle a Google.
      if (fila.gps_lat == null || fila.gps_lng == null) {
        fila.motivo_sin_calcular = 'Camión sin posición GPS'
      } else if (fila.destino_lat == null || fila.destino_lng == null) {
        fila.motivo_sin_calcular = 'Destino sin coordenadas cargadas'
      } else {
        try {
          const r = await distanciaCacheada(
            fila.gps_lat, fila.gps_lng,
            fila.destino_lat, fila.destino_lng,
          )
          fila.distancia_m        = r.distancia_m
          fila.duracion_s         = r.duracion_s
          fila.duracion_traffic_s = r.duracion_traffic_s
        } catch (err) {
          if (err instanceof GoogleMapsError) {
            fila.motivo_sin_calcular = `Error Google Maps: ${err.code}`
          } else {
            fila.motivo_sin_calcular = 'Error desconocido al calcular'
          }
        }
      }

      out.push(fila)
    }

    return out
  },
}
