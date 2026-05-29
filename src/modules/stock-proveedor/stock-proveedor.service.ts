import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import type { ListStockDto, CrearRemitoRetiroDto } from './stock-proveedor.schema.js'

const BUCKET = 'remitos-retiro-proveedor'

// Mapeo mínimo de errores de RPC: los códigos los lanza la función SQL
// con `RAISE EXCEPTION '...' USING ERRCODE='P0001'`.
export class StockProvHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'StockProvHttpError'
  }
}

function mapRpcError(error: { message?: string; details?: string | null; code?: string }): StockProvHttpError {
  const msg = error.message || ''
  const code =
    /SIN_ITEMS/.test(msg)                  ? 'SIN_ITEMS' :
    /ITEM_NO_EXISTE/.test(msg)             ? 'ITEM_NO_EXISTE' :
    /ITEM_YA_RESUELTO/.test(msg)           ? 'ITEM_YA_RESUELTO' :
    /ITEM_NO_EN_PROVEEDOR/.test(msg)       ? 'ITEM_NO_EN_PROVEEDOR' :
    /ITEM_PROVEEDOR_DISTINTO/.test(msg)    ? 'ITEM_PROVEEDOR_DISTINTO' :
    /CANTIDAD_EXCEDE_PENDIENTE/.test(msg)  ? 'CANTIDAD_EXCEDE_PENDIENTE' :
    error.code || 'UNKNOWN'
  switch (code) {
    case 'SIN_ITEMS':                  return new StockProvHttpError(400, code)
    case 'ITEM_NO_EXISTE':              return new StockProvHttpError(404, code, error.details ?? undefined)
    case 'ITEM_YA_RESUELTO':            return new StockProvHttpError(409, code, error.details ?? undefined)
    case 'ITEM_NO_EN_PROVEEDOR':        return new StockProvHttpError(409, code, error.details ?? undefined)
    case 'ITEM_PROVEEDOR_DISTINTO':     return new StockProvHttpError(400, code)
    case 'CANTIDAD_EXCEDE_PENDIENTE':   return new StockProvHttpError(409, code, error.details ?? undefined)
    default:                            return new StockProvHttpError(500, 'DB_ERROR', { dbMessage: msg })
  }
}

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png')  return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

function pathForUpload(contentType: string): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `retiros/${yyyy}/${mm}/${randomUUID()}.${extFromMime(contentType)}`
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

// Descarga el archivo recién subido, calcula sha256 y valida uniqueness
// contra `remitos_retiro_proveedor.comprobante_hash` (UNIQUE parcial).
async function procesarComprobante(
  path: string | null | undefined,
): Promise<{ url: string; hash: string } | null> {
  if (!path) return null

  const dl = await supabase.storage.from(BUCKET).download(path)
  if (dl.error || !dl.data) {
    throw new StockProvHttpError(400, 'COMPROBANTE_INEXISTENTE', { path, supabaseError: dl.error?.message })
  }
  const hash = await sha256OfBlob(dl.data)

  const { data: dup, error: e } = await supabase
    .from('remitos_retiro_proveedor')
    .select('id')
    .eq('comprobante_hash', hash)
    .limit(1)
  if (e) throw new StockProvHttpError(500, 'DB_ERROR', e.message)
  if (dup && dup.length > 0) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined)
    throw new StockProvHttpError(409, 'COMPROBANTE_DUPLICADO', { remito_existente: dup[0]!.id, hash })
  }
  return { url: path, hash }
}

export const stockProveedorService = {

  // Listado del stock pendiente, agrupado por proveedor.
  // La vista v_stock_proveedor calcula cantidad_pendiente = entradas - salidas.
  async list(dto: ListStockDto, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_stock_proveedor').select('*')
    if (dto.proveedor_id) q = q.eq('proveedor_id', dto.proveedor_id)
    if (dto.obra_cod)     q = q.eq('obra_cod', dto.obra_cod)
    if (!dto.incluir_retirados) q = q.eq('estado', 'en_proveedor').gt('cantidad_pendiente', 0)
    q = q.order('proveedor_id').order('fecha_compra', { ascending: false })
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  // Detalle de un item: sus movimientos + remitos asociados.
  async getMovimientos(itemId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('stock_proveedor_movimientos')
      .select('*, remito:remitos_retiro_proveedor(numero, fecha)')
      .eq('solicitud_item_id', itemId)
      .order('fecha')
      .order('id')
    if (error) throw new Error(error.message)
    return data
  },

  // Listar remitos de retiro (paginable). Filtros opcionales por proveedor/obra.
  async listRemitos(filtros: { proveedor_id?: number; obra_cod?: string }, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('remitos_retiro_proveedor').select('*, items:remitos_retiro_proveedor_item(*)')
    if (filtros.proveedor_id) q = q.eq('proveedor_id', filtros.proveedor_id)
    if (filtros.obra_cod)     q = q.eq('obra_cod', filtros.obra_cod)
    q = q.order('fecha', { ascending: false }).order('id', { ascending: false })
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  // Crear un remito de retiro vía RPC transaccional.
  // El RPC actualiza items, inserta movimientos y MCC en una sola TX.
  async crearRemitoRetiro(dto: CrearRemitoRetiroDto, token: string, userId: string) {
    const fecha = dto.fecha ?? new Date().toISOString().slice(0, 10)
    const comp  = await procesarComprobante(dto.comprobante_path)

    const sb = createSupabaseClient(token)
    // supabase (admin): SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data: remitoId, error } = await supabase.rpc('retirar_de_proveedor', {
      p_proveedor_id:     dto.proveedor_id,
      p_obra_cod:         dto.obra_cod,
      p_fecha:            fecha,
      p_comprobante_url:  comp?.url  ?? null,
      p_comprobante_hash: comp?.hash ?? null,
      p_obs:              dto.obs ?? null,
      p_items:            dto.items,
      p_user_id:          userId,
    })
    if (error) {
      // Limpiar archivo huérfano si la transacción falla post-procesamiento.
      if (comp?.url) {
        await supabase.storage.from(BUCKET).remove([comp.url]).catch(() => undefined)
      }
      throw mapRpcError(error)
    }

    const { data: full, error: e2 } = await sb
      .from('remitos_retiro_proveedor')
      .select('*, items:remitos_retiro_proveedor_item(*)')
      .eq('id', remitoId as unknown as number)
      .maybeSingle()
    if (e2) throw new Error(e2.message)
    return full
  },

  // ── Comprobante: signed URL para upload (5 min) ──
  async firmarUploadComprobante(contentType: string) {
    const path = pathForUpload(contentType)
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path)
    if (error || !data) throw new StockProvHttpError(500, 'STORAGE_ERROR', error?.message)
    return { path, signedUrl: data.signedUrl, token: data.token, expiresIn: 300 }
  },

  // ── Comprobante: signed URL para descarga (15 min) ──
  async getComprobanteUrl(remitoId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: row, error: e0 } = await sb
      .from('remitos_retiro_proveedor')
      .select('comprobante_url')
      .eq('id', remitoId)
      .maybeSingle()
    if (e0) throw new StockProvHttpError(500, 'DB_ERROR', e0.message)
    if (!row || !row.comprobante_url) throw new StockProvHttpError(404, 'COMPROBANTE_NO_EXISTE')
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(row.comprobante_url, 900)
    if (error || !data) throw new StockProvHttpError(500, 'STORAGE_ERROR', error?.message)
    return { signedUrl: data.signedUrl, expiresIn: 900 }
  },
}
