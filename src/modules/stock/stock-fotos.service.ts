/**
 * Fotos de las fichas del catálogo de materiales (20260912g). Pedido del user
 * (09/09): "poder adjuntar fotos y que después se puedan consultar por si
 * alguno tiene una duda de si lo que quiere es eso".
 *
 * Misma receta que herramienta-fotos (signed URL en dos pasos, sha256
 * server-side, soft delete), con dos diferencias:
 *  - El bucket `catalogo-fotos` es PÚBLICO: son fotos de productos y las
 *    miniaturas se muestran de a cientos en el selector del pedido. La fila
 *    guarda la URL pública; no hay endpoint de URL firmada.
 *  - El duplicado se mira POR FICHA (índice parcial (material_id, file_hash)):
 *    la misma foto en dos fichas de la misma familia es legítima.
 * La foto principal (`stock_materiales.foto_url`) la mantiene un trigger: es
 * la primera viva por `orden`; "hacer principal" = reordenar con ese id primero.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'catalogo-fotos'
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
const MAX_SIZE_BYTES = 5 * 1024 * 1024

export class StockFotoError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'StockFotoError'
  }
}

export interface UploadUrlDto { nombre_archivo: string; mime_type: string; size_bytes: number }
export interface CreateFotoDto { storage_path: string; file_hash?: string | null; descripcion?: string | null; orden?: number | null }

function extFromMime(mime: string): string {
  const map: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }
  return map[mime] ?? 'bin'
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

const SELECT_COLS = 'id, material_id, storage_path, url, file_hash, descripcion, orden, created_at, created_by'

function assertId(n: number, code: string) {
  if (!Number.isFinite(n) || n <= 0) throw new StockFotoError(400, code)
}

export const stockFotosService = {

  async list(materialId: number, token: string) {
    assertId(materialId, 'MATERIAL_INVALIDO')
    const { data, error } = await createSupabaseClient(token)
      .from('stock_material_fotos')
      .select(SELECT_COLS)
      .eq('material_id', materialId)
      .is('deleted_at', null)
      .order('orden', { ascending: true })
      .order('id', { ascending: true })
    if (error) throw new StockFotoError(500, 'DB_ERROR', error.message)
    return data
  },

  async requestUploadUrl(materialId: number, dto: UploadUrlDto, token: string) {
    assertId(materialId, 'MATERIAL_INVALIDO')
    if (!ALLOWED_MIME.has(dto.mime_type)) throw new StockFotoError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new StockFotoError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }
    // La ficha tiene que existir: una URL firmada para un id inventado dejaría basura en el bucket.
    const { data: mat, error: mErr } = await createSupabaseClient(token)
      .from('stock_materiales').select('id').eq('id', materialId).maybeSingle()
    if (mErr) throw new StockFotoError(500, 'DB_ERROR', mErr.message)
    if (!mat) throw new StockFotoError(404, 'MATERIAL_NO_EXISTE')

    const path = `material/${materialId}/${randomUUID()}.${extFromMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new StockFotoError(500, 'UPLOAD_URL_ERROR', error.message)
    // `storage_path`, no `path`: es lo que espera el cliente (lección del 2026-05-19).
    return { storage_path: path, token: data.token, signed_url: data.signedUrl }
  },

  async create(materialId: number, dto: CreateFotoDto, userId: string, token: string) {
    assertId(materialId, 'MATERIAL_INVALIDO')
    if (!dto.storage_path.startsWith(`material/${materialId}/`)) throw new StockFotoError(400, 'PATH_INVALIDO')

    // Se baja el archivo y se recalcula el sha256 acá: no se confía en el del cliente.
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) throw new StockFotoError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
    const fileHash = await sha256OfBlob(dl.data)

    const sb = createSupabaseClient(token)
    const { data: existente, error: chkErr } = await sb
      .from('stock_material_fotos')
      .select('id')
      .eq('material_id', materialId)
      .eq('file_hash', fileHash)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (chkErr) throw new StockFotoError(500, 'DB_ERROR', chkErr.message)
    if (existente) {
      await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
      throw new StockFotoError(409, 'FOTO_DUPLICADA', { message: 'Esa foto ya está en esta ficha.', foto_id: existente.id })
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(dto.storage_path)

    // Sin orden explícito va al final: la principal (orden 0) no se pisa sola.
    let orden = dto.orden ?? null
    if (orden == null) {
      const { data: ult } = await sb
        .from('stock_material_fotos').select('orden')
        .eq('material_id', materialId).is('deleted_at', null)
        .order('orden', { ascending: false }).limit(1).maybeSingle()
      orden = ult ? Number(ult.orden) + 1 : 0
    }

    const { data, error } = await sb
      .from('stock_material_fotos')
      .insert({
        material_id:  materialId,
        storage_path: dto.storage_path,
        url:          pub.publicUrl,
        file_hash:    fileHash,
        descripcion:  dto.descripcion ?? null,
        orden,
        created_by:   userId,
      })
      .select(SELECT_COLS)
      .single()
    if (error) {
      if (error.code === '23505' || /unique/i.test(error.message)) {
        await supabase.storage.from(BUCKET).remove([dto.storage_path]).catch(() => undefined)
        throw new StockFotoError(409, 'FOTO_DUPLICADA', { message: 'Esa foto ya está en esta ficha.' })
      }
      throw new StockFotoError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async softDelete(id: number, token: string) {
    assertId(id, 'FOTO_INVALIDA')
    const { data, error } = await createSupabaseClient(token)
      .from('stock_material_fotos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id, material_id')
      .maybeSingle()
    if (error) throw new StockFotoError(500, 'DB_ERROR', error.message)
    if (!data) throw new StockFotoError(404, 'FOTO_NO_EXISTE')
    return { success: true, id: data.id, material_id: data.material_id }
  },

  /** Reordena: `ids` en el orden nuevo; la primera pasa a ser la principal (trigger). */
  async reordenar(materialId: number, ids: number[], token: string) {
    assertId(materialId, 'MATERIAL_INVALIDO')
    if (ids.length === 0) throw new StockFotoError(400, 'IDS_VACIOS')
    if (new Set(ids).size !== ids.length) throw new StockFotoError(400, 'IDS_DUPLICADOS')
    const sb = createSupabaseClient(token)
    const { data: filas, error: chkErr } = await sb
      .from('stock_material_fotos').select('id')
      .eq('material_id', materialId).is('deleted_at', null).in('id', ids)
    if (chkErr) throw new StockFotoError(500, 'DB_ERROR', chkErr.message)
    if (!filas || filas.length !== ids.length) {
      throw new StockFotoError(400, 'IDS_INVALIDOS', { message: 'Alguna foto no es de esta ficha o está borrada.' })
    }
    for (let i = 0; i < ids.length; i++) {
      const { error } = await sb.from('stock_material_fotos').update({ orden: i }).eq('id', ids[i]).eq('material_id', materialId)
      if (error) throw new StockFotoError(500, 'DB_ERROR', error.message)
    }
    return { success: true, count: ids.length }
  },
}
