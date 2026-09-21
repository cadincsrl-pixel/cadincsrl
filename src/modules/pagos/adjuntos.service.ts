/**
 * Adjuntos de facturas y de órdenes de pago (bucket privado `pagos-docs`).
 *
 * Clon del patrón de logistica/cobros/adjuntos.service.ts: signed URL de 3
 * pasos (upload-url → PUT del cliente → registrar), sha256 calculado EN EL
 * SERVER sobre lo que quedó en el bucket, soft delete, y
 * `createSignedUrl(path, 900, { download })` para abrir.
 *
 * Dos tablas, una por entidad (`pagos_facturas_adjuntos` / `pagos_ordenes_adjuntos`),
 * con reglas de dedup distintas (diseño v3 §4.6):
 *   - factura: el mismo PDF cargado dos veces por compras es el caso a atrapar
 *     → índice global sobre el hash para tipo = 'factura' (un remito compartido
 *     por dos facturas es válido).
 *   - orden: por OP (un extracto respalda varias OP) + aviso COMPROBANTE_YA_USADO.
 *
 * El comprobante de una OP se sube ANTES de la fila, a `ordenes/pendientes/`;
 * `POST /ordenes` lo hashea, lo pasa a la RPC y, si la RPC falla, borra el
 * huérfano. Tras el commit se mueve a `ordenes/<id>/`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { PagosHttpError } from './pagos.errors.js'
import { controlarFactura, type ControlFactura } from './control.service.js'
import {
  MAX_ADJUNTO_BYTES, MIME_PERMITIDOS, PREFIJO_COMPROBANTE_PENDIENTE,
  FORMAS_CON_COMPROBANTE_OBLIGATORIO,
  type AdjuntoPendienteDto, type RegistrarAdjDto, type UploadUrlDto,
} from './pagos.schema.js'

export const BUCKET = 'pagos-docs'

export type Entidad = 'facturas' | 'ordenes'

const CFG: Record<Entidad, { tabla: string; fk: string; prefijo: string }> = {
  facturas: { tabla: 'pagos_facturas_adjuntos', fk: 'factura_id', prefijo: 'facturas' },
  ordenes:  { tabla: 'pagos_ordenes_adjuntos',  fk: 'orden_id',   prefijo: 'ordenes' },
}

const COLS = 'id, tipo, storage_path, nombre_archivo, mime_type, size_bytes, hash_sha256, obs, created_at, created_by, updated_at, updated_by, deleted_at'

const MIME_SET = new Set<string>(MIME_PERMITIDOS)

export async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

/** Descarga del bucket y devuelve tamaño + hash. 400 ARCHIVO_NO_SUBIDO si no está. */
export async function hashDelBucket(path: string): Promise<{ hash: string; size: number }> {
  const dl = await supabase.storage.from(BUCKET).download(path)
  if (dl.error || !dl.data) {
    throw new PagosHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: path, message: dl.error?.message })
  }
  return { hash: await sha256OfBlob(dl.data), size: dl.data.size }
}

export async function borrarDelBucket(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await supabase.storage.from(BUCKET).remove(paths).catch(() => undefined)
}

export interface AdjuntoProcesado {
  tipo: string
  storage_path: string
  nombre_archivo: string
  mime_type: string
  size_bytes: number
  hash_sha256: string
}

/**
 * Valida el prefijo `ordenes/pendientes/` y hashea cada archivo. Si uno falla,
 * se borran TODOS los que ya estaban subidos (el form reintenta subiendo de
 * nuevo) y se relanza.
 */
export async function procesarPendientes(adjuntos: AdjuntoPendienteDto[]): Promise<AdjuntoProcesado[]> {
  const out: AdjuntoProcesado[] = []
  for (const a of adjuntos) {
    if (!a.storage_path.startsWith(PREFIJO_COMPROBANTE_PENDIENTE) || a.storage_path.includes('..')) {
      throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: a.storage_path })
    }
  }
  try {
    for (const a of adjuntos) {
      const { hash, size } = await hashDelBucket(a.storage_path)
      out.push({ tipo: a.tipo, storage_path: a.storage_path, nombre_archivo: a.nombre_archivo, mime_type: a.mime_type, size_bytes: size, hash_sha256: hash })
    }
  } catch (err) {
    await borrarDelBucket(adjuntos.map((a) => a.storage_path))
    throw err
  }
  return out
}

/**
 * Aviso (no bloquea): el mismo comprobante ya respalda otra OP emitida. Un
 * resumen de tarjeta o un extracto pueden cubrir varias OP a propósito.
 */
export async function ordenesConHash(hashes: string[]): Promise<number[]> {
  if (hashes.length === 0) return []
  const { data, error } = await supabase
    .from('pagos_ordenes_adjuntos')
    .select('orden_id, pagos_ordenes!inner(estado)')
    .in('hash_sha256', hashes)
    .is('deleted_at', null)
    .eq('pagos_ordenes.estado', 'emitida')
  if (error) return []
  return [...new Set(((data ?? []) as { orden_id: number }[]).map((r) => r.orden_id))]
}

/**
 * Después del commit de la OP: mover cada archivo de `ordenes/pendientes/` a
 * `ordenes/<id>/` y actualizar la fila. Best-effort: si el move falla, la fila
 * sigue apuntando al path pendiente y el archivo sigue existiendo; el script
 * de barrido no lo toca porque tiene fila.
 */
export async function moverPendientesAOrden(ordenId: number, adjuntos: AdjuntoProcesado[]): Promise<void> {
  for (const a of adjuntos) {
    const nombre = a.storage_path.slice(a.storage_path.lastIndexOf('/') + 1)
    const destino = `ordenes/${ordenId}/${nombre}`
    const mv = await supabase.storage.from(BUCKET).move(a.storage_path, destino)
    if (mv.error) {
      console.error(`[pagos] no se pudo mover ${a.storage_path} → ${destino}: ${mv.error.message}`)
      continue
    }
    const { error } = await supabase
      .from('pagos_ordenes_adjuntos')
      .update({ storage_path: destino })
      .eq('orden_id', ordenId)
      .eq('storage_path', a.storage_path)
    if (error) console.error(`[pagos] archivo movido pero la fila quedó con el path viejo (${a.storage_path}): ${error.message}`)
  }
}

export const pagosAdjuntosService = {

  async listar(entidad: Entidad, id: number, incluirBorrados: boolean, token: string) {
    const cfg = CFG[entidad]
    const sb = createSupabaseClient(token)
    let q = sb.from(cfg.tabla).select(COLS).eq(cfg.fk, id)
    if (!incluirBorrados) q = q.is('deleted_at', null)
    const { data, error } = await q.order('tipo').order('created_at', { ascending: false })
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    return (data ?? []).map((a: any) => ({ ...a, borrado: a.deleted_at != null }))
  },

  /** Paso 1: URL firmada para que el cliente haga PUT. Un solo shape: { storage_path, signed_url, token }. */
  async uploadUrl(entidad: Entidad, id: number, dto: UploadUrlDto) {
    const cfg = CFG[entidad]
    if (!MIME_SET.has(dto.mime_type)) throw new PagosHttpError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_ADJUNTO_BYTES) {
      throw new PagosHttpError(400, 'TAMANO_INVALIDO', { size: dto.size_bytes, max: MAX_ADJUNTO_BYTES })
    }
    const path = `${cfg.prefijo}/${id}/${randomUUID()}.${extFromMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new PagosHttpError(500, 'UPLOAD_URL_ERROR', error.message)
    return { storage_path: path, signed_url: data.signedUrl, token: data.token, tipo: dto.tipo }
  },

  /** Comprobante de OP ANTES de la fila: `ordenes/pendientes/<uuid>.<ext>`. */
  async uploadUrlPendiente(dto: { tipo: string; nombre_archivo: string; mime_type: string; size_bytes: number }) {
    if (!MIME_SET.has(dto.mime_type)) throw new PagosHttpError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_ADJUNTO_BYTES) {
      throw new PagosHttpError(400, 'TAMANO_INVALIDO', { size: dto.size_bytes, max: MAX_ADJUNTO_BYTES })
    }
    const path = `${PREFIJO_COMPROBANTE_PENDIENTE}${randomUUID()}.${extFromMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new PagosHttpError(500, 'UPLOAD_URL_ERROR', error.message)
    return { storage_path: path, signed_url: data.signedUrl, token: data.token, tipo: dto.tipo }
  },

  /** El modal se cerró sin guardar: borrar el comprobante pendiente. Solo bajo `ordenes/pendientes/`. */
  async borrarPendiente(storagePath: string) {
    if (!storagePath.startsWith(PREFIJO_COMPROBANTE_PENDIENTE) || storagePath.includes('..')) {
      throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: storagePath })
    }
    await borrarDelBucket([storagePath])
    return { success: true }
  },

  /** Paso 3: el archivo ya está en el bucket; se hashea y se registra la fila. */
  async registrar(entidad: Entidad, id: number, dto: RegistrarAdjDto, userId: string, token: string) {
    const cfg = CFG[entidad]
    if (!dto.storage_path.startsWith(`${cfg.prefijo}/${id}/`) || dto.storage_path.includes('..')) {
      throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: dto.storage_path })
    }
    const { hash, size } = await hashDelBucket(dto.storage_path)

    // Pre-chequeo para devolver el id del existente (el índice único es la
    // defensa real contra la carrera; acá solo se arma un 409 útil).
    if (entidad === 'facturas' && dto.tipo === 'factura') {
      const { data: dup } = await supabase
        .from(cfg.tabla).select('id, factura_id').eq('hash_sha256', hash).eq('tipo', 'factura').is('deleted_at', null).limit(1).maybeSingle()
      if (dup) {
        await borrarDelBucket([dto.storage_path])
        throw new PagosHttpError(409, 'ADJ_DUPLICADO', { id_existente: (dup as any).id, entidad: 'factura', factura_id: (dup as any).factura_id })
      }
    }

    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from(cfg.tabla)
      .insert({
        [cfg.fk]:       id,
        tipo:           dto.tipo,
        storage_path:   dto.storage_path,
        nombre_archivo: dto.nombre_archivo,
        hash_sha256:    hash,
        mime_type:      dto.mime_type,
        size_bytes:     size,
        obs:            dto.obs ?? '',
        created_by:     userId,
        updated_by:     userId,
      })
      .select(COLS)
      .single()
    if (error) {
      await borrarDelBucket([dto.storage_path])
      if (error.code === '23505' || /unique/i.test(error.message)) {
        throw new PagosHttpError(409, 'ADJ_DUPLICADO', { entidad: entidad === 'facturas' ? 'factura' : 'orden' })
      }
      if (error.code === '23503') throw new PagosHttpError(404, entidad === 'facturas' ? 'FACTURA_NO_EXISTE' : 'ORDEN_NO_EXISTE')
      throw new PagosHttpError(500, 'DB_ERROR', error.message)
    }

    // Control automático del comprobante contra lo tipeado (20260921j). Sólo
    // sobre el PDF/foto de la FACTURA: un remito o una orden de compra no
    // tienen el número ni el total que hay que controlar.
    //
    // Va acá y no en un endpoint aparte porque el pedido fue «sin que alguien
    // dé la orden»: subir el comprobante ES la orden. Se espera el resultado
    // para devolverlo junto con el adjunto y que la pantalla lo muestre de una,
    // sin pollear. `controlarFactura` no lanza nunca; el `?? null` es por si
    // alguna vez lo hiciera: el adjunto ya está guardado y no se pierde.
    let control: ControlFactura | null = null
    if (entidad === 'facturas' && dto.tipo === 'factura') {
      const adj = data as { id: number }
      control = await controlarFactura(id, adj.id, dto.storage_path, dto.mime_type).catch(() => null)
    }
    return { ...(data as Record<string, unknown>), control }
  },

  async signedUrl(entidad: Entidad, id: number, adjId: number, token: string) {
    const cfg = CFG[entidad]
    const sb = createSupabaseClient(token)
    const { data: doc, error } = await sb
      .from(cfg.tabla).select('id, storage_path, nombre_archivo').eq('id', adjId).eq(cfg.fk, id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!doc) throw new PagosHttpError(404, 'ADJ_NO_EXISTE')
    const { data, error: sErr } = await supabase.storage
      .from(BUCKET).createSignedUrl((doc as any).storage_path, 900, { download: (doc as any).nombre_archivo })
    if (sErr) throw new PagosHttpError(500, 'SIGNED_URL_ERROR', sErr.message)
    return { url: data.signedUrl, nombre_archivo: (doc as any).nombre_archivo }
  },

  /**
   * Soft delete. En una OP emitida cuya forma exige comprobante, el
   * `comprobante_pago` solo se borra si queda otro vigente (reemplazar el
   * equivocado); si no, 409 ADJUNTO_REQUERIDO.
   */
  async softDelete(entidad: Entidad, id: number, adjId: number, userId: string, token: string) {
    const cfg = CFG[entidad]
    const sb = createSupabaseClient(token)
    const { data: adj, error: e0 } = await sb
      .from(cfg.tabla).select('id, tipo').eq('id', adjId).eq(cfg.fk, id).is('deleted_at', null).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    if (!adj) throw new PagosHttpError(404, 'ADJ_NO_EXISTE')

    if (entidad === 'ordenes' && (adj as any).tipo === 'comprobante_pago') {
      const { data: orden } = await sb.from('pagos_ordenes').select('estado, forma_pago, monto_pagado').eq('id', id).maybeSingle()
      const o = orden as { estado: string; forma_pago: string | null; monto_pagado: number } | null
      const requerido = !!o && o.estado === 'emitida' && Number(o.monto_pagado) > 0
        && (FORMAS_CON_COMPROBANTE_OBLIGATORIO as readonly string[]).includes(o.forma_pago ?? '')
      if (requerido) {
        const { count } = await sb.from(cfg.tabla).select('id', { count: 'exact', head: true })
          .eq(cfg.fk, id).eq('tipo', 'comprobante_pago').is('deleted_at', null).neq('id', adjId)
        if (!count) throw new PagosHttpError(409, 'ADJUNTO_REQUERIDO', { forma_pago: o!.forma_pago })
      }
    }

    const { data, error } = await sb
      .from(cfg.tabla)
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', adjId).eq(cfg.fk, id).is('deleted_at', null)
      .select('id').maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'ADJ_NO_EXISTE')
    return { success: true, id: (data as any).id }
  },
}
