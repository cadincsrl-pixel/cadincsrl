/**
 * Adjuntos de los movimientos de fondos (bucket privado `tesoreria-docs`,
 * tabla `tesoreria_movimientos_adjuntos`, 20260928l). Clon del patrón de
 * `pagos/adjuntos.service.ts`: signed URL de 3 pasos (upload-url → PUT del
 * cliente → registrar), sha256 calculado EN EL SERVER sobre lo que quedó en
 * el bucket, soft delete y `createSignedUrl(path, 900, { download })`.
 *
 * Rutas en el bucket: `movimientos/<id>/<uuid>.<ext>`. Dedup por movimiento
 * (índice único `(movimiento_id, hash_sha256) where deleted_at is null`):
 * el mismo extracto puede respaldar dos movimientos distintos a propósito.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { TES_ADJ_MAX_BYTES, TES_ADJ_MIMES, type TesAdjRegistrarDto, type TesAdjUploadUrlDto } from './contabilidad.schema.js'

export const BUCKET_TESORERIA = 'tesoreria-docs'
const TABLA = 'tesoreria_movimientos_adjuntos'
const COLS = 'id, movimiento_id, tipo, storage_path, nombre_archivo, mime_type, size_bytes, hash_sha256, obs, created_at, created_by, deleted_at'
const MIME_SET = new Set<string>(TES_ADJ_MIMES)

export interface TesAdjunto {
  id: number; movimiento_id: number; tipo: 'comprobante' | 'vep' | 'extracto' | 'otro'
  storage_path: string; nombre_archivo: string; mime_type: string; size_bytes: number; hash_sha256: string
  obs: string; created_at: string; created_by: string | null; deleted_at: string | null
}

export function extDeMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

/** Prefijo de los archivos de un movimiento. El path que llega del cliente tiene que empezar así. */
export const prefijoMovimiento = (id: number) => `movimientos/${id}/`

export function pathDeMovimientoValido(id: number, path: string): boolean {
  return path.startsWith(prefijoMovimiento(id)) && !path.includes('..') && path.length > prefijoMovimiento(id).length
}

async function borrarDelBucket(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await supabase.storage.from(BUCKET_TESORERIA).remove(paths).catch(() => undefined)
}

async function existeMovimiento(id: number, db: SupabaseClient, { vigente = false }: { vigente?: boolean } = {}): Promise<void> {
  const { data, error } = await db.from('tesoreria_movimientos').select('id, estado').eq('id', id).maybeSingle()
  if (error) throw mapRpcError(error as PgError)
  if (!data) throw new ContabilidadHttpError(404, 'MOVIMIENTO_NO_EXISTE', { movimiento_id: id })
  // A un movimiento anulado no se le suman comprobantes (la pantalla ya no lo
  // ofrece; esto frena la API directa).
  if (vigente && (data as { estado: string }).estado === 'anulado') {
    throw new ContabilidadHttpError(409, 'MOVIMIENTO_ANULADO', { movimiento_id: id })
  }
}

export const fondosAdjuntosService = {
  async listar(movimientoId: number, db: SupabaseClient = supabase): Promise<TesAdjunto[]> {
    const { data, error } = await db.from(TABLA).select(COLS).eq('movimiento_id', movimientoId).is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id')
    if (error) throw mapRpcError(error as PgError)
    return (data ?? []) as TesAdjunto[]
  },

  /**
   * Paso 1: URL firmada para el PUT del cliente. Devuelve el contrato de la
   * spec (`path`, `token`, `signedUrl`) y además los nombres de Pagos
   * (`storage_path`, `signed_url`) para que el helper de subida del front
   * sirva igual (el bug del 2026-05-19 fue un `path` contra `storage_path`).
   */
  async uploadUrl(movimientoId: number, dto: TesAdjUploadUrlDto, db: SupabaseClient = supabase) {
    if (!MIME_SET.has(dto.mime_type)) throw new ContabilidadHttpError(400, 'MIME_NO_PERMITIDO', { campo: 'mime_type', mime: dto.mime_type })
    if (dto.size_bytes <= 0 || dto.size_bytes > TES_ADJ_MAX_BYTES) {
      throw new ContabilidadHttpError(400, 'TAMANO_INVALIDO', { campo: 'size_bytes', size: dto.size_bytes, max: TES_ADJ_MAX_BYTES })
    }
    await existeMovimiento(movimientoId, db, { vigente: true })
    const path = `${prefijoMovimiento(movimientoId)}${randomUUID()}.${extDeMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(BUCKET_TESORERIA).createSignedUploadUrl(path)
    if (error || !data) throw new ContabilidadHttpError(500, 'UPLOAD_URL_ERROR', { mensaje: error?.message })
    return { path, token: data.token, signedUrl: data.signedUrl, storage_path: path, signed_url: data.signedUrl }
  },

  /** Paso 3: el archivo ya está en el bucket; se hashea acá y se registra la fila. */
  async registrar(movimientoId: number, dto: TesAdjRegistrarDto, userId: string, db: SupabaseClient = supabase): Promise<TesAdjunto> {
    if (!pathDeMovimientoValido(movimientoId, dto.storage_path)) {
      throw new ContabilidadHttpError(400, 'PATH_INVALIDO', { campo: 'storage_path', storage_path: dto.storage_path })
    }
    await existeMovimiento(movimientoId, db, { vigente: true })
    const dl = await supabase.storage.from(BUCKET_TESORERIA).download(dto.storage_path)
    if (dl.error || !dl.data) throw new ContabilidadHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: dto.storage_path, mensaje: dl.error?.message })
    const buf = Buffer.from(await dl.data.arrayBuffer())
    const hash = createHash('sha256').update(buf).digest('hex')
    if (buf.length > TES_ADJ_MAX_BYTES) {
      await borrarDelBucket([dto.storage_path])
      throw new ContabilidadHttpError(400, 'TAMANO_INVALIDO', { size: buf.length, max: TES_ADJ_MAX_BYTES })
    }

    const { data, error } = await db.from(TABLA).insert({
      movimiento_id: movimientoId, tipo: dto.tipo, storage_path: dto.storage_path, nombre_archivo: dto.nombre_archivo,
      hash_sha256: hash, mime_type: dto.mime_type, size_bytes: buf.length, obs: (dto.obs ?? '').trim(),
      created_by: userId, updated_by: userId,
    }).select(COLS).single()
    if (error) {
      await borrarDelBucket([dto.storage_path])
      const e = error as PgError
      if (e.code === '23505') {
        const { data: previo } = await db.from(TABLA).select('id').eq('movimiento_id', movimientoId).eq('hash_sha256', hash).is('deleted_at', null).maybeSingle()
        throw new ContabilidadHttpError(409, 'ADJUNTO_DUPLICADO', { movimiento_id: movimientoId, id_existente: (previo as { id: number } | null)?.id ?? null })
      }
      if (e.code === '23503') throw new ContabilidadHttpError(404, 'MOVIMIENTO_NO_EXISTE', { movimiento_id: movimientoId })
      throw mapRpcError(e)
    }
    return data as TesAdjunto
  },

  async signedUrl(movimientoId: number, adjId: number, db: SupabaseClient = supabase): Promise<{ url: string; nombre_archivo: string }> {
    const { data: doc, error } = await db.from(TABLA).select('id, storage_path, nombre_archivo')
      .eq('id', adjId).eq('movimiento_id', movimientoId).is('deleted_at', null).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!doc) throw new ContabilidadHttpError(404, 'ADJUNTO_NO_EXISTE', { adjunto_id: adjId })
    const d = doc as { storage_path: string; nombre_archivo: string }
    const { data, error: sErr } = await supabase.storage.from(BUCKET_TESORERIA).createSignedUrl(d.storage_path, 900, { download: d.nombre_archivo })
    if (sErr || !data) throw new ContabilidadHttpError(500, 'SIGNED_URL_ERROR', { mensaje: sErr?.message })
    return { url: data.signedUrl, nombre_archivo: d.nombre_archivo }
  },

  /** Soft delete: el archivo queda en el bucket (la fila es el rastro). */
  async borrar(movimientoId: number, adjId: number, userId: string, db: SupabaseClient = supabase): Promise<{ ok: true; id: number }> {
    const { data, error } = await db.from(TABLA)
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', adjId).eq('movimiento_id', movimientoId).is('deleted_at', null)
      .select('id').maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new ContabilidadHttpError(404, 'ADJUNTO_NO_EXISTE', { adjunto_id: adjId })
    return { ok: true, id: (data as { id: number }).id }
  },
}
