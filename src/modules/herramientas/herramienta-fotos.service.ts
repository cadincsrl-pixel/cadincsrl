/**
 * Service de fotos para herramientas (galería por herramienta).
 *
 * Patrón análogo a flota-gastos / flota-docs:
 *  - Tabla herramienta_fotos (FK a herramientas, ON DELETE CASCADE).
 *  - Bucket privado herramienta-fotos (5MB max, solo imágenes).
 *  - Upload via signed URL 2-step (frontend pide URL firmada, sube, después
 *    POST con el path; el hash sha256 se calcula server-side).
 *  - Dedup por hash sha256 (UNIQUE en file_hash). Si llega un hash repetido,
 *    devolvemos 409 FOTO_DUPLICADA y limpiamos el huérfano.
 *  - Soft delete (set deleted_at, nunca DELETE físico).
 *  - Path: herramienta/{id}/{uuid}.{ext}.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'herramienta-fotos'
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
])
const MAX_SIZE_BYTES = 5 * 1024 * 1024

export class HerramientaFotoError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'HerramientaFotoError'
  }
}

export interface UploadUrlDto {
  nombre_archivo: string
  mime_type:      string
  size_bytes:     number
}

export interface CreateFotoDto {
  storage_path: string
  file_hash?:   string | null
  descripcion?: string | null
  orden?:       number | null
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif',
  }
  return map[mime] ?? 'bin'
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

const SELECT_COLS =
  'id, herramienta_id, storage_path, file_hash, descripcion, orden, ' +
  'created_at, created_by'

export const herramientaFotosService = {

  async list(herramientaId: number, token: string) {
    if (!Number.isFinite(herramientaId) || herramientaId <= 0) {
      throw new HerramientaFotoError(400, 'HERRAMIENTA_INVALIDA')
    }
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('herramienta_fotos')
      .select(SELECT_COLS)
      .eq('herramienta_id', herramientaId)
      .is('deleted_at', null)
      .order('orden', { ascending: true })
      .order('id', { ascending: true })
    if (error) throw new HerramientaFotoError(500, 'DB_ERROR', error.message)
    return data
  },

  async requestUploadUrl(herramientaId: number, dto: UploadUrlDto) {
    if (!Number.isFinite(herramientaId) || herramientaId <= 0) {
      throw new HerramientaFotoError(400, 'HERRAMIENTA_INVALIDA')
    }
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new HerramientaFotoError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new HerramientaFotoError(400, 'TAMAÑO_INVALIDO', {
        size: dto.size_bytes,
        max:  MAX_SIZE_BYTES,
      })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `herramienta/${herramientaId}/${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new HerramientaFotoError(500, 'UPLOAD_URL_ERROR', error.message)
    // `storage_path` es el nombre que espera el cliente (UploadUrlResp). Antes
    // se devolvía como `path` y el segundo POST llegaba con storage_path
    // undefined → zod rechazaba con "invalid_type".
    return { storage_path: path, token: data.token, signed_url: data.signedUrl }
  },

  async create(
    herramientaId: number,
    dto: CreateFotoDto,
    userId: string,
    token: string,
  ) {
    if (!Number.isFinite(herramientaId) || herramientaId <= 0) {
      throw new HerramientaFotoError(400, 'HERRAMIENTA_INVALIDA')
    }
    // El path debe pertenecer a esta herramienta — evita que un usuario use
    // un path firmado de otra herramienta para colarse en su galería.
    if (!dto.storage_path.startsWith(`herramienta/${herramientaId}/`)) {
      throw new HerramientaFotoError(400, 'PATH_INVALIDO')
    }

    // Bajamos el archivo y recalculamos sha256 server-side. NO confiamos en
    // el hash que mande el cliente: lo recalculamos siempre. Si el archivo
    // no existe en Storage (el cliente nunca subió), 400.
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new HerramientaFotoError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    }
    const fileHash = await sha256OfBlob(dl.data)

    // Pre-check dedup: si ya existe una foto viva con ese hash en CUALQUIER
    // herramienta, devolvemos 409 y limpiamos el huérfano. (El UNIQUE es
    // global por file_hash, así que esto duplicaría incluso entre
    // herramientas distintas — coherente con el diseño de la tabla.)
    const sbPre = createSupabaseClient(token)
    const { data: existente, error: chkErr } = await sbPre
      .from('herramienta_fotos')
      .select('id, herramienta_id')
      .eq('file_hash', fileHash)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (chkErr) throw new HerramientaFotoError(500, 'DB_ERROR', chkErr.message)
    if (existente) {
      await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
      throw new HerramientaFotoError(409, 'FOTO_DUPLICADA', {
        message: 'Esa foto ya está cargada.',
        foto_id: existente.id,
        herramienta_id: existente.herramienta_id,
      })
    }

    const sb = createSupabaseClient(token)
    const insertPayload: Record<string, unknown> = {
      herramienta_id: herramientaId,
      storage_path:   dto.storage_path,
      file_hash:      fileHash,
      descripcion:    dto.descripcion ?? null,
      orden:          dto.orden ?? 0,
      created_by:     userId,
    }

    const { data, error } = await sb
      .from('herramienta_fotos')
      .insert(insertPayload)
      .select(SELECT_COLS)
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505) {
        // Race contra otro insert simultáneo con el mismo hash. Limpiamos.
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new HerramientaFotoError(409, 'FOTO_DUPLICADA', {
          message: 'Esa foto ya está cargada.',
        })
      }
      throw new HerramientaFotoError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async signedUrl(id: number, token: string) {
    if (!Number.isFinite(id) || id <= 0) {
      throw new HerramientaFotoError(400, 'FOTO_INVALIDA')
    }
    const sb = createSupabaseClient(token)
    const { data: row, error } = await sb
      .from('herramienta_fotos')
      .select('id, storage_path, deleted_at')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new HerramientaFotoError(500, 'DB_ERROR', error.message)
    if (!row) throw new HerramientaFotoError(404, 'FOTO_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(row.storage_path, 900)
    if (sErr) throw new HerramientaFotoError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl }
  },

  async softDelete(id: number, token: string) {
    if (!Number.isFinite(id) || id <= 0) {
      throw new HerramientaFotoError(400, 'FOTO_INVALIDA')
    }
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('herramienta_fotos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new HerramientaFotoError(500, 'DB_ERROR', error.message)
    if (!data) throw new HerramientaFotoError(404, 'FOTO_NO_EXISTE')
    return { success: true, id: data.id }
  },

  /**
   * Reordenar fotos de una herramienta. Recibe los IDs en el nuevo orden
   * y setea `orden = índice` para cada uno. Validamos que todos los IDs
   * pertenezcan a la herramienta (rechazamos si algún ID es ajeno o no
   * existe / está borrado).
   */
  async reordenar(herramientaId: number, ids: number[], token: string) {
    if (!Number.isFinite(herramientaId) || herramientaId <= 0) {
      throw new HerramientaFotoError(400, 'HERRAMIENTA_INVALIDA')
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HerramientaFotoError(400, 'IDS_VACIOS')
    }
    const idsUnicos = Array.from(new Set(ids))
    if (idsUnicos.length !== ids.length) {
      throw new HerramientaFotoError(400, 'IDS_DUPLICADOS')
    }

    const sb = createSupabaseClient(token)
    // Validamos que todos los IDs sean de esta herramienta y estén vivos.
    const { data: filas, error: chkErr } = await sb
      .from('herramienta_fotos')
      .select('id')
      .eq('herramienta_id', herramientaId)
      .is('deleted_at', null)
      .in('id', ids)
    if (chkErr) throw new HerramientaFotoError(500, 'DB_ERROR', chkErr.message)
    if (!filas || filas.length !== ids.length) {
      throw new HerramientaFotoError(400, 'IDS_INVALIDOS', {
        message: 'Alguno de los IDs no pertenece a la herramienta o está borrado.',
      })
    }

    // Update por id (no hay update masivo con CASE en supabase-js sin RPC).
    // Son pocas filas (galería pequeña) — aceptable.
    for (let i = 0; i < ids.length; i++) {
      const { error } = await sb
        .from('herramienta_fotos')
        .update({ orden: i })
        .eq('id', ids[i])
        .eq('herramienta_id', herramientaId)
      if (error) throw new HerramientaFotoError(500, 'DB_ERROR', error.message)
    }

    return { success: true, count: ids.length }
  },
}
