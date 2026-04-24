import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'personal-docs'
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export class PersonalDocError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'PersonalDocError'
  }
}

export type DocumentoTipo = 'dni' | 'alta_temprana' | 'baja' | 'telegrama'

export interface UploadUrlDto {
  tipo: DocumentoTipo
  nombre_archivo: string
  mime_type: string
  size_bytes: number
}

export interface RegistrarDocDto {
  tipo: DocumentoTipo
  storage_path: string
  nombre_archivo: string
  mime_type: string
  size_bytes: number
  obs?: string
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

export const documentosService = {

  /** Lista documentos no-eliminados de un legajo. */
  async listByLeg(leg: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('personal_documentos')
      .select('id, leg, tipo, nombre_archivo, mime_type, size_bytes, obs, created_at, created_by, updated_at, updated_by')
      .eq('leg', leg)
      .is('deleted_at', null)
      .order('tipo', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  /**
   * Genera signed upload URL en `personal-docs`. El cliente sube directo
   * al bucket; después llama a `registrar()` con el path para crear el row.
   * Validamos mime y tamaño declarados acá para fallar temprano — el bucket
   * también tiene restricción server-side.
   */
  async generarUploadUrl(leg: string, dto: UploadUrlDto) {
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new PersonalDocError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new PersonalDocError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }

    const ext = extFromMime(dto.mime_type)
    const path = `personal/${leg}/${randomUUID()}.${ext}`

    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new PersonalDocError(500, 'UPLOAD_URL_ERROR', error.message)

    return {
      path,
      token:       data.token,
      signed_url:  data.signedUrl,
      tipo:        dto.tipo,
    }
  },

  /**
   * Registra el row tras upload exitoso. Descarga el archivo para calcular
   * el hash SHA-256 (dedup) y validar metadata vs declarada.
   */
  async registrar(leg: string, dto: RegistrarDocDto, userId: string, token: string) {
    // Confirmar que el objeto existe y coincide con lo declarado.
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new PersonalDocError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }
    if (!dto.storage_path.startsWith(`personal/${leg}/`)) {
      // Evita que un caller registre archivos de otros legajos / otras áreas.
      throw new PersonalDocError(400, 'PATH_INVALIDO')
    }

    const hash = await sha256OfBlob(dl.data)
    if (dl.data.size !== dto.size_bytes) {
      // Metadata del cliente no coincide. Actualizamos al valor real.
      dto.size_bytes = dl.data.size
    }

    const sb = createSupabaseClient(token)
    const insertPayload = {
      leg,
      tipo:           dto.tipo,
      storage_path:   dto.storage_path,
      nombre_archivo: dto.nombre_archivo,
      hash_sha256:    hash,
      mime_type:      dto.mime_type,
      size_bytes:     dto.size_bytes,
      obs:            dto.obs ?? null,
      created_by:     userId,
      updated_by:     userId,
    }

    const { data, error } = await sb
      .from('personal_documentos')
      .insert(insertPayload)
      .select('id, leg, tipo, nombre_archivo, mime_type, size_bytes, obs, created_at, created_by, updated_at, updated_by')
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505) {
        // Hash duplicado: ya existe ese archivo en el legajo. Limpiamos el
        // archivo huérfano del bucket y devolvemos error claro.
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new PersonalDocError(409, 'DOC_DUPLICADO', {
          message: 'Ya hay un documento idéntico cargado en este legajo.',
        })
      }
      throw new PersonalDocError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  /** Signed URL 15 min para view/download (bucket privado). */
  async signedUrl(leg: string, id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from('personal_documentos')
      .select('id, leg, storage_path, nombre_archivo, deleted_at')
      .eq('id', id)
      .eq('leg', leg)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new PersonalDocError(500, 'DB_ERROR', error.message)
    if (!doc) throw new PersonalDocError(404, 'DOC_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(doc.storage_path, 900, { download: doc.nombre_archivo })
    if (sErr) throw new PersonalDocError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl, nombre_archivo: doc.nombre_archivo }
  },

  /** Soft delete — mantiene audit trail. No borra del bucket (job aparte). */
  async softDelete(leg: string, id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('personal_documentos')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .eq('leg', leg)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new PersonalDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new PersonalDocError(404, 'DOC_NO_EXISTE')
    return { success: true, id: data.id }
  },
}
