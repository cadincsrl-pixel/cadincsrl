import type { PostgrestError } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase, supabase as supabaseAdmin } from '../../../lib/supabase.js'
import type { CreateLiquidacionDto, UpdateLiquidacionDto, CreateAdelantoDto, UpdateAdelantoDto } from './liquidaciones.schema.js'

const BUCKET_ADELANTOS = 'adelantos-logistica'

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png')  return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

function pathForUploadAdelanto(contentType: string): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `adelantos/${yyyy}/${mm}/${randomUUID()}.${extFromMime(contentType)}`
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

// Descarga el archivo recién subido, calcula sha256 y valida uniqueness
// contra `adelantos.comprobante_hash` (UNIQUE parcial WHERE NOT NULL).
// Si el hash ya existe, borra el huérfano del bucket y lanza error.
async function procesarComprobanteAdelanto(
  path: string | null | undefined,
  adelantoIdExcluir?: number,
): Promise<{ url: string; hash: string } | null> {
  if (!path) return null

  const dl = await supabase.storage.from(BUCKET_ADELANTOS).download(path)
  if (dl.error || !dl.data) {
    throw new LiqHttpError(400, 'COMPROBANTE_INEXISTENTE', { path, supabaseError: dl.error?.message })
  }
  const hash = await sha256OfBlob(dl.data)

  let q = supabase
    .from('adelantos')
    .select('id')
    .eq('comprobante_hash', hash)
    .limit(1)
  if (adelantoIdExcluir != null) q = q.neq('id', adelantoIdExcluir)
  const { data: dup, error: e } = await q
  if (e) throw new LiqHttpError(500, 'DB_ERROR', e.message)

  if (dup && dup.length > 0) {
    await supabase.storage.from(BUCKET_ADELANTOS).remove([path]).catch(() => undefined)
    throw new LiqHttpError(409, 'COMPROBANTE_DUPLICADO', { adelanto_id_existente: dup[0]!.id, hash })
  }
  return { url: path, hash }
}

// Mapeo mínimo de errores de RPC (reabrir/eliminar). Usa la misma forma
// de HttpError que solicitudes.service: status numérico + code + detail.
export class LiqHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'LiqHttpError'
  }
}

function mapLiqRpcError(error: PostgrestError): LiqHttpError {
  const msg = error.message || ''
  const code =
    /NO_AUTH/.test(msg)                   ? 'NO_AUTH' :
    /SIN_PERFIL/.test(msg)                ? 'SIN_PERFIL' :
    /SIN_PERMISO/.test(msg)               ? 'SIN_PERMISO' :
    /LIQUIDACION_NO_EXISTE/.test(msg)     ? 'LIQUIDACION_NO_EXISTE' :
    /LIQUIDACION_YA_EN_BORRADOR/.test(msg) ? 'LIQUIDACION_YA_EN_BORRADOR' :
    error.code || 'UNKNOWN'

  switch (code) {
    case 'NO_AUTH':                     return new LiqHttpError(401, code)
    case 'SIN_PERFIL':                  return new LiqHttpError(403, code)
    case 'SIN_PERMISO':                 return new LiqHttpError(403, code, error.details ?? undefined)
    case 'LIQUIDACION_NO_EXISTE':       return new LiqHttpError(404, code)
    case 'LIQUIDACION_YA_EN_BORRADOR':  return new LiqHttpError(409, code)
    default:                            return new LiqHttpError(500, 'DB_ERROR', { dbMessage: msg })
  }
}

export const liquidacionesService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('liquidaciones')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async getAdelantos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('adelantos')
      .select('*')
      .order('fecha', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateLiquidacionDto, _token: string, userId: string) {
    // Delegamos al RPC transaccional — garantiza que si algún vínculo
    // falla (tramo/adelanto/gasto no valido), nada se persiste y la
    // liquidación no queda a medio crear. Ver migración 20260423_liquidaciones_reintegros.
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data, error } = await supabaseAdmin.rpc('create_liquidacion_con_reintegros', {
      p_chofer_id:            dto.chofer_id,
      p_fecha_desde:          dto.fecha_desde,
      p_fecha_hasta:          dto.fecha_hasta,
      p_dias_trabajados:      dto.dias_trabajados,
      p_basico_dia:           dto.basico_dia,
      p_km_totales:           dto.km_totales ?? 0,
      p_precio_km:            dto.precio_km ?? 0,
      p_subtotal_basico:      dto.subtotal_basico,
      p_subtotal_km:          dto.subtotal_km ?? 0,
      p_total_adelantos:      dto.total_adelantos,
      p_total_reintegros:     dto.total_reintegros ?? 0,
      p_total_neto:           dto.total_neto,
      p_obs:                  dto.obs ?? '',
      p_tramo_ids:            dto.tramo_ids ?? [],
      p_adelanto_ids:         dto.adelanto_ids ?? [],
      p_gasto_ids:            dto.gasto_ids ?? [],
      p_user_id:              userId,
      p_subtotal_km_cargado:  dto.subtotal_km_cargado ?? null,
      p_subtotal_km_vacio:    dto.subtotal_km_vacio ?? null,
    })
    if (error) {
      const err = new Error(error.message) as Error & { code?: string; detail?: string | null }
      // Pasar el mensaje tal cual — el route lo mapea por texto.
      // Conserva el detail (JSON con esperados/encontrados/ids) para debug.
      err.detail = error.details ?? null
      throw err
    }
    // Las RPCs que retornan un row suelen devolverlo como objeto único.
    return data
  },

  async update(id: number, dto: UpdateLiquidacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('liquidaciones')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async cerrar(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Al cerrar, los gastos vinculados (pagado_por='chofer') transicionan
    // 'aprobado' → 'pagado'. Semánticamente el chofer acaba de recibir
    // el reintegro como parte de esta liquidación.
    const { error: eGas } = await supabase
      .from('gastos_logistica')
      .update({ estado: 'pagado', updated_by: userId })
      .eq('liquidacion_id', id)
      .eq('estado', 'aprobado')  // idempotente: si ya estaban pagados por otro camino, no se tocan
    if (eGas) throw new Error(eGas.message)

    const { data, error } = await supabase
      .from('liquidaciones')
      .update({ estado: 'cerrada', updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async reabrir(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // RPC transaccional: desliga tramos/adelantos/gastos y pone estado='borrador'
    // atómicamente con FOR UPDATE. Migración 20260424_rpc_reabrir_eliminar_liquidacion.
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data, error } = await supabaseAdmin.rpc('reabrir_liquidacion', {
      p_liquidacion_id: id,
      p_user_id:        userId,
    })
    if (error) throw mapLiqRpcError(error)

    // Para mantener el shape del endpoint (el frontend espera la liquidación
    // actualizada, no el conteo), hacemos un getById post-RPC.
    const { data: liq, error: selErr } = await supabase
      .from('liquidaciones')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)
    return liq ?? data
  },

  async delete(id: number, _token: string, userId?: string) {
    // RPC transaccional: desliga children y borra.
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data, error } = await supabaseAdmin.rpc('eliminar_liquidacion', {
      p_liquidacion_id: id,
      p_user_id:        userId ?? null,
    })
    if (error) throw mapLiqRpcError(error)
    return data as {
      success: boolean
      liquidacion_id: number
      tramos_desligados: number
      adelantos_desligados: number
      gastos_revertidos: number
    }
  },

  async createAdelanto(dto: CreateAdelantoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { comprobante_path, ...rest } = dto
    const comp = await procesarComprobanteAdelanto(comprobante_path)
    const { data, error } = await sb
      .from('adelantos')
      .insert({
        ...rest,
        comprobante_url:  comp?.url  ?? null,
        comprobante_hash: comp?.hash ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()
    if (error) {
      // Si el INSERT falla (raro tras la pre-check) limpiar el huérfano.
      if (comprobante_path) {
        await supabase.storage.from(BUCKET_ADELANTOS).remove([comprobante_path]).catch(() => undefined)
      }
      throw new Error(error.message)
    }
    return data
  },

  async updateAdelanto(id: number, dto: UpdateAdelantoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue
      if (k === 'comprobante_path') continue  // se procesa abajo
      patch[k] = v
    }
    if (dto.comprobante_path !== undefined) {
      // Trae el comprobante anterior para borrarlo del bucket si va a ser
      // reemplazado o quitado.
      const { data: prev } = await sb
        .from('adelantos')
        .select('comprobante_url')
        .eq('id', id)
        .maybeSingle()
      const prevPath = prev?.comprobante_url ?? null

      if (dto.comprobante_path === null) {
        patch.comprobante_url  = null
        patch.comprobante_hash = null
      } else {
        const comp = await procesarComprobanteAdelanto(dto.comprobante_path, id)
        patch.comprobante_url  = comp?.url  ?? null
        patch.comprobante_hash = comp?.hash ?? null
      }

      if (prevPath && prevPath !== dto.comprobante_path) {
        await supabase.storage.from(BUCKET_ADELANTOS).remove([prevPath]).catch(() => undefined)
      }
    }
    const { data, error } = await sb
      .from('adelantos')
      .update(patch)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteAdelanto(id: number, token: string) {
    const sb = createSupabaseClient(token)
    // Recuperar el path del comprobante para limpiar el bucket post-delete.
    const { data: prev } = await sb
      .from('adelantos')
      .select('comprobante_url')
      .eq('id', id)
      .maybeSingle()
    const { error } = await sb.from('adelantos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    if (prev?.comprobante_url) {
      await supabase.storage.from(BUCKET_ADELANTOS).remove([prev.comprobante_url]).catch(() => undefined)
    }
    return { success: true }
  },

  // ── Comprobante: signed URL para upload (5 min) ─────────────────
  async firmarUploadComprobanteAdelanto(contentType: string) {
    const path = pathForUploadAdelanto(contentType)
    const { data, error } = await supabase.storage
      .from(BUCKET_ADELANTOS)
      .createSignedUploadUrl(path)
    if (error || !data) {
      throw new LiqHttpError(500, 'STORAGE_ERROR', error?.message)
    }
    return { path, signedUrl: data.signedUrl, token: data.token, expiresIn: 300 }
  },

  // ── Comprobante: signed URL para descargar (15 min) ─────────────
  async getAdelantoComprobanteUrl(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: row, error: e0 } = await sb
      .from('adelantos')
      .select('comprobante_url')
      .eq('id', id)
      .maybeSingle()
    if (e0) throw new LiqHttpError(500, 'DB_ERROR', e0.message)
    if (!row || !row.comprobante_url) {
      throw new LiqHttpError(404, 'COMPROBANTE_NO_EXISTE')
    }
    const { data, error } = await supabase.storage
      .from(BUCKET_ADELANTOS)
      .createSignedUrl(row.comprobante_url, 900)
    if (error || !data) throw new LiqHttpError(500, 'STORAGE_ERROR', error?.message)
    return { signedUrl: data.signedUrl, expiresIn: 900 }
  },
}
