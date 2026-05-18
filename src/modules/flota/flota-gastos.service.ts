/**
 * Service de gastos genéricos por vehículo de flota
 * (combustible, peaje, lavado, multa, etc.).
 *
 * Patrón análogo a flota-servicios.service.ts:
 *  - Tabla flota_gastos (FK a flota_vehiculos, FK a flota_gastos_categorias).
 *  - Bucket flota-gastos (comprobantes, 5MB max).
 *  - Upload via signed URL 2-step (frontend pide URL firmada, sube, después
 *    POST con el path + hash sha256 que calcula el cliente).
 *  - Dedup por hash sha256 (UNIQUE en comprobante_hash). Si llega un hash
 *    repetido, devolvemos 409 COMPROBANTE_DUPLICADO y limpiamos el huérfano.
 *  - Soft delete (set deleted_at, nunca DELETE físico).
 *  - Path: vehiculo/{vehiculo_id}/{uuid}.{ext}.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'flota-gastos'
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
])
const MAX_SIZE_BYTES = 5 * 1024 * 1024

export class FlotaGastoError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'FlotaGastoError'
  }
}

export interface ListFiltros {
  vehiculo_id?:  number | null
  desde?:        string | null    // YYYY-MM-DD
  hasta?:        string | null    // YYYY-MM-DD
  categoria_id?: number | null
  limit?:        number
}

export interface CreateGastoDto {
  vehiculo_id:       number
  categoria_id?:     number | null
  fecha:             string                  // YYYY-MM-DD
  monto:             number
  proveedor?:        string | null
  descripcion?:      string | null
  comprobante_path?: string | null
  comprobante_hash?: string | null
}

export interface UpdateGastoDto {
  categoria_id?: number | null
  fecha?:        string
  monto?:        number
  proveedor?:    string | null
  descripcion?:  string | null
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

// Columnas + categoría joined para evitar N+1 en el frontend.
const SELECT_COLS =
  'id, vehiculo_id, categoria_id, fecha, monto, proveedor, descripcion, ' +
  'comprobante_path, comprobante_hash, created_at, created_by, updated_at, updated_by, ' +
  'categoria:flota_gastos_categorias(id, codigo, nombre, icono)'

export const flotaGastosService = {

  async listCategorias(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_gastos_categorias')
      .select('id, codigo, nombre, icono, orden, activo')
      .eq('activo', true)
      .order('orden', { ascending: true })
      .order('nombre', { ascending: true })
    if (error) throw new FlotaGastoError(500, 'DB_ERROR', error.message)
    return data
  },

  async list(filtros: ListFiltros, token: string) {
    const sb = createSupabaseClient(token)
    const limit = Math.min(Math.max(filtros.limit ?? 200, 1), 1000)

    let q = sb
      .from('flota_gastos')
      .select(SELECT_COLS)
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit)

    if (filtros.vehiculo_id != null)  q = q.eq('vehiculo_id', filtros.vehiculo_id)
    if (filtros.categoria_id != null) q = q.eq('categoria_id', filtros.categoria_id)
    if (filtros.desde)                q = q.gte('fecha', filtros.desde)
    if (filtros.hasta)                q = q.lte('fecha', filtros.hasta)

    const { data, error } = await q
    if (error) throw new FlotaGastoError(500, 'DB_ERROR', error.message)
    return data
  },

  async generarUploadUrl(
    vehiculoId: number,
    dto: { mime_type: string; size_bytes: number; nombre_archivo: string },
  ) {
    if (!Number.isFinite(vehiculoId) || vehiculoId <= 0) {
      throw new FlotaGastoError(400, 'VEHICULO_INVALIDO')
    }
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new FlotaGastoError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new FlotaGastoError(400, 'TAMAÑO_INVALIDO', {
        size: dto.size_bytes,
        max: MAX_SIZE_BYTES,
      })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `vehiculo/${vehiculoId}/${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new FlotaGastoError(500, 'UPLOAD_URL_ERROR', error.message)
    return { path, token: data.token, signed_url: data.signedUrl }
  },

  async create(dto: CreateGastoDto, userId: string, token: string) {
    // Si trae comprobante_path, validamos que el archivo está en el bucket y
    // calculamos el hash sha256 server-side para dedup. No confiamos en el
    // hash que pueda mandar el cliente: lo recalculamos siempre.
    let comprobanteHash: string | null = null
    if (dto.comprobante_path) {
      if (!dto.comprobante_path.startsWith(`vehiculo/${dto.vehiculo_id}/`)) {
        throw new FlotaGastoError(400, 'PATH_INVALIDO')
      }
      const dl = await supabase.storage.from(BUCKET).download(dto.comprobante_path)
      if (dl.error || !dl.data) {
        throw new FlotaGastoError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
      }
      comprobanteHash = await sha256OfBlob(dl.data)

      // Pre-check del dedup: si ya existe un gasto vivo con ese hash, devolvemos
      // 409 y limpiamos el huérfano antes de intentar el insert.
      const sbPre = createSupabaseClient(token)
      const { data: existente, error: chkErr } = await sbPre
        .from('flota_gastos')
        .select('id')
        .eq('comprobante_hash', comprobanteHash)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (chkErr) throw new FlotaGastoError(500, 'DB_ERROR', chkErr.message)
      if (existente) {
        await supabase.storage.from(BUCKET).remove([dto.comprobante_path]).catch(() => undefined)
        throw new FlotaGastoError(409, 'COMPROBANTE_DUPLICADO', {
          message: 'Ese comprobante ya está asociado a otro gasto.',
          gasto_id: existente.id,
        })
      }
    }

    const sb = createSupabaseClient(token)
    const insertPayload: Record<string, unknown> = {
      vehiculo_id:      dto.vehiculo_id,
      categoria_id:     dto.categoria_id ?? null,
      fecha:            dto.fecha,
      monto:            dto.monto,
      proveedor:        dto.proveedor ?? null,
      descripcion:      dto.descripcion ?? null,
      comprobante_path: dto.comprobante_path ?? null,
      comprobante_hash: comprobanteHash,
      created_by:       userId,
      updated_by:       userId,
    }

    const { data, error } = await sb
      .from('flota_gastos')
      .insert(insertPayload)
      .select(SELECT_COLS)
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505 && dto.comprobante_path) {
        // Race contra otro insert simultáneo con el mismo hash. Limpiamos.
        await supabase.storage.from(BUCKET).remove([dto.comprobante_path]).catch(() => undefined)
        throw new FlotaGastoError(409, 'COMPROBANTE_DUPLICADO', {
          message: 'Ese comprobante ya está asociado a otro gasto.',
        })
      }
      throw new FlotaGastoError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async update(id: number, dto: UpdateGastoDto, userId: string, token: string) {
    // Solo campos editables. comprobante_path NO se toca desde acá: si el
    // usuario quiere reemplazar el comprobante, borra el gasto y lo recrea.
    const sb = createSupabaseClient(token)
    const payload: Record<string, unknown> = { updated_by: userId }
    if (dto.categoria_id !== undefined) payload.categoria_id = dto.categoria_id
    if (dto.fecha !== undefined)        payload.fecha = dto.fecha
    if (dto.monto !== undefined)        payload.monto = dto.monto
    if (dto.proveedor !== undefined)    payload.proveedor = dto.proveedor
    if (dto.descripcion !== undefined)  payload.descripcion = dto.descripcion

    const { data, error } = await sb
      .from('flota_gastos')
      .update(payload)
      .eq('id', id)
      .is('deleted_at', null)
      .select(SELECT_COLS)
      .maybeSingle()
    if (error) throw new FlotaGastoError(500, 'DB_ERROR', error.message)
    if (!data) throw new FlotaGastoError(404, 'GASTO_NO_EXISTE')
    return data
  },

  async softDelete(id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_gastos')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new FlotaGastoError(500, 'DB_ERROR', error.message)
    if (!data) throw new FlotaGastoError(404, 'GASTO_NO_EXISTE')
    return { success: true, id: data.id }
  },

  async signedUrl(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: row, error } = await sb
      .from('flota_gastos')
      .select('id, comprobante_path, deleted_at')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new FlotaGastoError(500, 'DB_ERROR', error.message)
    if (!row) throw new FlotaGastoError(404, 'GASTO_NO_EXISTE')
    if (!row.comprobante_path) throw new FlotaGastoError(404, 'SIN_COMPROBANTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(row.comprobante_path, 900)
    if (sErr) throw new FlotaGastoError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl }
  },
}
