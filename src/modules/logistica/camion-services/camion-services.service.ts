import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'
import type { CreateServiceDto, UpdateServiceDto } from './camion-services.schema.js'

const BUCKET = 'services-camiones'

export class CamionServiceError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'CamionServiceError'
  }
}

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png')  return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

function pathForUpload(camionId: number, contentType: string): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `services/${yyyy}/${mm}/camion_${camionId}_${randomUUID()}.${extFromMime(contentType)}`
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  return createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')
}

// Descarga el archivo recién subido, calcula sha256 y valida unicidad
// contra la UNIQUE parcial de comprobante_hash.
async function procesarComprobante(
  path: string | null | undefined,
  serviceIdExcluir?: number,
): Promise<{ url: string; hash: string } | null> {
  if (!path) return null
  const dl = await supabase.storage.from(BUCKET).download(path)
  if (dl.error || !dl.data) {
    throw new CamionServiceError(400, 'COMPROBANTE_INEXISTENTE', { path })
  }
  const hash = await sha256OfBlob(dl.data)

  let q = supabase
    .from('camion_services')
    .select('id')
    .eq('comprobante_hash', hash)
    .is('deleted_at', null)
    .limit(1)
  if (serviceIdExcluir != null) q = q.neq('id', serviceIdExcluir)
  const { data: dup, error: e } = await q
  if (e) throw new CamionServiceError(500, 'DB_ERROR', e.message)
  if (dup && dup.length > 0) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined)
    throw new CamionServiceError(409, 'COMPROBANTE_DUPLICADO', { service_existente: dup[0]!.id })
  }
  return { url: path, hash }
}

export const camionServicesService = {

  // Estado actual de todos los camiones (para listado + notificaciones).
  async getEstadoTodos(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('v_camion_service_estado')
      .select('*')
      .order('camion_id')
    if (error) throw new Error(error.message)
    return data
  },

  // Histórico de services de un camión.
  async listByCamion(camionId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('camion_services')
      .select('*')
      .eq('camion_id', camionId)
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  // Crear un service. Al guardar, ACTUALIZA `camiones.km_actuales` con
  // el km_service del registro (el odómetro al hacer el service es
  // la fuente más reciente que tenemos del camión hasta que se vuelva
  // a actualizar manualmente o vía GPS).
  async create(dto: CreateServiceDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const comp = await procesarComprobante(dto.comprobante_path)
    const fecha = dto.fecha ?? new Date().toISOString().slice(0, 10)

    const { data, error } = await sb
      .from('camion_services')
      .insert({
        camion_id:        dto.camion_id,
        fecha,
        km_service:       dto.km_service,
        km_proximo:       dto.km_proximo,
        obs:              dto.obs ?? null,
        comprobante_url:  comp?.url  ?? null,
        comprobante_hash: comp?.hash ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()
    if (error) {
      if (comp?.url) {
        await supabase.storage.from(BUCKET).remove([comp.url]).catch(() => undefined)
      }
      throw new Error(error.message)
    }

    // Actualizar km_actuales del camión (sólo si el service trae un km
    // mayor al actual — evita pisar un km más reciente cargado a mano).
    const { data: cam } = await sb
      .from('camiones')
      .select('km_actuales')
      .eq('id', dto.camion_id)
      .maybeSingle()
    if (!cam || Number(cam.km_actuales ?? 0) < Number(dto.km_service)) {
      await sb
        .from('camiones')
        .update({ km_actuales: dto.km_service, updated_by: userId })
        .eq('id', dto.camion_id)
    }
    return data
  },

  async update(id: number, dto: UpdateServiceDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date().toISOString() }
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue
      if (k === 'comprobante_path') continue
      patch[k] = v
    }
    if (dto.comprobante_path !== undefined) {
      const { data: prev } = await sb
        .from('camion_services')
        .select('comprobante_url')
        .eq('id', id)
        .maybeSingle()
      const prevPath = prev?.comprobante_url ?? null

      if (dto.comprobante_path === null) {
        patch.comprobante_url  = null
        patch.comprobante_hash = null
      } else {
        const comp = await procesarComprobante(dto.comprobante_path, id)
        patch.comprobante_url  = comp?.url  ?? null
        patch.comprobante_hash = comp?.hash ?? null
      }
      if (prevPath && prevPath !== dto.comprobante_path) {
        await supabase.storage.from(BUCKET).remove([prevPath]).catch(() => undefined)
      }
    }
    const { data, error } = await sb
      .from('camion_services')
      .update(patch)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Soft delete + cleanup del comprobante en bucket.
  async softDelete(id: number, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data: prev } = await sb
      .from('camion_services')
      .select('comprobante_url')
      .eq('id', id)
      .maybeSingle()
    const { error } = await sb
      .from('camion_services')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
    if (error) throw new Error(error.message)
    if (prev?.comprobante_url) {
      await supabase.storage.from(BUCKET).remove([prev.comprobante_url]).catch(() => undefined)
    }
    return { success: true }
  },

  async firmarUploadComprobante(camionId: number, contentType: string) {
    const path = pathForUpload(camionId, contentType)
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path)
    if (error || !data) throw new CamionServiceError(500, 'STORAGE_ERROR', error?.message)
    return { path, signedUrl: data.signedUrl, token: data.token, expiresIn: 300 }
  },

  async getComprobanteUrl(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: row, error } = await sb
      .from('camion_services')
      .select('comprobante_url')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new CamionServiceError(500, 'DB_ERROR', error.message)
    if (!row || !row.comprobante_url) throw new CamionServiceError(404, 'COMPROBANTE_NO_EXISTE')
    const { data, error: e } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(row.comprobante_url, 900)
    if (e || !data) throw new CamionServiceError(500, 'STORAGE_ERROR', e?.message)
    return { signedUrl: data.signedUrl, expiresIn: 900 }
  },
}
