import { createSupabaseClient, supabase } from '../../../lib/supabase.js'
import { mobileQuestClient, MobileQuestError } from './mobile-quest.client.js'
import type { DatosUltimosGPS } from './mobile-quest.client.js'

export class GpsSyncError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'GpsSyncError'
  }
}

type Tipo = 'manual_individual' | 'manual_global' | 'cron'
type Estado = 'ok' | 'error' | 'no_match' | 'sin_cambio'

interface SyncResultItem {
  camion_id:       number | null
  patente_gps:     string | null
  id_vehiculo_gps: string
  estado:          Estado
  km_anterior:     number | null
  km_nuevo:        number | null
  error_mensaje:   string | null
}

export interface SyncResumen {
  total:        number
  ok:           number
  sin_cambio:   number
  no_match:     number
  error:        number
  duracion_ms:  number
  items:        SyncResultItem[]
}

// Normaliza patente para matching: uppercase, sólo alfanuméricos.
// "AA 123 BB" / "aa-123-bb" → "AA123BB"
function normPatente(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Aplica un sync de Mobile Quest a la BD.
 *
 * Política:
 * - Match por id_vehiculo_gps si ya está mapeado en `camiones`.
 * - Si no, match por patente normalizada. Si encuentra, ESCRIBE el
 *   id_vehiculo_gps en el camión (mapping automático).
 * - Si tampoco encuentra, log con estado='no_match' y camion_id=NULL.
 * - Si encuentra y km_gps > km_actuales, actualiza km_actuales.
 * - Si km_gps <= km_actuales, log 'sin_cambio' (no rompe).
 * - Cualquiera de los pasos siempre escribe siempre `gps_ultimo_sync_*`
 *   en el camión y una entrada en `gps_sync_log`.
 *
 * @param tipo  cómo se disparó el sync (para auditoría).
 * @param userId  uuid del user que disparó (NULL si fue cron).
 */
async function aplicarSync(tipo: Tipo, userId: string | null): Promise<SyncResumen> {
  const t0 = Date.now()
  let datos: DatosUltimosGPS[]
  let catalogoMap: Map<string, string>  // id_vehiculo → patente
  try {
    // Mobile Quest separa el catálogo (con patente) de los datos GPS
    // (con km/lat/lng pero sin patente). Pedimos ambos en paralelo y
    // mergeamos por id_vehiculo.
    const [datosUlt, catalogo] = await Promise.all([
      mobileQuestClient.datosUltimos(),
      mobileQuestClient.listarVehiculos(),
    ])
    datos = datosUlt
    catalogoMap = new Map(catalogo.map(v => [v.id_vehiculo, v.patente]))
  } catch (err) {
    if (err instanceof MobileQuestError) {
      throw new GpsSyncError(502, err.code, err.detail)
    }
    throw new GpsSyncError(500, 'MQ_UNEXPECTED', String(err))
  }
  // El cliente filtra del catálogo los vehículos "_M" (GPS de respaldo
  // con km no actualizados). Acá también descartamos sus lecturas en
  // datos-ultimos: sólo procesamos los id_vehiculo que están en el
  // catálogo válido. Los _M ni siquiera aparecen como `no_match`.
  datos = datos.filter(d => catalogoMap.has(d.id_vehiculo))

  // Enriquecemos los datos con la patente del catálogo.
  for (const d of datos) {
    if (!d.patente) d.patente = catalogoMap.get(d.id_vehiculo) ?? null
  }

  // Trae el catálogo de camiones una sola vez.
  const { data: camiones, error: errCam } = await supabase
    .from('camiones')
    .select('id, patente, km_actuales, id_vehiculo_gps')
  if (errCam) throw new GpsSyncError(500, 'DB_ERROR', errCam.message)

  // Indexes para match rápido.
  const porIdGps   = new Map<string, typeof camiones[number]>()
  const porPatente = new Map<string, typeof camiones[number]>()
  for (const c of camiones ?? []) {
    if (c.id_vehiculo_gps) porIdGps.set(String(c.id_vehiculo_gps), c)
    if (c.patente)         porPatente.set(normPatente(c.patente), c)
  }

  const items: SyncResultItem[] = []
  const logRows: Record<string, unknown>[] = []

  for (const d of datos) {
    let camion = porIdGps.get(d.id_vehiculo)
    let autoMapped = false
    if (!camion && d.patente) {
      const matched = porPatente.get(normPatente(d.patente))
      if (matched) {
        camion = matched
        autoMapped = true
      }
    }

    const result: SyncResultItem = {
      camion_id:       camion?.id ?? null,
      patente_gps:     d.patente ?? null,
      id_vehiculo_gps: d.id_vehiculo,
      estado:          'no_match',
      km_anterior:     null,
      km_nuevo:        null,
      error_mensaje:   null,
    }

    if (!camion) {
      items.push(result)
      logRows.push({
        camion_id:       null,
        id_vehiculo_gps: d.id_vehiculo,
        patente_gps:     d.patente,
        tipo,
        estado:          'no_match',
        velocidad:       d.velocidad,
        lectura_gps_en:  d.fecha,
        payload_raw:     d.raw,
        created_by:      userId,
      })
      continue
    }

    const kmAnterior = Number(camion.km_actuales ?? 0)
    const kmGps = d.km
    result.km_anterior = kmAnterior

    // Actualizamos los campos de tracking SIEMPRE (lat/lng/velocidad/fecha
    // + estado del sync). km_actuales sólo si km_gps > kmAnterior.
    const patch: Record<string, unknown> = {
      gps_ultima_lat:         d.latitud,
      gps_ultima_lng:         d.longitud,
      gps_ultima_velocidad:   d.velocidad,
      gps_ultima_lectura_en:  d.fecha,
      gps_ultimo_sync_en:     new Date().toISOString(),
      gps_ultimo_sync_estado: 'ok' as Estado,
      gps_ultimo_sync_error:  null,
    }
    if (autoMapped) patch.id_vehiculo_gps = d.id_vehiculo

    // Política: GPS es la fuente de verdad. Si la lectura es válida y
    // diferente del valor en DB, sobreescribimos siempre — incluso si
    // el GPS reporta MENOS km. Esto autocorrige cargas manuales erróneas
    // (ej. al registrar un service tipeaste 133854 en vez de 123854).
    // Si el GPS algún día reporta basura, lo veremos en el log con la
    // métrica `km_anterior > km_nuevo` y podremos revertir manual.
    if (kmGps != null && kmGps !== kmAnterior) {
      patch.km_actuales       = kmGps
      patch.km_actualizado_en = new Date().toISOString()
      result.km_nuevo = kmGps
      result.estado = 'ok'
      patch.gps_ultimo_sync_estado = 'ok'
    } else {
      result.km_nuevo = kmAnterior
      result.estado = 'sin_cambio'
      patch.gps_ultimo_sync_estado = 'sin_cambio'
    }

    const { error: errUpd } = await supabase
      .from('camiones')
      .update(patch)
      .eq('id', camion.id)
    if (errUpd) {
      result.estado = 'error'
      result.error_mensaje = errUpd.message
    }

    items.push(result)
    logRows.push({
      camion_id:       camion.id,
      id_vehiculo_gps: d.id_vehiculo,
      patente_gps:     d.patente,
      tipo,
      estado:          result.estado,
      km_anterior:     result.km_anterior,
      km_nuevo:        result.km_nuevo,
      velocidad:       d.velocidad,
      lectura_gps_en:  d.fecha,
      error_mensaje:   result.error_mensaje,
      payload_raw:     d.raw,
      created_by:      userId,
    })
  }

  const duracion = Date.now() - t0
  // duracion total del sync va replicada en cada row para análisis.
  for (const r of logRows) r.duracion_ms = duracion

  if (logRows.length > 0) {
    const { error: errLog } = await supabase.from('gps_sync_log').insert(logRows)
    if (errLog) {
      // El log no debería bloquear el sync — pero queremos visibilidad.
      console.error('[gps-sync] error al insertar log:', errLog.message)
    }
  }

  return {
    total:        items.length,
    ok:           items.filter(i => i.estado === 'ok').length,
    sin_cambio:   items.filter(i => i.estado === 'sin_cambio').length,
    no_match:     items.filter(i => i.estado === 'no_match').length,
    error:        items.filter(i => i.estado === 'error').length,
    duracion_ms:  duracion,
    items,
  }
}

export const gpsSyncService = {

  /** Sync global (todos los vehículos) — disparado manualmente por user. */
  async syncGlobalManual(userId: string): Promise<SyncResumen> {
    return aplicarSync('manual_global', userId)
  },

  /** Sync global desde cron. */
  async syncCron(): Promise<SyncResumen> {
    return aplicarSync('cron', null)
  },

  /**
   * Sync de UN camión específico — disparado manualmente. Hace el sync
   * global pero filtra el resultado al camión pedido (Mobile Quest no
   * ofrece endpoint per-vehículo, así que conviene hacer el batch igual).
   */
  async syncCamionManual(camionId: number, userId: string): Promise<SyncResultItem | null> {
    const resumen = await aplicarSync('manual_individual', userId)
    return resumen.items.find(i => i.camion_id === camionId) ?? null
  },

  /** Asignar/desasignar manualmente un id_vehiculo_gps a un camión. */
  async setIdVehiculoGps(camionId: number, idVehiculoGps: string | null, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('camiones')
      .update({ id_vehiculo_gps: idVehiculoGps, updated_by: userId })
      .eq('id', camionId)
      .select('id, patente, id_vehiculo_gps')
      .single()
    if (error) {
      // 23505 = unique_violation (otro camión ya tiene ese id_vehiculo_gps).
      if ((error as any).code === '23505') {
        throw new GpsSyncError(409, 'ID_VEHICULO_GPS_DUPLICADO')
      }
      throw new GpsSyncError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  /** Listado del log con filtros. */
  async listLog(token: string, opts: { camion_id?: number; estado?: Estado; limit: number }) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('gps_sync_log')
      .select('id, camion_id, id_vehiculo_gps, patente_gps, tipo, estado, km_anterior, km_nuevo, velocidad, lectura_gps_en, error_mensaje, duracion_ms, created_at, created_by')
      .order('created_at', { ascending: false })
      .limit(opts.limit)
    if (opts.camion_id) q = q.eq('camion_id', opts.camion_id)
    if (opts.estado)    q = q.eq('estado',    opts.estado)
    const { data, error } = await q
    if (error) throw new GpsSyncError(500, 'DB_ERROR', error.message)
    return data
  },

  /**
   * Vehículos del último sync que NO matchearon a ningún camión. Útil para
   * el admin: "estos vehículos están en Mobile Quest pero no asignados".
   */
  async vehiculosSinAsignar(token: string) {
    const sb = createSupabaseClient(token)
    // Buscamos en el último día de log las entradas no_match agrupadas por
    // id_vehiculo_gps (devolvemos el más reciente de cada uno).
    const { data, error } = await sb
      .from('gps_sync_log')
      .select('id_vehiculo_gps, patente_gps, lectura_gps_en, created_at')
      .eq('estado', 'no_match')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw new GpsSyncError(500, 'DB_ERROR', error.message)

    const seen = new Set<string>()
    const out: typeof data = []
    for (const r of data ?? []) {
      const k = String(r.id_vehiculo_gps)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
    }
    return out
  },
}
