/**
 * Cobranzas de Ventas (recibos RC, imputaciones y compensaciones). Base:
 * 20260924k…n. Lecturas sobre `v_ventas_cobros` / `v_ventas_imputaciones` y
 * escrituras SOLO por las RPC `ventas_*` (un INSERT/UPDATE suelto rebota con
 * VENTAS_SOLO_RPC), que validan saldos bajo FOR UPDATE y vuelven a chequear
 * los flags `registrar_cobros` / `anular_cobros`.
 *
 * Ambiente: todo filtra `ambiente = 'prod'` salvo que se pida 'homo' (las
 * facturas de homologación no son deuda real).
 *
 * Certificados de retención (bucket privado `ventas-docs`, mismo molde que
 * `pagos-docs`): el archivo se sube ANTES del cobro a
 * `retenciones/pendientes/<uuid>.<ext>` con una URL firmada; el path viaja
 * dentro de la retención en `POST /cobros`. El backend descarga el archivo,
 * calcula el sha256 EN EL SERVER y se lo pasa a la RPC (el trigger de la base
 * rechaza el mismo certificado en dos retenciones de cobros vigentes). Tras el
 * commit, se mueve a `retenciones/<cobro_id>/`. Si la RPC falla, el archivo
 * queda en pendientes para que el modal reintente sin volver a subirlo.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { rpc } from './comun.js'
import type {
  AdjuntoRetencionDto, AmbienteCobranza, CompensarDto, ImputarDto, ItemImputacionDto, ListCobrosQuery,
  ListImputacionesQuery, RegistrarCobroDto, RetencionCobroDto, UploadRetencionDto,
} from './facturacion.schema.js'

export const BUCKET_VENTAS = 'ventas-docs'
export const PREFIJO_RETENCION_PENDIENTE = 'retenciones/pendientes/'
export const MAX_ADJUNTO_BYTES = 10 * 1024 * 1024
export const MIME_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const
const MIME_SET = new Set<string>(MIME_PERMITIDOS)

/** Detalle de un cobro: la forma de `_ventas_cobro_json`. */
export interface CobroDetalle {
  cobro: Record<string, unknown> & { id: number }
  medios: Array<Record<string, unknown>>
  retenciones: Array<Record<string, unknown> & { id: number; adjunto_path: string | null }>
  imputaciones: Array<Record<string, unknown>>
}

export const ambienteDe = (a?: string | null): AmbienteCobranza => (a === 'homo' ? 'homo' : 'prod')

function extDeMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

function pathPendienteValido(p: string): boolean {
  return p.startsWith(PREFIJO_RETENCION_PENDIENTE) && !p.includes('..') && /^[\w./-]+$/.test(p)
}

/** Descarga del bucket: tamaño + sha256. 400 ARCHIVO_NO_SUBIDO si no está. */
async function hashDelBucket(path: string): Promise<{ hash: string; size: number }> {
  const dl = await supabase.storage.from(BUCKET_VENTAS).download(path)
  if (dl.error || !dl.data) {
    throw new FacturacionHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: path, message: dl.error?.message })
  }
  const buf = Buffer.from(await dl.data.arrayBuffer())
  return { hash: createHash('sha256').update(buf).digest('hex'), size: dl.data.size }
}

/** Retenciones del body → forma de la RPC, con hash/tamaño calculados sobre lo que quedó en el bucket. */
export async function prepararRetenciones(rets: RetencionCobroDto[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const vistos = new Map<string, number>()
  for (const [i, r] of rets.entries()) {
    const base: Record<string, unknown> = {
      tipo: r.tipo, importe: r.importe, jurisdiccion: r.jurisdiccion ?? '', certificado_numero: r.certificado_numero ?? '',
      fecha: r.fecha ?? null, obs: r.obs ?? '',
    }
    const path = (r.adjunto_path ?? '').trim()
    if (path) {
      if (!pathPendienteValido(path)) {
        throw new FacturacionHttpError(400, 'PATH_INVALIDO', { campo: `retenciones.${i}.adjunto_path`, indice: i + 1, storage_path: path })
      }
      const { hash, size } = await hashDelBucket(path)
      const otro = vistos.get(hash)
      if (otro !== undefined) {
        throw new FacturacionHttpError(409, 'RETENCION_ADJUNTO_DUPLICADO', { indice: i + 1, mismo_que_indice: otro })
      }
      vistos.set(hash, i + 1)
      Object.assign(base, {
        adjunto_path: path, adjunto_hash: hash, adjunto_size: size,
        adjunto_nombre: r.adjunto_nombre ?? path.slice(path.lastIndexOf('/') + 1),
        adjunto_mime: r.adjunto_mime ?? null,
      })
    }
    out.push(base)
  }
  return out
}

/** Después del commit: `retenciones/pendientes/x` → `retenciones/<cobro_id>/x`. Best-effort. */
async function moverAdjuntos(cobroId: number, retenciones: CobroDetalle['retenciones']): Promise<void> {
  for (const r of retenciones) {
    const p = r.adjunto_path
    if (!p || !p.startsWith(PREFIJO_RETENCION_PENDIENTE)) continue
    const destino = `retenciones/${cobroId}/${p.slice(p.lastIndexOf('/') + 1)}`
    const mv = await supabase.storage.from(BUCKET_VENTAS).move(p, destino)
    if (mv.error) {
      console.error(`[facturacion] no se pudo mover ${p} → ${destino}: ${mv.error.message}`)
      continue
    }
    const { error } = await supabase.from('ventas_cobro_retenciones').update({ adjunto_path: destino }).eq('id', r.id)
    if (error) console.error(`[facturacion] certificado movido pero la retención ${r.id} quedó con el path viejo: ${error.message}`)
  }
}

function itemsRpc(items: ItemImputacionDto[]): Array<Record<string, unknown>> {
  return items.map((i) => (i.factura_id != null ? { factura_id: i.factura_id, importe: i.importe } : { externo_id: i.externo_id, importe: i.importe }))
}

const sinBusq = <T extends Record<string, unknown>>(r: T): Omit<T, 'busq'> => {
  const { busq: _b, ...resto } = r
  return resto
}

export const cobrosService = {
  async listar(q: ListCobrosQuery, db: SupabaseClient = supabase): Promise<{ rows: unknown[]; total: number }> {
    const page = q.page ?? 1
    const pageSize = q.pageSize ?? 50
    let s = db.from('v_ventas_cobros').select('*', { count: 'exact' }).eq('ambiente', ambienteDe(q.ambiente))
    if (q.cliente_id) s = s.eq('cliente_id', q.cliente_id)
    if (q.desde) s = s.gte('fecha', q.desde)
    if (q.hasta) s = s.lte('fecha', q.hasta)
    if (q.estado) s = s.eq('estado', q.estado)
    if (q.con_a_cuenta === '1' || q.con_a_cuenta === 'true') s = s.eq('estado', 'vigente').gt('a_cuenta', 0)
    const t = normTxt(q.q ?? '')
    if (t) for (const w of t.split(/\s+/).filter(Boolean).slice(0, 6)) s = s.ilike('busq', `%${w}%`)
    const { data, error, count } = await s
      .order('fecha', { ascending: false }).order('id', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error) throw mapRpcError(error as PgError)
    return { rows: (data ?? []).map((r) => sinBusq(r as Record<string, unknown>)), total: count ?? 0 }
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<CobroDetalle> {
    const d = await rpc<CobroDetalle | null>(db, '_ventas_cobro_json', { p_id: id })
    if (!d || !d.cobro) throw new FacturacionHttpError(404, 'COBRO_NO_EXISTE', { cobro_id: id })
    return { ...d, cobro: sinBusq(d.cobro) as CobroDetalle['cobro'] }
  },

  async registrar(dto: RegistrarCobroDto, ambienteQuery: string | undefined, userId: string, db: SupabaseClient = supabase): Promise<CobroDetalle> {
    const ambiente = ambienteDe(dto.cobro.ambiente ?? ambienteQuery)
    const retenciones = await prepararRetenciones(dto.retenciones ?? [])
    const medios = (dto.medios ?? []).map((m) => ({
      forma: m.forma, importe: m.importe, cuenta_bancaria_id: m.cuenta_bancaria_id ?? null,
      cheque_numero: m.cheque_numero ?? null, cheque_banco: m.cheque_banco ?? null, cheque_librador: m.cheque_librador ?? null,
      cheque_fecha_cobro: m.cheque_fecha_cobro ?? null, obs: m.obs ?? '',
    }))
    const res = await db.rpc('ventas_registrar_cobro', {
      p_cobro: { fecha: dto.cobro.fecha ?? null, cliente_id: dto.cobro.cliente_id, obs: dto.cobro.obs ?? '', ambiente },
      p_medios: medios,
      p_retenciones: retenciones,
      p_imputaciones: itemsRpc(dto.imputaciones ?? []),
      p_user_id: userId,
    })
    if (res.error) {
      const pg = res.error as PgError
      // Índice único (cobro_id, adjunto_hash): el mismo archivo dos veces en el mismo cobro.
      if (pg.code === '23505' && /adjunto_hash|hash_uidx/.test(pg.message ?? '')) throw new FacturacionHttpError(409, 'RETENCION_ADJUNTO_DUPLICADO')
      throw mapRpcError(pg)
    }
    const d = res.data as CobroDetalle
    const cobroId = Number(d.cobro.id)
    console.info(`[facturacion] cobro ${String(d.cobro.numero_fmt)} (${ambiente}) id=${cobroId} cliente=${dto.cobro.cliente_id} total=${String(d.cobro.total)} aplicado=${String(d.cobro.aplicado)} por ${userId}`)
    if (d.retenciones.some((r) => r.adjunto_path?.startsWith(PREFIJO_RETENCION_PENDIENTE))) {
      await moverAdjuntos(cobroId, d.retenciones)
      return this.detalle(cobroId, db)
    }
    return { ...d, cobro: sinBusq(d.cobro) as CobroDetalle['cobro'] }
  },

  /** Aplicar lo que quedó a cuenta de un cobro. */
  async imputar(cobroId: number, dto: ImputarDto, userId: string, db: SupabaseClient = supabase): Promise<CobroDetalle> {
    const d = await rpc<CobroDetalle>(db, 'ventas_imputar', {
      p_origen: { cobro_id: cobroId }, p_items: itemsRpc(dto.items), p_user_id: userId, p_fecha: dto.fecha ?? null,
    })
    console.info(`[facturacion] imputación de cobro ${cobroId}: ${dto.items.length} ítem(s) por ${userId}`)
    return { ...d, cobro: sinBusq(d.cobro) as CobroDetalle['cobro'] }
  },

  /** Compensar una NC (del ERP o externa) contra débitos del mismo cliente. */
  async compensar(dto: CompensarDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const origen = dto.nc.factura_id != null ? { nc_factura_id: dto.nc.factura_id } : { nc_externo_id: dto.nc.externo_id }
    const r = await rpc<unknown>(db, 'ventas_imputar', {
      p_origen: origen, p_items: itemsRpc(dto.items), p_user_id: userId, p_fecha: dto.fecha ?? null,
    })
    console.info(`[facturacion] compensación ${JSON.stringify(origen)}: ${dto.items.length} ítem(s) por ${userId}`)
    return r
  },

  async anular(cobroId: number, motivo: string, userId: string, db: SupabaseClient = supabase): Promise<CobroDetalle> {
    const d = await rpc<CobroDetalle>(db, 'ventas_anular_cobro', { p_id: cobroId, p_motivo: motivo, p_user_id: userId })
    console.info(`[facturacion] cobro ${cobroId} anulado por ${userId}: ${motivo}`)
    return { ...d, cobro: sinBusq(d.cobro) as CobroDetalle['cobro'] }
  },

  async anularImputacion(id: number, motivo: string | null | undefined, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const r = await rpc<{ imputacion: unknown; cobro?: CobroDetalle }>(db, 'ventas_anular_imputacion', {
      p_id: id, p_user_id: userId, p_motivo: motivo ?? null,
    })
    console.info(`[facturacion] imputación ${id} anulada por ${userId}`)
    return r.cobro ? { ...r, cobro: { ...r.cobro, cobro: sinBusq(r.cobro.cobro) } } : r
  },

  /** Imputaciones por origen o destino (ficha de factura, de NC, de externo o de cobro). */
  async imputaciones(q: ListImputacionesQuery, db: SupabaseClient = supabase): Promise<unknown[]> {
    const filtros = (['cobro_id', 'factura_id', 'externo_id', 'nc_factura_id', 'nc_externo_id'] as const).filter((k) => q[k] != null)
    if (filtros.length === 0) throw new FacturacionHttpError(400, 'DATOS_INVALIDOS', { campo: 'factura_id', mensaje: 'filtrar por cobro, factura, externo o NC' })
    let s = db.from('v_ventas_imputaciones').select('*')
    for (const k of filtros) s = s.eq(k, q[k] as number)
    if (!(q.incluir_anuladas === '1' || q.incluir_anuladas === 'true')) s = s.eq('anulada', false)
    const { data, error } = await s.order('fecha').order('id').limit(1000)
    if (error) throw mapRpcError(error as PgError)
    return data ?? []
  },

  // ── Certificados de retención ────────────────────────────────────────────

  /** URL firmada para subir un certificado ANTES de registrar el cobro. */
  async uploadUrlRetencion(dto: UploadRetencionDto): Promise<{ storage_path: string; signed_url: string; token: string; nombre_archivo: string }> {
    if (!MIME_SET.has(dto.mime_type)) throw new FacturacionHttpError(400, 'MIME_NO_PERMITIDO', { campo: 'mime_type', mime: dto.mime_type, permitidos: MIME_PERMITIDOS })
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_ADJUNTO_BYTES) {
      throw new FacturacionHttpError(400, 'TAMANO_INVALIDO', { campo: 'size_bytes', size: dto.size_bytes, max: MAX_ADJUNTO_BYTES })
    }
    const path = `${PREFIJO_RETENCION_PENDIENTE}${randomUUID()}.${extDeMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(BUCKET_VENTAS).createSignedUploadUrl(path)
    if (error || !data) throw new FacturacionHttpError(500, 'UPLOAD_URL_ERROR', { mensaje: error?.message })
    return { storage_path: path, signed_url: data.signedUrl, token: data.token, nombre_archivo: dto.nombre_archivo }
  },

  /**
   * Adjuntar (o reemplazar) el certificado de una retención ya registrada: el
   * certificado suele llegar días después del pago. El adjunto es la única
   * columna de la retención que se toca fuera de las RPC.
   */
  async adjuntarRetencion(retencionId: number, dto: AdjuntoRetencionDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const { data: ret, error: e0 } = await db.from('ventas_cobro_retenciones')
      .select('id, cobro_id, adjunto_path').eq('id', retencionId).maybeSingle()
    if (e0) throw mapRpcError(e0 as PgError)
    if (!ret) throw new FacturacionHttpError(404, 'RETENCION_NO_EXISTE', { retencion_id: retencionId })
    const r = ret as { id: number; cobro_id: number; adjunto_path: string | null }
    const path = dto.adjunto_path.trim()
    if (!pathPendienteValido(path)) throw new FacturacionHttpError(400, 'PATH_INVALIDO', { campo: 'adjunto_path', storage_path: path })
    const { hash, size } = await hashDelBucket(path)
    const destino = `retenciones/${r.cobro_id}/${path.slice(path.lastIndexOf('/') + 1)}`
    const { error } = await db.from('ventas_cobro_retenciones').update({
      adjunto_path: path, adjunto_hash: hash, adjunto_size: size,
      adjunto_nombre: dto.adjunto_nombre ?? path.slice(path.lastIndexOf('/') + 1), adjunto_mime: dto.adjunto_mime ?? null,
      updated_by: userId,
    }).eq('id', retencionId)
    if (error) {
      const pg = error as PgError
      if (pg.code === '23505') throw new FacturacionHttpError(409, 'RETENCION_ADJUNTO_DUPLICADO', { retencion_id: retencionId })
      throw mapRpcError(pg)
    }
    const mv = await supabase.storage.from(BUCKET_VENTAS).move(path, destino)
    if (!mv.error) {
      await supabase.from('ventas_cobro_retenciones').update({ adjunto_path: destino }).eq('id', retencionId)
    } else {
      console.error(`[facturacion] no se pudo mover ${path} → ${destino}: ${mv.error.message}`)
    }
    // El archivo anterior (si lo había) deja de estar referenciado.
    if (r.adjunto_path && r.adjunto_path !== path && r.adjunto_path !== destino) {
      await supabase.storage.from(BUCKET_VENTAS).remove([r.adjunto_path]).catch(() => undefined)
    }
    const { data } = await db.from('ventas_cobro_retenciones').select('*').eq('id', retencionId).single()
    return data
  },

  /** URL firmada (15 min) para ver/bajar el certificado de una retención. */
  async urlRetencion(retencionId: number, db: SupabaseClient = supabase): Promise<{ url: string; nombre_archivo: string | null; mime: string | null }> {
    const { data, error } = await db.from('ventas_cobro_retenciones')
      .select('id, adjunto_path, adjunto_nombre, adjunto_mime').eq('id', retencionId).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new FacturacionHttpError(404, 'RETENCION_NO_EXISTE', { retencion_id: retencionId })
    const r = data as { adjunto_path: string | null; adjunto_nombre: string | null; adjunto_mime: string | null }
    if (!r.adjunto_path) throw new FacturacionHttpError(404, 'RETENCION_SIN_ADJUNTO', { retencion_id: retencionId })
    const s = await supabase.storage.from(BUCKET_VENTAS).createSignedUrl(r.adjunto_path, 900, { download: r.adjunto_nombre ?? true })
    if (s.error || !s.data) throw new FacturacionHttpError(500, 'SIGNED_URL_ERROR', { mensaje: s.error?.message })
    return { url: s.data.signedUrl, nombre_archivo: r.adjunto_nombre, mime: r.adjunto_mime }
  },

  /** El modal se cerró sin guardar: borrar el certificado pendiente (solo bajo retenciones/pendientes/). */
  async descartarPendiente(storagePath: string): Promise<{ ok: true }> {
    if (!pathPendienteValido(storagePath)) throw new FacturacionHttpError(400, 'PATH_INVALIDO', { campo: 'storage_path', storage_path: storagePath })
    await supabase.storage.from(BUCKET_VENTAS).remove([storagePath]).catch(() => undefined)
    return { ok: true }
  },
}
