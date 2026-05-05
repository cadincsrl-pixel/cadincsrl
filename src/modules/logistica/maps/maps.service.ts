import { createSupabaseClient } from '../../../lib/supabase.js'
import { distanciaCacheada, geocode, GoogleMapsError } from './google-maps.client.js'

export class MapsError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'MapsError'
  }
}

export interface TramoEnRuta {
  tramo_id:        number
  // Identificación visible
  patente:         string | null
  chofer_nombre:   string | null
  cantera_nombre:  string | null
  deposito_nombre: string | null
  // Estado del viaje
  fecha_carga:     string | null
  toneladas:       number | null
  // Posición del camión
  gps_lat:         number | null
  gps_lng:         number | null
  gps_velocidad:   number | null
  gps_lectura_en:  string | null
  // Destino (depósito)
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
   * Lista todos los tramos cargados en curso enriquecidos con distancia
   * GPS→destino calculada vía Google Distance Matrix.
   */
  async listarEnRuta(token: string): Promise<TramoEnRuta[]> {
    const sb = createSupabaseClient(token)

    // Traemos tramos cargados en curso con joins a entidades dependientes.
    const { data: tramos, error } = await sb
      .from('tramos')
      .select(`
        id, fecha_carga, toneladas_descarga, toneladas_carga,
        chofer:choferes(id, nombre),
        camion:camiones(id, patente, gps_ultima_lat, gps_ultima_lng, gps_ultima_velocidad, gps_ultima_lectura_en),
        cantera:canteras(id, nombre),
        deposito:depositos(id, nombre, lat, lng)
      `)
      .eq('tipo', 'cargado')
      .eq('estado', 'en_curso')
      .order('id', { ascending: false })
    if (error) throw new MapsError(500, 'DB_ERROR', error.message)

    // Para cada tramo, intentamos calcular distancia.
    const out: TramoEnRuta[] = []
    for (const t of (tramos ?? []) as any[]) {
      const cam = t.camion ?? null
      const dep = t.deposito ?? null

      const fila: TramoEnRuta = {
        tramo_id:            t.id,
        patente:             cam?.patente ?? null,
        chofer_nombre:       t.chofer?.nombre ?? null,
        cantera_nombre:      t.cantera?.nombre ?? null,
        deposito_nombre:     dep?.nombre ?? null,
        fecha_carga:         t.fecha_carga,
        toneladas:           t.toneladas_descarga ?? t.toneladas_carga,
        gps_lat:             cam?.gps_ultima_lat ? Number(cam.gps_ultima_lat) : null,
        gps_lng:             cam?.gps_ultima_lng ? Number(cam.gps_ultima_lng) : null,
        gps_velocidad:       cam?.gps_ultima_velocidad ? Number(cam.gps_ultima_velocidad) : null,
        gps_lectura_en:      cam?.gps_ultima_lectura_en ?? null,
        destino_lat:         dep?.lat ? Number(dep.lat) : null,
        destino_lng:         dep?.lng ? Number(dep.lng) : null,
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
