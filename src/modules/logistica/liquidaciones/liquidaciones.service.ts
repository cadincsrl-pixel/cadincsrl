import type { PostgrestError } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase, supabase as supabaseAdmin } from '../../../lib/supabase.js'
import type { CreateLiquidacionDto, UpdateLiquidacionDto, CreateAdelantoDto, UpdateAdelantoDto, CreateEstadiaDto, UpdateEstadiaDto } from './liquidaciones.schema.js'

const BUCKET_ADELANTOS = 'adelantos-logistica'

// Campos de un adelanto de saldo (el que nace del cierre en negativo de una
// liquidación) que la edición manual no puede tocar: no es plata entregada al
// chofer, sino el espejo del neto negativo de esa liquidación. Descripción y
// comprobante sí se editan.
const CAMPOS_BLOQUEADOS_ADELANTO_SALDO = new Set(['forma_pago', 'monto', 'fecha'])

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
    /LIQUIDACION_VACIA/.test(msg)         ? 'LIQUIDACION_VACIA' :
    /MOTIVO_REQUERIDO/.test(msg)          ? 'MOTIVO_REQUERIDO' :
    /LIQUIDACION_NO_CERRADA/.test(msg)    ? 'LIQUIDACION_NO_CERRADA' :
    /LIQUIDACION_CON_CONTENIDO/.test(msg) ? 'LIQUIDACION_CON_CONTENIDO' :
    /LIQUIDACION_CON_SALDO_ARRASTRADO/.test(msg) ? 'LIQUIDACION_CON_SALDO_ARRASTRADO' :
    /SALDO_NEGATIVO_YA_LIQUIDADO/.test(msg) ? 'SALDO_NEGATIVO_YA_LIQUIDADO' :
    /SALDO_NEGATIVO_EN_BORRADOR/.test(msg)  ? 'SALDO_NEGATIVO_EN_BORRADOR' :
    error.code || 'UNKNOWN'

  switch (code) {
    case 'NO_AUTH':                     return new LiqHttpError(401, code)
    case 'SIN_PERFIL':                  return new LiqHttpError(403, code)
    case 'SIN_PERMISO':                 return new LiqHttpError(403, code, error.details ?? undefined)
    case 'LIQUIDACION_NO_EXISTE':       return new LiqHttpError(404, code)
    case 'LIQUIDACION_YA_EN_BORRADOR':  return new LiqHttpError(409, code)
    // Cerrar un borrador sin NADA vinculado dejaba una cáscara 'cerrada' con
    // los subtotales intactos, y los reportes la contaban como plata real
    // (pasó el 2026-07-26 con las liq 23 y 25). Migración 20260729d.
    case 'LIQUIDACION_VACIA':           return new LiqHttpError(409, code)
    // ── Anulación (migración 20260729e) ──
    case 'MOTIVO_REQUERIDO':            return new LiqHttpError(400, code)
    case 'LIQUIDACION_NO_CERRADA':      return new LiqHttpError(409, code)
    // Tiene tramos/adelantos/gastos adentro: anularla los dejaría marcados como
    // liquidados contra una liquidación nula. El camino es reabrir.
    case 'LIQUIDACION_CON_CONTENIDO':   return new LiqHttpError(409, code)
    case 'LIQUIDACION_CON_SALDO_ARRASTRADO': return new LiqHttpError(409, code)
    // El adelanto que nació del saldo negativo de esta liquidación ya fue
    // descontado en otra posterior; el `detail` trae el id de esa otra para
    // que el frontend diga cuál hay que reabrir primero.
    case 'SALDO_NEGATIVO_YA_LIQUIDADO': return new LiqHttpError(409, code, error.details ?? undefined)
    // Variante del anterior cuando la liquidación que consumió el saldo quedó
    // en 'borrador': no se puede reabrir ni aparece en el Historial, así que el
    // frontend tiene que mandar a eliminar ese borrador. `detail` = su id.
    case 'SALDO_NEGATIVO_EN_BORRADOR':  return new LiqHttpError(409, code, error.details ?? undefined)
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

  // ── Estadías: días de espera para cargar/descargar, pagados por día ──
  async getEstadias(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('estadias')
      .select('*')
      .order('fecha_desde', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createEstadia(dto: CreateEstadiaDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('estadias')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateEstadia(id: number, dto: UpdateEstadiaDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    // Gate: una estadía ya liquidada tiene su total snapshoteado en la
    // liquidación — editarla los desincronizaría.
    const { data: est, error: e0 } = await sb
      .from('estadias').select('liquidacion_id, fecha_desde, fecha_hasta, monto_dia').eq('id', id).maybeSingle()
    if (e0) throw new LiqHttpError(500, 'DB_ERROR', e0.message)
    if (!est) throw new LiqHttpError(404, 'ESTADIA_NO_EXISTE')
    if (est.liquidacion_id != null) throw new LiqHttpError(409, 'ESTADIA_LIQUIDADA')

    // dias/total se recalculan acá a partir del merge fila+patch — un patch
    // parcial (solo monto_dia, solo una fecha) no puede dejar total ≠
    // dias × monto_dia, y el rango invertido sale 400 en vez del CHECK de
    // Postgres como 500 crudo.
    const fechaDesde = dto.fecha_desde ?? est.fecha_desde
    const fechaHasta = dto.fecha_hasta ?? est.fecha_hasta
    if (fechaDesde > fechaHasta) throw new LiqHttpError(400, 'ESTADIA_RANGO_INVALIDO', 'fecha_desde debe ser <= fecha_hasta')
    const montoDia = dto.monto_dia ?? Number(est.monto_dia)
    const dias = Math.round((Date.parse(fechaHasta) - Date.parse(fechaDesde)) / 86_400_000) + 1

    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
    const { data, error } = await sb
      .from('estadias')
      .update({ ...patch, dias, total: dias * montoDia, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteEstadia(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: est, error: e0 } = await sb
      .from('estadias').select('liquidacion_id').eq('id', id).maybeSingle()
    if (e0) throw new LiqHttpError(500, 'DB_ERROR', e0.message)
    if (!est) throw new LiqHttpError(404, 'ESTADIA_NO_EXISTE')
    if (est.liquidacion_id != null) throw new LiqHttpError(409, 'ESTADIA_LIQUIDADA')

    const { error } = await sb.from('estadias').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
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
      p_tramo_chofer_ids:     dto.tramo_chofer_ids ?? [],
      p_estadia_ids:          dto.estadia_ids ?? [],
      p_total_estadias:       dto.total_estadias ?? 0,
      p_modalidad:            dto.modalidad ?? 'km_jornal',
      p_pct_aplicado:         dto.pct_aplicado ?? null,
      p_base_neta:            dto.base_neta ?? null,
      p_subtotal_pct:         dto.subtotal_pct ?? null,
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

    // Gate de estado: editar campos financieros de una liquidación 'cerrada'
    // reescribiría montos sin re-vincular los children (tramos/adelantos/gastos).
    // El flujo correcto es reabrir -> editar -> cerrar. Bloqueamos acá.
    const { data: liq, error: e0 } = await supabase
      .from('liquidaciones')
      .select('estado')
      .eq('id', id)
      .maybeSingle()
    if (e0) throw new LiqHttpError(500, 'DB_ERROR', e0.message)
    if (!liq) throw new LiqHttpError(404, 'LIQUIDACION_NO_EXISTE')
    if (liq.estado !== 'borrador') throw new LiqHttpError(409, 'LIQUIDACION_CERRADA')

    const { data, error } = await supabase
      .from('liquidaciones')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async cerrar(id: number, _token: string, userId: string) {
    // RPC transaccional: pasa los gastos vinculados 'aprobado' → 'pagado'
    // (el chofer cobra el reintegro con esta liquidación), cierra la
    // liquidación y, si el total neto quedó negativo, genera el adelanto
    // de saldo (forma_pago='saldo') que la próxima liquidación descuenta.
    // Idempotente: cerrar dos veces no duplica el adelanto.
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data, error } = await supabaseAdmin.rpc('cerrar_liquidacion', {
      p_liquidacion_id: id,
      p_user_id:        userId,
    })
    if (error) throw mapLiqRpcError(error)

    const res = (data ?? {}) as {
      liquidacion?: Record<string, unknown> | null
      adelanto_saldo_id?: number | null
      adelanto_saldo_monto?: number | string | null
    }
    if (!res.liquidacion) {
      throw new LiqHttpError(500, 'DB_ERROR', { dbMessage: 'cerrar_liquidacion no devolvió la liquidación' })
    }

    const adelantoSaldo = res.adelanto_saldo_id != null
      ? { id: Number(res.adelanto_saldo_id), monto: Number(res.adelanto_saldo_monto ?? 0) }
      : null

    if (adelantoSaldo) {
      console.log(`[liquidaciones] cierre con neto negativo: liq #${id} → adelanto #${adelantoSaldo.id} por ${adelantoSaldo.monto}`)
    }

    // El frontend usa esta respuesta para abrir el modal de detalle, así que
    // los campos de la liquidación van en la raíz (como cuando era un update
    // directo) y la info del adelanto generado se agrega aparte.
    return { ...res.liquidacion, adelanto_saldo: adelantoSaldo }
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

  // Anula una liquidación cerrada y VACÍA, dejando el rastro (quién, cuándo, por
  // qué) en lugar de borrarla: el número ya salió impreso en recibos, así que si
  // alguien pregunta por ella tiene que haber respuesta. Las que tienen
  // contenido se reabren, no se anulan — la RPC lo rechaza.
  async anular(id: number, _token: string, userId: string, motivo: string) {
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data, error } = await supabaseAdmin.rpc('anular_liquidacion', {
      p_liquidacion_id: id,
      p_user_id:        userId,
      p_motivo:         motivo,
    })
    if (error) throw mapLiqRpcError(error)
    // La RPC devuelve `returns liquidaciones`: PostgREST lo entrega como objeto.
    return Array.isArray(data) ? data[0] : data
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

    const { data: prev, error: ePrev } = await sb
      .from('adelantos')
      .select('comprobante_url, liquidacion_origen_id')
      .eq('id', id)
      .maybeSingle()
    if (ePrev) throw new LiqHttpError(500, 'DB_ERROR', ePrev.message)

    const patch: Record<string, unknown> = { updated_by: userId }
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue
      if (k === 'comprobante_path') continue  // se procesa abajo
      // Adelanto de saldo: forma_pago/monto/fecha los fijó el cierre de la
      // liquidación de origen y tienen que seguir espejándolo. Se saltean en
      // silencio (la UI deshabilita esos inputs; acá sólo se llega por API).
      if (prev?.liquidacion_origen_id != null && CAMPOS_BLOQUEADOS_ADELANTO_SALDO.has(k)) continue
      patch[k] = v
    }
    // Un adelanto de saldo no lleva comprobante: no hubo entrega de dinero, y
    // reabrir la liquidación de origen lo borra por SQL desde la RPC, sin pasar
    // por deleteAdelanto — el archivo quedaría huérfano en el bucket.
    const admiteComprobante = prev?.liquidacion_origen_id == null
    if (dto.comprobante_path !== undefined && admiteComprobante) {
      // El comprobante anterior se borra del bucket si va a ser reemplazado
      // o quitado.
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
    const { data: prev, error: ePrev } = await sb
      .from('adelantos')
      .select('comprobante_url, liquidacion_origen_id')
      .eq('id', id)
      .maybeSingle()
    // Si el SELECT falla no se puede saber si es un adelanto de saldo: cortar
    // acá en vez de borrar a ciegas.
    if (ePrev) throw new LiqHttpError(500, 'DB_ERROR', ePrev.message)

    // Borrar el adelanto de saldo desde acá haría desaparecer la deuda del
    // chofer sin rastro y dejaría inerte el guard de reabrir/eliminar (que
    // busca justo esta fila). El camino legítimo es reabrir la liquidación de
    // origen, que la borra en la misma transacción.
    if (prev?.liquidacion_origen_id != null) {
      throw new LiqHttpError(409, 'ADELANTO_DE_SALDO', String(prev.liquidacion_origen_id))
    }

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
