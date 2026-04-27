/**
 * Service compartido para documentos de vehículos (camión y batea).
 *
 * Las tablas `camion_documentos` y `batea_documentos` tienen estructura
 * idéntica salvo el nombre de la FK (camion_id vs batea_id). Este service
 * recibe el `entidad` y resuelve la tabla correspondiente.
 *
 * Mismo patrón que chofer_documentos / personal_documentos: hash SHA-256
 * dedup, bucket privado con signed URLs, soft delete.
 *
 * El bucket `vehiculo-docs` es compartido. Paths:
 *   vehiculo/camion/{id}/uuid.ext
 *   vehiculo/batea/{id}/uuid.ext
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'

const BUCKET = 'vehiculo-docs'
const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export type Entidad = 'camion' | 'batea'
export type VehiculoDocTipo = 'titulo' | 'tarjeta_verde' | 'rto' | 'poliza_seguro'

export class VehiculoDocError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'VehiculoDocError'
  }
}

interface TablaInfo { tabla: string; fkCol: string }
function tablaInfo(entidad: Entidad): TablaInfo {
  return entidad === 'camion'
    ? { tabla: 'camion_documentos', fkCol: 'camion_id' }
    : { tabla: 'batea_documentos',  fkCol: 'batea_id'  }
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

export const vehiculoDocsService = {

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
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new VehiculoDocError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new VehiculoDocError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `vehiculo/${entidad}/${entidadId}/${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
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
    const { tabla, fkCol } = tablaInfo(entidad)

    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new VehiculoDocError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }
    if (!dto.storage_path.startsWith(`vehiculo/${entidad}/${entidadId}/`)) {
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
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new VehiculoDocError(409, 'DOC_DUPLICADO', {
          message: 'Ya hay un documento idéntico cargado en este vehículo.',
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
    const { tabla, fkCol } = tablaInfo(entidad)
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
      .from(BUCKET)
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
