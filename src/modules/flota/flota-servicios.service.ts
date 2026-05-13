/**
 * Service de servicios de mantenimiento de vehículos de flota.
 *
 * Patrón análogo a flota-docs.service.ts pero adaptado a:
 *  - Tabla flota_servicios (FK a flota_vehiculos).
 *  - Bucket flota-servicios (comprobantes de service, 5MB max).
 *  - Path: vehiculo/{id}/servicio/{servicio_id}/uuid.ext (post-insert).
 *  - Dedup por hash sha256 del comprobante (un mismo comprobante no puede
 *    asociarse a dos services distintos).
 *  - Soft delete.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'flota-servicios'
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
])
const MAX_SIZE_BYTES = 5 * 1024 * 1024

export class FlotaServicioError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'FlotaServicioError'
  }
}

export interface CreateServicioDto {
  vehiculo_id:      number
  tipo_id?:         number | null
  tipo_libre?:      string | null
  fecha:            string                  // YYYY-MM-DD
  km_service:       number
  km_proximo?:      number | null
  fecha_proximo?:   string | null
  descripcion?:     string | null
  costo?:           number | null
  proveedor?:       string | null
  comprobante_path?:string | null            // si subió comprobante con upload-url
  obs?:             string | null
}

export interface UpdateServicioDto {
  tipo_id?:         number | null
  tipo_libre?:      string | null
  fecha?:           string
  km_service?:      number
  km_proximo?:      number | null
  fecha_proximo?:   string | null
  descripcion?:     string | null
  costo?:           number | null
  proveedor?:       string | null
  obs?:             string | null
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

const COLUMNAS =
  'id, vehiculo_id, tipo_id, tipo_libre, fecha, km_service, km_proximo, ' +
  'fecha_proximo, descripcion, costo, proveedor, comprobante_path, ' +
  'obs, created_at, created_by, updated_at, updated_by'

export const flotaServiciosService = {

  async list(vehiculoId: number | null, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('flota_servicios')
      .select(COLUMNAS)
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
    if (vehiculoId != null) q = q.eq('vehiculo_id', vehiculoId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getEstado(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('v_flota_servicios_estado')
      .select('*')
    if (error) throw new Error(error.message)
    return data
  },

  async generarUploadUrl(vehiculoId: number, dto: { mime_type: string; size_bytes: number; nombre_archivo: string }) {
    if (!ALLOWED_MIME.has(dto.mime_type)) {
      throw new FlotaServicioError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES) {
      throw new FlotaServicioError(400, 'TAMAÑO_INVALIDO', { size: dto.size_bytes, max: MAX_SIZE_BYTES })
    }
    const ext = extFromMime(dto.mime_type)
    const path = `vehiculo/${vehiculoId}/${randomUUID()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new FlotaServicioError(500, 'UPLOAD_URL_ERROR', error.message)
    return { path, token: data.token, signed_url: data.signedUrl }
  },

  async create(dto: CreateServicioDto, userId: string, token: string) {
    // Si trae comprobante_path, validamos que el archivo está y calculamos
    // hash para dedup (con UNIQUE constraint sobre comprobante_hash).
    let comprobanteHash: string | null = null
    if (dto.comprobante_path) {
      if (!dto.comprobante_path.startsWith(`vehiculo/${dto.vehiculo_id}/`)) {
        throw new FlotaServicioError(400, 'PATH_INVALIDO')
      }
      const dl = await supabase.storage.from(BUCKET).download(dto.comprobante_path)
      if (dl.error || !dl.data) {
        throw new FlotaServicioError(400, 'ARCHIVO_NO_SUBIDO', dl.error?.message)
      }
      comprobanteHash = await sha256OfBlob(dl.data)
    }

    const sb = createSupabaseClient(token)
    const insertPayload: Record<string, unknown> = {
      vehiculo_id:      dto.vehiculo_id,
      tipo_id:          dto.tipo_id ?? null,
      tipo_libre:       dto.tipo_libre ?? null,
      fecha:            dto.fecha,
      km_service:       dto.km_service,
      km_proximo:       dto.km_proximo ?? null,
      fecha_proximo:    dto.fecha_proximo ?? null,
      descripcion:      dto.descripcion ?? null,
      costo:            dto.costo ?? null,
      proveedor:        dto.proveedor ?? null,
      comprobante_path: dto.comprobante_path ?? null,
      comprobante_hash: comprobanteHash,
      obs:              dto.obs ?? null,
      created_by:       userId,
      updated_by:       userId,
    }

    const { data, error } = await sb
      .from('flota_servicios')
      .insert(insertPayload)
      .select(COLUMNAS)
      .single()

    if (error) {
      const is23505 = error.code === '23505' || /unique/i.test(error.message)
      if (is23505 && dto.comprobante_path) {
        // Limpiamos el archivo huérfano del bucket.
        await supabase.storage.from(BUCKET).remove([dto.comprobante_path]).catch(() => undefined)
        throw new FlotaServicioError(409, 'COMPROBANTE_DUPLICADO', {
          message: 'Ese comprobante ya está asociado a otro service.',
        })
      }
      throw new FlotaServicioError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async update(id: number, dto: UpdateServicioDto, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_servicios')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .is('deleted_at', null)
      .select(COLUMNAS)
      .maybeSingle()
    if (error) throw new FlotaServicioError(500, 'DB_ERROR', error.message)
    if (!data) throw new FlotaServicioError(404, 'SERVICIO_NO_EXISTE')
    return data
  },

  async softDelete(id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('flota_servicios')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new FlotaServicioError(500, 'DB_ERROR', error.message)
    if (!data) throw new FlotaServicioError(404, 'SERVICIO_NO_EXISTE')
    return { success: true, id: data.id }
  },

  async signedUrl(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: srv, error } = await sb
      .from('flota_servicios')
      .select('id, comprobante_path, deleted_at')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new FlotaServicioError(500, 'DB_ERROR', error.message)
    if (!srv) throw new FlotaServicioError(404, 'SERVICIO_NO_EXISTE')
    if (!srv.comprobante_path) throw new FlotaServicioError(404, 'SIN_COMPROBANTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(srv.comprobante_path, 900)
    if (sErr) throw new FlotaServicioError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl }
  },
}
