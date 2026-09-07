/**
 * Service único de mantenimientos, para las cuatro entidades que los tienen.
 *
 * Reemplaza a `flota-servicios.service.ts` y a `camion-services.service.ts`,
 * que hacían lo mismo con distinto alcance (ver migración `20260908e`).
 *
 * EL MEDIDOR NO SIEMPRE SON KILÓMETROS: una máquina de alquiler hace service
 * por HORAS DE MOTOR. Por eso las columnas son `medidor_valor` /
 * `medidor_proximo` y no `km_*`, y cada entidad declara su unidad acá abajo.
 *
 * De dónde sale el valor ACTUAL del medidor (lo resuelve la vista
 * `v_entidad_medidor`, no este archivo):
 *   flota / camion / unidad → km del sync de GPS
 *   maquina                 → suma de horas de los partes de trabajo
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export type EntidadServicio = 'flota' | 'camion' | 'maquina' | 'unidad'

export class ServicioError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'ServicioError'
  }
}

interface EntidadInfo {
  /** Tabla del padrón, para validar que la entidad existe antes de escribir. */
  padron:  string
  /** Unidad del medidor. Define qué intervalo del catálogo se usa. */
  medidor: 'km' | 'horas'
  bucket:  string
  prefijo: (id: number) => string
  /** Módulo de permisos que gobierna estos services. */
  modulo:  string
}

const ENTIDADES: Record<EntidadServicio, EntidadInfo> = {
  flota: {
    padron: 'flota_vehiculos', medidor: 'km', bucket: 'flota-servicios',
    prefijo: id => `vehiculo/${id}/`, modulo: 'flota',
  },
  camion: {
    // Bucket y prefijo son los que ya usaba `camion_services`, para que los
    // comprobantes migrados sigan encontrándose sin mover un archivo.
    padron: 'camiones', medidor: 'km', bucket: 'services-camiones',
    prefijo: id => `services/camion_${id}/`, modulo: 'logistica',
  },
  maquina: {
    padron: 'alquiler_maquinas', medidor: 'horas', bucket: 'alquiler-docs',
    prefijo: id => `service/maquina/${id}/`, modulo: 'alquiler',
  },
  unidad: {
    padron: 'aridos_unidades', medidor: 'km', bucket: 'aridos-docs',
    prefijo: id => `service/unidad/${id}/`, modulo: 'aridos',
  },
}

export function entidadServicioInfo(e: EntidadServicio): EntidadInfo {
  return ENTIDADES[e]
}

export interface CrearServicioDto {
  tipo_id?:        number | null
  tipo_libre?:     string | null
  fecha:           string
  medidor_valor?:  number | null
  medidor_proximo?: number | null
  fecha_proximo?:  string | null
  descripcion?:    string | null
  costo?:          number | null
  proveedor?:      string | null
  obs?:            string | null
}

const COLUMNAS =
  'id, entidad, entidad_id, tipo_id, tipo_libre, fecha, medidor, medidor_valor, ' +
  'medidor_proximo, fecha_proximo, descripcion, costo, proveedor, ' +
  'comprobante_bucket, comprobante_path, obs, created_at, created_by, updated_at, updated_by'

async function sha256OfBlob(blob: Blob): Promise<string> {
  return createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp',
    'image/heic':'heic','image/heif':'heif','application/pdf':'pdf',
  }
  return map[mime] ?? 'bin'
}

export const serviciosService = {

  /** Catálogo de tipos, con los intervalos de km, meses y horas. */
  async getTipos(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('tipos_servicio').select('*').eq('activo', true).order('nombre')
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    return data
  },

  async listar(entidad: EntidadServicio, entidadId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('servicios')
      .select(`${COLUMNAS}, tipos_servicio(nombre, intervalo_km, intervalo_meses, intervalo_horas)`)
      .eq('entidad', entidad).eq('entidad_id', entidadId)
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    return data
  },

  /**
   * Semáforo. Sin `entidad` devuelve TODAS — así una sola llamada alimenta un
   * tablero de mantenimiento que cruce los cuatro padrones.
   */
  async estado(token: string, entidad?: EntidadServicio, entidadId?: number) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_servicios_estado').select('*')
    if (entidad)          q = q.eq('entidad', entidad)
    if (entidadId != null) q = q.eq('entidad_id', entidadId)
    const { data, error } = await q.order('entidad').order('etiqueta')
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    return data
  },

  /**
   * Alta. Si no se manda `medidor_proximo` pero el tipo tiene intervalo, se
   * calcula solo: es el 90% del valor de tener un catálogo con intervalos.
   */
  async crear(
    entidad: EntidadServicio, entidadId: number,
    dto: CrearServicioDto, userId: string, token: string,
  ) {
    const info = ENTIDADES[entidad]
    const sb = createSupabaseClient(token)

    const { data: existe } = await sb.from(info.padron).select('id').eq('id', entidadId).maybeSingle()
    if (!existe) throw new ServicioError(404, 'ENTIDAD_NO_EXISTE', { entidad, id: entidadId })

    let medidorProximo = dto.medidor_proximo ?? null
    let fechaProximo   = dto.fecha_proximo ?? null

    if (dto.tipo_id) {
      const { data: tipo } = await sb
        .from('tipos_servicio')
        .select('intervalo_km, intervalo_meses, intervalo_horas')
        .eq('id', dto.tipo_id).maybeSingle()
      if (tipo) {
        const intervalo = info.medidor === 'horas' ? tipo.intervalo_horas : tipo.intervalo_km
        if (medidorProximo == null && intervalo != null && dto.medidor_valor != null) {
          medidorProximo = Number(dto.medidor_valor) + Number(intervalo)
        }
        if (fechaProximo == null && tipo.intervalo_meses != null) {
          const f = new Date(dto.fecha + 'T00:00:00')
          f.setMonth(f.getMonth() + Number(tipo.intervalo_meses))
          fechaProximo = f.toISOString().slice(0, 10)
        }
      }
    }

    const { data, error } = await sb
      .from('servicios')
      .insert({
        entidad, entidad_id: entidadId,
        tipo_id:    dto.tipo_id ?? null,
        tipo_libre: dto.tipo_libre ?? null,
        fecha:      dto.fecha,
        medidor:    dto.medidor_valor != null || medidorProximo != null ? info.medidor : null,
        medidor_valor:   dto.medidor_valor ?? null,
        medidor_proximo: medidorProximo,
        fecha_proximo:   fechaProximo,
        descripcion: dto.descripcion ?? null,
        costo:       dto.costo ?? null,
        proveedor:   dto.proveedor ?? null,
        obs:         dto.obs ?? null,
        created_by: userId, updated_by: userId,
      })
      .select(COLUMNAS)
      .single()
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    return data
  },

  async editar(
    entidad: EntidadServicio, entidadId: number, id: number,
    dto: Partial<CrearServicioDto>, userId: string, token: string,
  ) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }
    for (const k of ['tipo_id','tipo_libre','fecha','medidor_valor','medidor_proximo',
                     'fecha_proximo','descripcion','costo','proveedor','obs'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k]
    }
    const { data, error } = await sb
      .from('servicios').update(patch)
      .eq('id', id).eq('entidad', entidad).eq('entidad_id', entidadId)
      .is('deleted_at', null)
      .select(COLUMNAS).maybeSingle()
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    if (!data) throw new ServicioError(404, 'SERVICIO_NO_EXISTE')
    return data
  },

  async borrar(entidad: EntidadServicio, entidadId: number, id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('servicios')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id).eq('entidad', entidad).eq('entidad_id', entidadId)
      .is('deleted_at', null)
      .select('id').maybeSingle()
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    if (!data) throw new ServicioError(404, 'SERVICIO_NO_EXISTE')
    return { success: true, id: data.id }
  },

  // ── Comprobante (mismo flujo de 2 pasos que los documentos) ──────────
  async uploadUrl(
    entidad: EntidadServicio, entidadId: number,
    dto: { mime_type: string; size_bytes: number },
  ) {
    const info = ENTIDADES[entidad]
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new ServicioError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new ServicioError(400, 'TAMAÑO_INVALIDO', { max: MAX_SIZE_BYTES })
    }
    const path = `${info.prefijo(entidadId)}${randomUUID()}.${extFromMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(info.bucket).createSignedUploadUrl(path)
    if (error) throw new ServicioError(500, 'UPLOAD_URL_ERROR', error.message)
    return { path, bucket: info.bucket, token: data.token, signed_url: data.signedUrl }
  },

  async registrarComprobante(
    entidad: EntidadServicio, entidadId: number, id: number,
    dto: { storage_path: string }, userId: string, token: string,
  ) {
    const info = ENTIDADES[entidad]
    if (!dto.storage_path.startsWith(info.prefijo(entidadId))) {
      throw new ServicioError(400, 'PATH_INVALIDO')
    }
    const dl = await supabase.storage.from(info.bucket).download(dto.storage_path)
    if (dl.error || !dl.data) throw new ServicioError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)

    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('servicios')
      .update({
        comprobante_bucket: info.bucket,
        comprobante_path:   dto.storage_path,
        comprobante_hash:   await sha256OfBlob(dl.data),
        updated_by: userId,
      })
      .eq('id', id).eq('entidad', entidad).eq('entidad_id', entidadId)
      .is('deleted_at', null)
      .select(COLUMNAS).maybeSingle()
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    if (!data) throw new ServicioError(404, 'SERVICIO_NO_EXISTE')
    return data
  },

  async signedUrl(entidad: EntidadServicio, entidadId: number, id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: s, error } = await sb
      .from('servicios')
      .select('comprobante_bucket, comprobante_path')
      .eq('id', id).eq('entidad', entidad).eq('entidad_id', entidadId)
      .is('deleted_at', null).maybeSingle()
    if (error) throw new ServicioError(500, 'DB_ERROR', error.message)
    if (!s?.comprobante_path) throw new ServicioError(404, 'SIN_COMPROBANTE')

    // El bucket sale de la FILA, no de la entidad: los comprobantes migrados de
    // los dos sistemas viejos viven donde vivían.
    const bucket = s.comprobante_bucket ?? ENTIDADES[entidad].bucket
    const { data, error: sErr } = await supabase.storage
      .from(bucket).createSignedUrl(s.comprobante_path, 900)
    if (sErr) throw new ServicioError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl }
  },
}
