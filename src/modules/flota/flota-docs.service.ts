/**
 * Service de documentos para vehículos de flota interna.
 *
 * Análogo a vehiculo-docs.service.ts (camiones/bateas), pero con:
 *  - Tabla flota_documentos.
 *  - Bucket privado flota-docs (separado de vehiculo-docs).
 *  - Enum de tipos ampliado: incluye vtv, patente, oblea, otro
 *    (los autos livianos tienen documentación distinta a los camiones).
 *
 * Hash SHA-256 + dedup, soft delete, signed URLs (TTL 15min).
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'flota-docs'
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export type FlotaDocTipo =
  | 'titulo' | 'tarjeta_verde' | 'vtv' | 'rto'
  | 'poliza_seguro' | 'patente' | 'oblea' | 'otro'

export class FlotaDocError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'FlotaDocError'
  }
}

export interface UploadUrlDto {
  tipo: FlotaDocTipo
  nombre_archivo: string
  mime_type: string
  size_bytes: number
}

export interface RegistrarDocDto {
  tipo: FlotaDocTipo
  storage_path: string
  nombre_archivo: string
  mime_type: string
  size_bytes: number
  numero_serie?: string | null
  vence_el?: string | null
  obs?: string | null
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

const COLUMNAS_RETORNO =
  'id, vehiculo_id, tipo, nombre_archivo, mime_type, size_bytes, ' +
  'numero_serie, vence_el, obs, created_at, created_by, updated_at, updated_by'

export const flotaDocsService = {

  async list(vehiculoId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_documentos')
      .select(COLUMNAS_RETORNO)
      .eq('vehiculo_id', vehiculoId)
      .is('deleted_at', null)
      .order('tipo', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async generarUploadUrl(vehiculoId: number, dto: UploadUrlDto) {
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new FlotaDocError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new FlotaDocError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `vehiculo/${vehiculoId}/${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new FlotaDocError(500, 'UPLOAD_URL_ERROR', error.message)
    return { path, token: data.token, signed_url: data.signedUrl, tipo: dto.tipo }
  },

  async registrar(
    vehiculoId: number,
    dto: RegistrarDocDto,
    userId: string,
    token: string,
  ) {
    // El frontend sube directo a Storage con la signed URL; cuando llama
    // este endpoint validamos que el archivo está, calculamos hash y
    // registramos metadata. Si el path no pertenece al vehículo rechazamos.
    if (!dto.storage_path.startsWith(`vehiculo/${vehiculoId}/`)) {
      throw new FlotaDocError(400, 'PATH_INVALIDO')
    }

    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new FlotaDocError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }

    const hash = await sha256OfBlob(dl.data)
    const sizeReal = dl.data.size
    if (sizeReal !== dto.size_bytes) dto.size_bytes = sizeReal

    const sb = createSupabaseClient(token)
    const insertPayload: Record<string, unknown> = {
      vehiculo_id:    vehiculoId,
      tipo:           dto.tipo,
      storage_path:   dto.storage_path,
      nombre_archivo: dto.nombre_archivo,
      hash_sha256:    hash,
      mime_type:      dto.mime_type,
      size_bytes:     dto.size_bytes,
      numero_serie:   dto.numero_serie ?? null,
      vence_el:       dto.vence_el ?? null,
      obs:            dto.obs ?? null,
      created_by:     userId,
      updated_by:     userId,
    }

    const { data, error } = await sb
      .from('flota_documentos')
      .insert(insertPayload)
      .select(COLUMNAS_RETORNO)
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505) {
        // Borrar el archivo que ya subió el usuario — el dedup es por hash,
        // no tiene sentido mantenerlo en Storage si el insert falló.
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new FlotaDocError(409, 'DOC_DUPLICADO', {
          message: 'Ya hay un documento idéntico cargado en este vehículo.',
        })
      }
      throw new FlotaDocError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async actualizarMetadata(
    vehiculoId: number,
    id: number,
    dto: { numero_serie?: string | null; vence_el?: string | null; obs?: string | null },
    userId: string,
    token: string,
  ) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }
    if (dto.numero_serie !== undefined) patch.numero_serie = dto.numero_serie
    if (dto.vence_el     !== undefined) patch.vence_el     = dto.vence_el
    if (dto.obs          !== undefined) patch.obs          = dto.obs

    const { data, error } = await sb
      .from('flota_documentos')
      .update(patch)
      .eq('id', id)
      .eq('vehiculo_id', vehiculoId)
      .is('deleted_at', null)
      .select(COLUMNAS_RETORNO)
      .maybeSingle()
    if (error) throw new FlotaDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new FlotaDocError(404, 'DOC_NO_EXISTE')
    return data
  },

  async signedUrl(vehiculoId: number, id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from('flota_documentos')
      .select('id, storage_path, nombre_archivo, deleted_at')
      .eq('id', id)
      .eq('vehiculo_id', vehiculoId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new FlotaDocError(500, 'DB_ERROR', error.message)
    if (!doc) throw new FlotaDocError(404, 'DOC_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(doc.storage_path, 900, { download: doc.nombre_archivo })
    if (sErr) throw new FlotaDocError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl, nombre_archivo: doc.nombre_archivo }
  },

  async softDelete(vehiculoId: number, id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_documentos')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .eq('vehiculo_id', vehiculoId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new FlotaDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new FlotaDocError(404, 'DOC_NO_EXISTE')
    return { success: true, id: data.id }
  },
}
