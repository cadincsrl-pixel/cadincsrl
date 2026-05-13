/**
 * Sync de MobilQuest para vehículos del módulo Flota CADINC.
 *
 * Espejo del service `gps-sync.service.ts` de logística pero adaptado a:
 *  - Tabla `flota_vehiculos` (no `camiones`).
 *  - Match SOLO por `mobilquest_device_id` (no hay fallback por patente:
 *    el módulo Flota expone un campo manual en el modal del vehículo,
 *    así que el mapping es responsabilidad del operador).
 *  - Tabla de bitácora `flota_gps_sync_log` (sin `payload_raw`).
 *  - Columna `mobilquest_ultima_sync_at` para el timestamp del último
 *    intento (escribe siempre, ok o error).
 *
 * Reusa `mobileQuestClient` (no duplica el cliente HTTP).
 */
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'
import {
  mobileQuestClient,
  MobileQuestError,
} from '../../logistica/gps-sync/mobile-quest.client.js'
import type { DatosUltimosGPS } from '../../logistica/gps-sync/mobile-quest.client.js'

export class FlotaGpsSyncError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'FlotaGpsSyncError'
  }
}

type Tipo   = 'manual_individual' | 'manual_global' | 'cron'
type Estado = 'ok' | 'error' | 'no_match' | 'sin_cambio'

interface SyncResultItem {
  vehiculo_id:     number | null
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

/**
 * Aplica un sync de MobilQuest a la BD de Flota.
 *
 * Política:
 * - Match SOLO por `mobilquest_device_id` igual al `id_vehiculo` del GPS.
 * - Si no hay match, log `no_match` y nada que actualizar.
 * - Si hay match y `km_gps > km_actuales`, actualiza `km_actuales` y
 *   `km_actualizado_en`. Si `km_gps <= km_actuales`, log `sin_cambio` y
 *   NO baja el km (a diferencia de camiones, donde GPS es fuente de
 *   verdad; en flota preferimos confiar en el manual del usuario).
 * - Siempre escribimos campos de tracking (lat/lng/velocidad/fecha) +
 *   `mobilquest_ultima_sync_at` + `gps_ultimo_sync_estado`/`error`.
 * - Errores de MobilQuest → `FlotaGpsSyncError` 502.
 */
async function aplicarSync(tipo: Tipo, userId: string | null): Promise<SyncResumen> {
  const t0 = Date.now()
  let datos: DatosUltimosGPS[]
  let catalogoMap: Map<string, string>  // id_vehiculo → patente
  try {
    const [datosUlt, catalogo] = await Promise.all([
      mobileQuestClient.datosUltimos(),
      mobileQuestClient.listarVehiculos(),
    ])
    datos = datosUlt
    catalogoMap = new Map(catalogo.map(v => [v.id_vehiculo, v.patente]))
  } catch (err) {
    if (err instanceof MobileQuestError) {
      throw new FlotaGpsSyncError(502, err.code, err.detail)
    }
    throw new FlotaGpsSyncError(500, 'MQ_UNEXPECTED', String(err))
  }
  // Sólo procesamos id_vehiculo que estén en el catálogo válido (filtra
  // los "_M" de respaldo que ya descarta el client al parsear el catálogo).
  datos = datos.filter(d => catalogoMap.has(d.id_vehiculo))
  for (const d of datos) {
    if (!d.patente) d.patente = catalogoMap.get(d.id_vehiculo) ?? null
  }

  // Catálogo de vehículos de flota con device_id asignado.
  const { data: vehiculos, error: errVeh } = await supabase
    .from('flota_vehiculos')
    .select('id, patente, km_actuales, mobilquest_device_id')
    .not('mobilquest_device_id', 'is', null)
  if (errVeh) throw new FlotaGpsSyncError(500, 'DB_ERROR', errVeh.message)

  const porDeviceId = new Map<string, typeof vehiculos[number]>()
  for (const v of vehiculos ?? []) {
    if (v.mobilquest_device_id) porDeviceId.set(String(v.mobilquest_device_id), v)
  }

  const items: SyncResultItem[] = []
  const logRows: Record<string, unknown>[] = []

  for (const d of datos) {
    const vehiculo = porDeviceId.get(d.id_vehiculo)

    const result: SyncResultItem = {
      vehiculo_id:     vehiculo?.id ?? null,
      patente_gps:     d.patente ?? null,
      id_vehiculo_gps: d.id_vehiculo,
      estado:          'no_match',
      km_anterior:     null,
      km_nuevo:        null,
      error_mensaje:   null,
    }

    if (!vehiculo) {
      items.push(result)
      logRows.push({
        vehiculo_id:     null,
        id_vehiculo_gps: d.id_vehiculo,
        patente_gps:     d.patente,
        tipo,
        estado:          'no_match',
        velocidad:       d.velocidad,
        lectura_gps_en:  d.fecha,
        created_by:      userId,
      })
      continue
    }

    const kmAnterior = Number(vehiculo.km_actuales ?? 0)
    const kmGps = d.km
    result.km_anterior = kmAnterior

    const nowIso = new Date().toISOString()
    const patch: Record<string, unknown> = {
      gps_ultima_lat:            d.latitud,
      gps_ultima_lng:            d.longitud,
      gps_ultima_velocidad:      d.velocidad,
      gps_ultima_lectura_en:     d.fecha,
      mobilquest_ultima_sync_at: nowIso,
      gps_ultimo_sync_estado:    'ok' as Estado,
      gps_ultimo_sync_error:     null,
    }

    // A diferencia de camiones, acá el km del GPS sólo se acepta si es
    // estrictamente mayor que el actual (no bajamos el odómetro).
    if (kmGps != null && kmGps > kmAnterior) {
      patch.km_actuales       = kmGps
      patch.km_actualizado_en = nowIso
      result.km_nuevo = kmGps
      result.estado   = 'ok'
      patch.gps_ultimo_sync_estado = 'ok'
    } else {
      result.km_nuevo = kmAnterior
      result.estado   = 'sin_cambio'
      patch.gps_ultimo_sync_estado = 'sin_cambio'
    }

    const { error: errUpd } = await supabase
      .from('flota_vehiculos')
      .update(patch)
      .eq('id', vehiculo.id)
    if (errUpd) {
      result.estado = 'error'
      result.error_mensaje = errUpd.message
      // Intentamos persistir el estado de error en el vehículo (best-effort).
      await supabase
        .from('flota_vehiculos')
        .update({
          mobilquest_ultima_sync_at: nowIso,
          gps_ultimo_sync_estado:    'error',
          gps_ultimo_sync_error:     errUpd.message,
        })
        .eq('id', vehiculo.id)
    }

    items.push(result)
    logRows.push({
      vehiculo_id:     vehiculo.id,
      id_vehiculo_gps: d.id_vehiculo,
      patente_gps:     d.patente,
      tipo,
      estado:          result.estado,
      km_anterior:     result.km_anterior,
      km_nuevo:        result.km_nuevo,
      velocidad:       d.velocidad,
      lectura_gps_en:  d.fecha,
      error_mensaje:   result.error_mensaje,
      created_by:      userId,
    })
  }

  const duracion = Date.now() - t0
  for (const r of logRows) r.duracion_ms = duracion

  if (logRows.length > 0) {
    const { error: errLog } = await supabase.from('flota_gps_sync_log').insert(logRows)
    if (errLog) {
      // El log no debería bloquear el sync — pero queremos visibilidad.
      console.error('[flota-gps-sync] error al insertar log:', errLog.message)
    }
  }

  return {
    total:       items.length,
    ok:          items.filter(i => i.estado === 'ok').length,
    sin_cambio:  items.filter(i => i.estado === 'sin_cambio').length,
    no_match:    items.filter(i => i.estado === 'no_match').length,
    error:       items.filter(i => i.estado === 'error').length,
    duracion_ms: duracion,
    items,
  }
}

export const flotaGpsSyncService = {

  /** Sync global manual (todos los vehículos de flota). */
  async syncTodos(userId: string): Promise<SyncResumen> {
    return aplicarSync('manual_global', userId)
  },

  /** Sync global desde cron. */
  async syncCron(): Promise<SyncResumen> {
    return aplicarSync('cron', null)
  },

  /**
   * Sync de UN vehículo específico — disparado manualmente. Devuelve el
   * vehículo actualizado completo (o lanza si el vehículo no tiene
   * `mobilquest_device_id` o si MobilQuest no reporta lecturas para él).
   */
  async syncIndividual(vehiculoId: number, userId: string, token: string) {
    // Validar que el vehículo existe y tiene device_id antes de gastar
    // una llamada a MobilQuest.
    const { data: veh, error: errVeh } = await supabase
      .from('flota_vehiculos')
      .select('id, mobilquest_device_id')
      .eq('id', vehiculoId)
      .maybeSingle()
    if (errVeh)        throw new FlotaGpsSyncError(500, 'DB_ERROR', errVeh.message)
    if (!veh)          throw new FlotaGpsSyncError(404, 'VEHICULO_NO_EXISTE')
    if (!veh.mobilquest_device_id) {
      throw new FlotaGpsSyncError(400, 'VEHICULO_SIN_DEVICE_ID', {
        message: 'El vehículo no tiene un mobilquest_device_id asignado. Asignalo desde el modal del vehículo.',
      })
    }

    const resumen = await aplicarSync('manual_individual', userId)
    const item = resumen.items.find(i => i.vehiculo_id === vehiculoId) ?? null
    if (!item) {
      throw new FlotaGpsSyncError(404, 'VEHICULO_SIN_LECTURA_GPS', {
        message: 'MobilQuest no reportó datos para este vehículo en este sync.',
      })
    }

    // Devolvemos el vehículo completo para que el frontend pueda actualizar
    // su cache (KM, lat/lng, etc.).
    const sb = createSupabaseClient(token)
    const { data: vehFull, error: errFull } = await sb
      .from('flota_vehiculos')
      .select('*')
      .eq('id', vehiculoId)
      .single()
    if (errFull) throw new FlotaGpsSyncError(500, 'DB_ERROR', errFull.message)

    return { vehiculo: vehFull, resultado: item }
  },

  /** Listado del log con filtros. */
  async listLog(token: string, opts: { vehiculo_id?: number; estado?: Estado; limit: number }) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('flota_gps_sync_log')
      .select('id, vehiculo_id, id_vehiculo_gps, patente_gps, tipo, estado, km_anterior, km_nuevo, velocidad, lectura_gps_en, error_mensaje, duracion_ms, created_at, created_by')
      .order('created_at', { ascending: false })
      .limit(opts.limit)
    if (opts.vehiculo_id) q = q.eq('vehiculo_id', opts.vehiculo_id)
    if (opts.estado)      q = q.eq('estado',      opts.estado)
    const { data, error } = await q
    if (error) throw new FlotaGpsSyncError(500, 'DB_ERROR', error.message)
    return data
  },
}
