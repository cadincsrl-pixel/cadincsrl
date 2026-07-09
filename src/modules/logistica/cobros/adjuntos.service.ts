import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'

const BUCKET = 'cobros-docs'
const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
])
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export class CobroAdjError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'CobroAdjError'
  }
}

export type CobroAdjTipo = 'liquidacion' | 'comprobante' | 'factura'

export interface UploadUrlDto {
  tipo: CobroAdjTipo
  nombre_archivo: string
  mime_type: string
  size_bytes: number
}

export interface RegistrarDto {
  tipo: CobroAdjTipo
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
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp',
    'image/heic':'heic','image/heif':'heif','application/pdf':'pdf',
  }
  return map[mime] ?? 'bin'
}

export const cobroAdjuntosService = {

  async listByCobro(cobroId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('cobros_adjuntos')
      .select('id, cobro_id, tipo, nombre_archivo, mime_type, size_bytes, obs, created_at, created_by, updated_at, updated_by')
      .eq('cobro_id', cobroId)
      .is('deleted_at', null)
      .order('tipo', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async generarUploadUrl(cobroId: number, dto: UploadUrlDto) {
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new CobroAdjError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new CobroAdjError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `cobro/${cobroId}/${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new CobroAdjError(500, 'UPLOAD_URL_ERROR', error.message)
    return { path, token: data.token, signed_url: data.signedUrl, tipo: dto.tipo }
  },

  async registrar(cobroId: number, dto: RegistrarDto, userId: string, token: string) {
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new CobroAdjError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }
    if (!dto.storage_path.startsWith(`cobro/${cobroId}/`)) {
      throw new CobroAdjError(400, 'PATH_INVALIDO')
    }
    const hash = await sha256OfBlob(dl.data)
    if (dl.data.size !== dto.size_bytes) dto.size_bytes = dl.data.size

    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('cobros_adjuntos')
      .insert({
        cobro_id:       cobroId,
        tipo:           dto.tipo,
        storage_path:   dto.storage_path,
        nombre_archivo: dto.nombre_archivo,
        hash_sha256:    hash,
        mime_type:      dto.mime_type,
        size_bytes:     dto.size_bytes,
        obs:            dto.obs ?? null,
        created_by:     userId,
        updated_by:     userId,
      })
      .select('id, cobro_id, tipo, nombre_archivo, mime_type, size_bytes, obs, created_at, created_by, updated_at, updated_by')
      .single()
    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505) {
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new CobroAdjError(409, 'ADJ_DUPLICADO', { message: 'Ese archivo ya está cargado en este cobro.' })
      }
      throw new CobroAdjError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async signedUrl(cobroId: number, id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from('cobros_adjuntos')
      .select('id, cobro_id, storage_path, nombre_archivo, deleted_at')
      .eq('id', id)
      .eq('cobro_id', cobroId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new CobroAdjError(500, 'DB_ERROR', error.message)
    if (!doc) throw new CobroAdjError(404, 'ADJ_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(doc.storage_path, 900, { download: doc.nombre_archivo })
    if (sErr) throw new CobroAdjError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl, nombre_archivo: doc.nombre_archivo }
  },

  async softDelete(cobroId: number, id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('cobros_adjuntos')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .eq('cobro_id', cobroId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new CobroAdjError(500, 'DB_ERROR', error.message)
    if (!data) throw new CobroAdjError(404, 'ADJ_NO_EXISTE')
    return { success: true, id: data.id }
  },
}
