/**
 * Service compartido de documentos por entidad (VTV, RTO, seguro, título…).
 *
 * Cubre CUATRO entidades, cada una con su tabla propia pero de estructura
 * idéntica salvo el nombre de la FK:
 *   camion  → camion_documentos            (logística)
 *   batea   → batea_documentos             (logística)
 *   maquina → alquiler_maquina_documentos  (alquiler de maquinaria)
 *   unidad  → aridos_unidad_documentos     (áridos)
 *
 * Las tablas quedan separadas para conservar la FK con ON DELETE CASCADE y los
 * índices parciales; la lógica (hash SHA-256 con dedup, bucket privado con
 * signed URLs, soft delete) se escribe UNA vez y `entidadInfo()` traduce.
 *
 * Cada módulo tiene su bucket, con el prefijo de path que ya venía usando:
 *   vehiculo-docs → vehiculo/camion/{id}/uuid.ext · vehiculo/batea/{id}/uuid.ext
 *   alquiler-docs → maquina/{id}/uuid.ext
 *   aridos-docs   → unidad/{id}/uuid.ext
 * El prefijo de alquiler se respetó tal cual para poder migrar la póliza que ya
 * estaba cargada SIN mover el archivo (migración `20260907w`).
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export type Entidad = 'camion' | 'batea' | 'maquina' | 'unidad'

// Unión de los tipos de TODAS las entidades. El CHECK de cada tabla es el que
// manda: camión/batea aceptan 6 y máquina/unidad los 8 de flota. El enum zod de
// las rutas se arma por entidad con `TIPOS_POR_ENTIDAD`, así el 400 sale con un
// mensaje útil en vez de reventar contra el CHECK.
export type VehiculoDocTipo =
  | 'titulo' | 'tarjeta_verde' | 'rto' | 'poliza_seguro'
  | 'homologacion' | 'registro_modificacion'
  | 'vtv' | 'patente' | 'oblea' | 'otro'

const TIPOS_VEHICULO = ['titulo','tarjeta_verde','rto','poliza_seguro','homologacion','registro_modificacion'] as const
// El user pidió la misma lista para máquinas y unidades: "lleva todo lo mismo,
// si no lo tiene lo dejo en blanco". Es la de flota.
const TIPOS_FLOTA    = ['titulo','tarjeta_verde','vtv','rto','poliza_seguro','patente','oblea','otro'] as const

export class VehiculoDocError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'VehiculoDocError'
  }
}

interface EntidadInfo {
  tabla:   string
  fkCol:   string
  bucket:  string
  /** Prefijo del path en Storage. Se valida al registrar (anti path traversal). */
  prefijo: (id: number) => string
  /** Módulo de permisos que gobierna estos documentos. */
  modulo:  string
  tipos:   readonly string[]
}

const ENTIDADES: Record<Entidad, EntidadInfo> = {
  camion: {
    tabla: 'camion_documentos', fkCol: 'camion_id', bucket: 'vehiculo-docs',
    prefijo: id => `vehiculo/camion/${id}/`, modulo: 'logistica', tipos: TIPOS_VEHICULO,
  },
  batea: {
    tabla: 'batea_documentos', fkCol: 'batea_id', bucket: 'vehiculo-docs',
    prefijo: id => `vehiculo/batea/${id}/`, modulo: 'logistica', tipos: TIPOS_VEHICULO,
  },
  maquina: {
    tabla: 'alquiler_maquina_documentos', fkCol: 'maquina_id', bucket: 'alquiler-docs',
    prefijo: id => `maquina/${id}/`, modulo: 'alquiler', tipos: TIPOS_FLOTA,
  },
  unidad: {
    tabla: 'aridos_unidad_documentos', fkCol: 'unidad_id', bucket: 'aridos-docs',
    prefijo: id => `unidad/${id}/`, modulo: 'aridos', tipos: TIPOS_FLOTA,
  },
}

export function entidadInfo(entidad: Entidad): EntidadInfo {
  return ENTIDADES[entidad]
}

function tablaInfo(entidad: Entidad): EntidadInfo {
  return ENTIDADES[entidad]
}

export interface UploadUrlDto {
  tipo: VehiculoDocTipo
  nombre_archivo: string
  mime_type: string
  size_bytes: number
}

export interface RegistrarDocDto {
  tipo: VehiculoDocTipo
  storage_path: string
  nombre_archivo: string
  mime_type: string
  size_bytes: number
  vence_el?: string | null
  obs?: string
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp',
    'image/heic':'heic','image/heif':'heif','application/pdf':'pdf',
  }
  return map[mime] ?? 'bin'
}

const COLUMNAS_RETORNO =
  'id, tipo, nombre_archivo, mime_type, size_bytes, vence_el, obs, ' +
  'created_at, created_by, updated_at, updated_by'

export const entidadDocsService = {

  async listByEntidad(entidad: Entidad, entidadId: number, token: string) {
    const { tabla, fkCol } = tablaInfo(entidad)
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from(tabla)
      .select(`${COLUMNAS_RETORNO}, ${fkCol}`)
      .eq(fkCol, entidadId)
      .is('deleted_at', null)
      .order('tipo', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async generarUploadUrl(entidad: Entidad, entidadId: number, dto: UploadUrlDto) {
    const { bucket, prefijo } = tablaInfo(entidad)
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new VehiculoDocError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new VehiculoDocError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `${prefijo(entidadId)}${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path)
    if (error) throw new VehiculoDocError(500, 'UPLOAD_URL_ERROR', error.message)
    return { path, token: data.token, signed_url: data.signedUrl, tipo: dto.tipo }
  },

  async registrar(
    entidad: Entidad,
    entidadId: number,
    dto: RegistrarDocDto,
    userId: string,
    token: string,
  ) {
    const { tabla, fkCol, bucket, prefijo } = tablaInfo(entidad)

    const dl = await supabase.storage.from(bucket).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new VehiculoDocError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }
    if (!dto.storage_path.startsWith(prefijo(entidadId))) {
      throw new VehiculoDocError(400, 'PATH_INVALIDO')
    }

    const hash = await sha256OfBlob(dl.data)
    if (dl.data.size !== dto.size_bytes) dto.size_bytes = dl.data.size

    const sb = createSupabaseClient(token)
    const insertPayload: Record<string, unknown> = {
      [fkCol]:        entidadId,
      tipo:           dto.tipo,
      storage_path:   dto.storage_path,
      nombre_archivo: dto.nombre_archivo,
      hash_sha256:    hash,
      mime_type:      dto.mime_type,
      size_bytes:     dto.size_bytes,
      vence_el:       dto.vence_el ?? null,
      obs:            dto.obs ?? null,
      created_by:     userId,
      updated_by:     userId,
    }

    const { data, error } = await sb
      .from(tabla)
      .insert(insertPayload)
      .select(`${COLUMNAS_RETORNO}, ${fkCol}`)
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505) {
        await supabase.storage.from(bucket).remove([dto.storage_path]).catch(() => undefined)
        throw new VehiculoDocError(409, 'DOC_DUPLICADO', {
          message: 'Ya hay un documento idéntico cargado acá.',
        })
      }
      throw new VehiculoDocError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async actualizarMetadata(
    entidad: Entidad,
    entidadId: number,
    id: number,
    dto: { vence_el?: string | null; obs?: string | null },
    userId: string,
    token: string,
  ) {
    const { tabla, fkCol } = tablaInfo(entidad)
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }
    if (dto.vence_el !== undefined) patch.vence_el = dto.vence_el
    if (dto.obs !== undefined)      patch.obs      = dto.obs

    const { data, error } = await sb
      .from(tabla)
      .update(patch)
      .eq('id', id)
      .eq(fkCol, entidadId)
      .is('deleted_at', null)
      .select(`${COLUMNAS_RETORNO}, ${fkCol}`)
      .maybeSingle()
    if (error) throw new VehiculoDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new VehiculoDocError(404, 'DOC_NO_EXISTE')
    return data
  },

  async signedUrl(entidad: Entidad, entidadId: number, id: number, token: string) {
    const { tabla, fkCol, bucket } = tablaInfo(entidad)
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from(tabla)
      .select('id, storage_path, nombre_archivo, deleted_at')
      .eq('id', id)
      .eq(fkCol, entidadId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new VehiculoDocError(500, 'DB_ERROR', error.message)
    if (!doc) throw new VehiculoDocError(404, 'DOC_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(doc.storage_path, 900, { download: doc.nombre_archivo })
    if (sErr) throw new VehiculoDocError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl, nombre_archivo: doc.nombre_archivo }
  },

  async softDelete(entidad: Entidad, entidadId: number, id: number, userId: string, token: string) {
    const { tabla, fkCol } = tablaInfo(entidad)
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from(tabla)
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .eq(fkCol, entidadId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new VehiculoDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new VehiculoDocError(404, 'DOC_NO_EXISTE')
    return { success: true, id: data.id }
  },
}
