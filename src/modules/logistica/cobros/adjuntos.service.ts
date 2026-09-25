import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'
import { opcionesSignedUrl } from '../../../lib/signed-url.js'
import { leerChequeConIA } from '../../pagos/lectura/cheque-ia.js'
import { CUIT_EMPRESA } from '../../../lib/empresa.js'

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

export type CobroAdjTipo = 'liquidacion' | 'comprobante' | 'factura' | 'contra_factura' | 'retencion'

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

/**
 * Quién libró un cheque RECIBIDO en un cobro: el que dice la lectura, salvo
 * que no diga nada o diga CADINC (que no se paga a sí misma) — ahí es la
 * empresa del cobro. Pura, para testear.
 */
export function libradorRecibido(
  l: { librador: string | null; librador_cuit: string | null },
  emp: { nombre: string | null; cuit: string | null } | null,
  cuitCadinc = CUIT_EMPRESA,
): { librador: string | null; librador_cuit: string | null } {
  const cuit = (l.librador_cuit ?? '').replace(/\D/g, '')
  const esCadinc = (!!cuit && cuit === cuitCadinc.replace(/\D/g, '')) || /\bcadinc\b/i.test(l.librador ?? '')
  if (!l.librador?.trim() || esCadinc) return { librador: emp?.nombre ?? null, librador_cuit: emp?.cuit ?? null }
  return { librador: l.librador.trim(), librador_cuit: cuit || null }
}

/** Tipos de adjunto que pueden traer los cheques con que pagó la empresa. */
const TIPOS_CON_CHEQUES = new Set<CobroAdjTipo>(['comprobante', 'liquidacion'])

/**
 * Cartera de cheques recibidos, fase 2 (20260930h): lee en SEGUNDO PLANO el
 * comprobante o la liquidación recién adjuntada (la de Casilda trae el
 * «Detalle de Pagos»; una foto de WhatsApp, los cheques) y carga en la
 * cartera los que encuentra. La IA tarda 30–50 s: no se espera, y un error
 * no toca el adjunto (queda en el log).
 *
 * El cheque lo dio la empresa del cobro: si la lectura no dice quién lo
 * libró, o dice CADINC (lo confunde con el transportista de la liquidación),
 * el librador es la empresa. Si trae otro librador (un cheque de un tercero
 * que la empresa nos endosó), se respeta.
 */
export async function cargarChequesDelAdjunto(cobroId: number, adjuntoId: number, archivo: Buffer, mime: string, userId: string) {
  try {
    const ia = await leerChequeConIA(archivo, mime)
    if (!ia.ok) return
    const legibles = ia.lecturas.filter((l) => l.legible && l.numero && (l.importe ?? 0) > 0)
    if (legibles.length === 0) return
    const { data: cobro } = await supabase.from('cobros')
      .select('empresa_id, empresas_transportistas(nombre, cuit)').eq('id', cobroId).maybeSingle()
    const emp = (Array.isArray(cobro?.empresas_transportistas) ? cobro?.empresas_transportistas[0] : cobro?.empresas_transportistas) as
      { nombre: string | null; cuit: string | null } | null | undefined
    const cheques = legibles.map((l) => ({
      numero: (l.numero ?? '').replace(/\D/g, ''),
      banco: l.banco,
      ...libradorRecibido(l, emp ?? null),
      fecha_cobro: l.fecha_pago,
      importe: l.importe,
      es_echeq: l.es_echeq,
    }))
    const { data, error } = await supabase.rpc('cheques_recibidos_registrar', {
      p_cobro_id: cobroId, p_adjunto_id: adjuntoId, p_cheques: cheques, p_user_id: userId,
    })
    if (error) throw new Error(error.message)
    console.info(`[cartera] cobro ${cobroId} adjunto ${adjuntoId}: ${JSON.stringify(data)}`)
  } catch (e) {
    console.error(`[cartera] cobro ${cobroId} adjunto ${adjuntoId}: no se pudieron cargar los cheques`, e)
  }
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
    if (TIPOS_CON_CHEQUES.has(dto.tipo)) {
      void cargarChequesDelAdjunto(cobroId, data.id, Buffer.from(await dl.data.arrayBuffer()), dto.mime_type, userId)
    }
    return data
  },

  async signedUrl(cobroId: number, id: number, token: string, descargar = false) {
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from('cobros_adjuntos')
      .select('id, cobro_id, storage_path, nombre_archivo, mime_type, deleted_at')
      .eq('id', id)
      .eq('cobro_id', cobroId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new CobroAdjError(500, 'DB_ERROR', error.message)
    if (!doc) throw new CobroAdjError(404, 'ADJ_NO_EXISTE')

    const { data, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(doc.storage_path, 900, opcionesSignedUrl({ nombre: doc.nombre_archivo, path: doc.storage_path, mime: doc.mime_type, descargar }))
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
    // Sus cheques salen de la cartera si todavía no se usaron (20260930h).
    await supabase.from('cheques_recibidos').delete().eq('cobro_adjunto_id', data.id).eq('estado', 'en_cartera')
    return { success: true, id: data.id }
  },
}
