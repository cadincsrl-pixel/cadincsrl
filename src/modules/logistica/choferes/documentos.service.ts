import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'

const BUCKET = 'chofer-docs'
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export class ChoferDocError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'ChoferDocError'
  }
}

export type ChoferDocTipo =
  | 'dni' | 'licencia_conducir' | 'alta_temprana' | 'lnh' | 'cnrt'
  | 'aptitud_psicofisica' | 'art' | 'mopp' | 'cuil_afip' | 'cbu_bancario'
  | 'telegrama' | 'otro'

export interface UploadUrlDto {
  tipo: ChoferDocTipo
  nombre_archivo: string
  mime_type: string
  size_bytes: number
}

export interface RegistrarDocDto {
  tipo: ChoferDocTipo
  storage_path: string
  nombre_archivo: string
  mime_type: string
  size_bytes: number
  vence_el?: string | null    // YYYY-MM-DD, opcional
  obs?: string
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

export const choferDocsService = {

  async listByChofer(choferId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('chofer_documentos')
      .select('id, chofer_id, tipo, nombre_archivo, mime_type, size_bytes, vence_el, obs, created_at, created_by, updated_at, updated_by')
      .eq('chofer_id', choferId)
      .is('deleted_at', null)
      .order('tipo', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async generarUploadUrl(choferId: number, dto: UploadUrlDto) {
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new ChoferDocError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new ChoferDocError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }

    const ext = extFromMime(dto.mime_type)
    const path = `chofer/${choferId}/${randomUUID()}.${ext}`

    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new ChoferDocError(500, 'UPLOAD_URL_ERROR', error.message)

    return {
      path,
      token:      data.token,
      signed_url: data.signedUrl,
      tipo:       dto.tipo,
    }
  },

  async registrar(choferId: number, dto: RegistrarDocDto, userId: string, token: string) {
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new ChoferDocError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }
    if (!dto.storage_path.startsWith(`chofer/${choferId}/`)) {
      throw new ChoferDocError(400, 'PATH_INVALIDO')
    }

    const hash = await sha256OfBlob(dl.data)
    if (dl.data.size !== dto.size_bytes) {
      dto.size_bytes = dl.data.size
    }

    const sb = createSupabaseClient(token)
    const insertPayload = {
      chofer_id:      choferId,
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
      .from('chofer_documentos')
      .insert(insertPayload)
      .select('id, chofer_id, tipo, nombre_archivo, mime_type, size_bytes, vence_el, obs, created_at, created_by, updated_at, updated_by')
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505) {
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new ChoferDocError(409, 'DOC_DUPLICADO', {
          message: 'Ya hay un documento idéntico cargado en este chofer.',
        })
      }
      throw new ChoferDocError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  /** Permite editar vence_el y obs sin re-subir el archivo. */
  async actualizarMetadata(
    choferId: number,
    id: number,
    dto: { vence_el?: string | null; obs?: string | null },
    userId: string,
    token: string,
  ) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }
    if (dto.vence_el !== undefined) patch.vence_el = dto.vence_el
    if (dto.obs !== undefined)      patch.obs      = dto.obs

    const { data, error } = await sb
      .from('chofer_documentos')
      .update(patch)
      .eq('id', id)
      .eq('chofer_id', choferId)
      .is('deleted_at', null)
      .select('id, chofer_id, tipo, nombre_archivo, mime_type, size_bytes, vence_el, obs, created_at, created_by, updated_at, updated_by')
      .maybeSingle()
    if (error) throw new ChoferDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new ChoferDocError(404, 'DOC_NO_EXISTE')
    return data
  },

  async signedUrl(choferId: number, id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from('chofer_documentos')
      .select('id, chofer_id, storage_path, nombre_archivo, deleted_at')
      .eq('id', id)
      .eq('chofer_id', choferId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new ChoferDocError(500, 'DB_ERROR', error.message)
    if (!doc) throw new ChoferDocError(404, 'DOC_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(doc.storage_path, 900, { download: doc.nombre_archivo })
    if (sErr) throw new ChoferDocError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl, nombre_archivo: doc.nombre_archivo }
  },

  async softDelete(choferId: number, id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('chofer_documentos')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .eq('chofer_id', choferId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new ChoferDocError(500, 'DB_ERROR', error.message)
    if (!data) throw new ChoferDocError(404, 'DOC_NO_EXISTE')
    return { success: true, id: data.id }
  },
}
