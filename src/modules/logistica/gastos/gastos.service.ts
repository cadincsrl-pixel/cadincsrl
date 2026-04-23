import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'
import type {
  CreateGastoDto, UpdateGastoDto, RechazarGastoDto, MarcarPagadoDto,
  ListGastosQuery, UploadComprobanteDto,
} from './gastos.schema.js'

const BUCKET = 'gastos-logistica'

// ── HttpError con status + code estables para el mapping del route ──
export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'HttpError'
  }
}

// Campos "financieros" que son inmutables una vez que el gasto fue aprobado.
// Si `liquidacion_id != null`, TODO es inmutable (ver canMutate).
const CAMPOS_FINANCIEROS = new Set<keyof UpdateGastoDto>([
  'monto', 'pagado_por', 'chofer_id', 'camion_id', 'categoria_id', 'comprobante_path',
])

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
  const uuid = randomUUID()
  const ext  = extFromMime(contentType)
  return `gastos/${yyyy}/${mm}/${uuid}.${ext}`
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

// Procesa un comprobante recién subido: descarga, calcula sha256, valida
// uniqueness. Si el hash ya existe en otro gasto (no eliminado), lanza
// COMPROBANTE_DUPLICADO y borra el archivo huérfano del bucket.
async function procesarComprobante(
  path: string | null | undefined,
  gastoIdExcluir?: number,
): Promise<{ url: string; hash: string } | null> {
  if (!path) return null

  // Descargar del bucket (cliente service-role).
  const dl = await supabase.storage.from(BUCKET).download(path)
  if (dl.error || !dl.data) {
    throw new HttpError(400, 'COMPROBANTE_INEXISTENTE', { path, supabaseError: dl.error?.message })
  }
  const hash = await sha256OfBlob(dl.data)

  // Chequear uniqueness (excluyendo el propio gasto si estamos editando).
  let q = supabase
    .from('gastos_logistica')
    .select('id')
    .eq('comprobante_hash', hash)
    .is('deleted_at', null)
    .limit(1)
  if (gastoIdExcluir != null) q = q.neq('id', gastoIdExcluir)
  const { data: dup, error: e } = await q
  if (e) throw new HttpError(500, 'DB_ERROR', e.message)

  if (dup && dup.length > 0) {
    // Borrar el huérfano para no ensuciar el bucket.
    await supabase.storage.from(BUCKET).remove([path])
    throw new HttpError(409, 'COMPROBANTE_DUPLICADO', {
      gasto_id_existente: dup[0]!.id,
      hash,
    })
  }

  return { url: path, hash }
}

export const gastosService = {

  // ── Catálogo de categorías ───────────────────────────────────
  async listCategorias(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('gastos_categorias')
      .select('*')
      .order('orden')
      .order('nombre')
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Upload de comprobante (emite signed URL) ─────────────────
  async firmarUploadComprobante(dto: UploadComprobanteDto, _userId: string) {
    const path = pathForUpload(dto.content_type)
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path)
    if (error || !data) {
      throw new HttpError(500, 'STORAGE_ERROR', error?.message)
    }
    return {
      path,
      signedUrl:  data.signedUrl,
      token:      data.token,
      expiresIn:  300, // 5 min (el default de Supabase)
    }
  },

  async getComprobanteUrl(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: gasto, error: e0 } = await sb
      .from('gastos_logistica')
      .select('comprobante_url')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (e0)   throw new HttpError(500, 'DB_ERROR', e0.message)
    if (!gasto || !gasto.comprobante_url) {
      throw new HttpError(404, 'COMPROBANTE_NO_EXISTE')
    }
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(gasto.comprobante_url, 900) // 15 min
    if (error || !data) throw new HttpError(500, 'STORAGE_ERROR', error?.message)
    return { signedUrl: data.signedUrl, expiresIn: 900 }
  },

  // ── Listado con filtros + paginación ─────────────────────────
  async list(filters: ListGastosQuery, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('gastos_logistica')
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a)', { count: 'exact' })
      .is('deleted_at', null)

    if (filters.camion_id)     q = q.eq('camion_id',    filters.camion_id)
    if (filters.chofer_id)     q = q.eq('chofer_id',    filters.chofer_id)
    if (filters.tramo_id)      q = q.eq('tramo_id',     filters.tramo_id)
    if (filters.lugar_id)      q = q.eq('lugar_id',     filters.lugar_id)
    if (filters.categoria_id)  q = q.eq('categoria_id', filters.categoria_id)
    if (filters.estado)        q = q.eq('estado',       filters.estado)
    if (filters.pagado_por)    q = q.eq('pagado_por',   filters.pagado_por)
    if (filters.metodo_pago)   q = q.eq('metodo_pago',  filters.metodo_pago)
    if (filters.desde)         q = q.gte('fecha', filters.desde)
    if (filters.hasta)         q = q.lte('fecha', filters.hasta)
    if (filters.liquidado === true)  q = q.not('liquidacion_id', 'is', null)
    if (filters.liquidado === false) q = q.is('liquidacion_id', null)
    if (filters.q) {
      // Escapar % y , para evitar que rompan el .or()
      const safe = filters.q.replace(/[%,]/g, ' ')
      q = q.or(`descripcion.ilike.%${safe}%,proveedor.ilike.%${safe}%,comprobante_nro.ilike.%${safe}%`)
    }

    q = q
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1)

    const { data, error, count } = await q
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    return {
      items:   data ?? [],
      total:   count ?? 0,
      limit:   filters.limit,
      offset:  filters.offset,
      hasMore: (count ?? 0) > filters.offset + (data?.length ?? 0),
    }
  },

  async getById(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('gastos_logistica')
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a)')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new HttpError(404, 'GASTO_NO_EXISTE')
    return data
  },

  // ── Crear gasto (siempre en estado='pendiente') ──────────────
  async create(dto: CreateGastoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    // Procesar comprobante si viene en el body (ya está en el bucket desde
    // /upload-comprobante). Calcula hash + valida duplicados.
    const comp = await procesarComprobante(dto.comprobante_path ?? null)

    const row = {
      camion_id:       dto.camion_id ?? null,
      chofer_id:       dto.chofer_id ?? null,
      tramo_id:        dto.tramo_id ?? null,
      lugar_id:        dto.lugar_id ?? null,
      categoria_id:    dto.categoria_id,
      fecha:           dto.fecha,
      monto:           dto.monto,
      descripcion:     dto.descripcion ?? '',
      proveedor:       dto.proveedor ?? null,
      metodo_pago:     dto.metodo_pago ?? 'efectivo',
      pagado_por:      dto.pagado_por ?? 'empresa',
      comprobante_url:  comp?.url  ?? null,
      comprobante_hash: comp?.hash ?? null,
      comprobante_nro: dto.comprobante_nro ?? '',
      obs:             dto.obs ?? '',
      estado:          'pendiente', // siempre — nunca confiar en lo que venga en el body
      created_by:      userId,
      updated_by:      userId,
    }

    const { data, error } = await sb
      .from('gastos_logistica')
      .insert(row)
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Update con reglas de inmutabilidad ───────────────────────
  async update(id: number, dto: UpdateGastoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    const { data: actual, error: e0 } = await sb
      .from('gastos_logistica')
      .select('id, estado, liquidacion_id, comprobante_url')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (e0)     throw new HttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new HttpError(404, 'GASTO_NO_EXISTE')

    // Inmutable total si ya está en una liquidación.
    if (actual.liquidacion_id) {
      throw new HttpError(409, 'GASTO_EN_LIQUIDACION', {
        liquidacion_id: actual.liquidacion_id,
        message: 'El gasto está vinculado a una liquidación. Para corregir, hacer contra-asiento.',
      })
    }

    // Si está aprobado, bloquear cambios a campos financieros.
    if (actual.estado === 'aprobado') {
      const cambiosFinancieros = Object.keys(dto).filter(
        k => CAMPOS_FINANCIEROS.has(k as keyof UpdateGastoDto) && dto[k as keyof UpdateGastoDto] !== undefined,
      )
      if (cambiosFinancieros.length > 0) {
        throw new HttpError(409, 'GASTO_NO_EDITABLE', {
          campos: cambiosFinancieros,
          message: 'Gasto aprobado: no se pueden modificar campos financieros. Rechazar y recrear si hace falta.',
        })
      }
    }

    // Procesar comprobante nuevo si viene.
    const patch: Record<string, unknown> = { updated_by: userId }
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue
      if (k === 'comprobante_path') continue // se procesa abajo
      patch[k] = v
    }

    if (dto.comprobante_path !== undefined) {
      if (dto.comprobante_path === null) {
        patch.comprobante_url  = null
        patch.comprobante_hash = null
      } else {
        const comp = await procesarComprobante(dto.comprobante_path, id)
        patch.comprobante_url  = comp?.url  ?? null
        patch.comprobante_hash = comp?.hash ?? null
      }
    }

    const { data, error } = await sb
      .from('gastos_logistica')
      .update(patch)
      .eq('id', id)
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Soft delete ──────────────────────────────────────────────
  async softDelete(id: number, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    const { data: actual, error: e0 } = await sb
      .from('gastos_logistica')
      .select('id, liquidacion_id')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (e0)     throw new HttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new HttpError(404, 'GASTO_NO_EXISTE')

    if (actual.liquidacion_id) {
      throw new HttpError(409, 'GASTO_EN_LIQUIDACION', { liquidacion_id: actual.liquidacion_id })
    }

    const { error } = await sb
      .from('gastos_logistica')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return { success: true }
  },

  // ── Aprobar con separación de funciones ──────────────────────
  // Regla clave: el usuario que aprueba NO puede ser el que creó.
  // Sin excepción de admin — es la defensa principal contra fraude
  // interno (fraude #1 del security review).
  async aprobar(id: number, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    const { data: actual, error: e0 } = await sb
      .from('gastos_logistica')
      .select('id, estado, created_by')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (e0)     throw new HttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new HttpError(404, 'GASTO_NO_EXISTE')

    if (actual.estado !== 'pendiente') {
      throw new HttpError(409, 'GASTO_NO_PENDIENTE', { estado_actual: actual.estado })
    }
    if (actual.created_by === userId) {
      throw new HttpError(403, 'NO_PUEDE_AUTO_APROBAR', {
        message: 'No podés aprobar un gasto que vos mismo creaste. Otro usuario con permiso debe aprobarlo.',
      })
    }

    const { data, error } = await sb
      .from('gastos_logistica')
      .update({
        estado:       'aprobado',
        aprobado_por: userId,
        aprobado_at:  new Date().toISOString(),
        updated_by:   userId,
      })
      .eq('id', id)
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Rechazar (Fase 1: solo lo dejo en service; endpoint en Fase 2) ──
  async rechazar(id: number, dto: RechazarGastoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    const { data: actual, error: e0 } = await sb
      .from('gastos_logistica')
      .select('id, estado')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (e0)     throw new HttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new HttpError(404, 'GASTO_NO_EXISTE')
    if (actual.estado !== 'pendiente') {
      throw new HttpError(409, 'GASTO_NO_PENDIENTE', { estado_actual: actual.estado })
    }

    const { data, error } = await sb
      .from('gastos_logistica')
      .update({
        estado:         'rechazado',
        motivo_rechazo: dto.motivo_rechazo,
        aprobado_por:   userId,
        aprobado_at:    new Date().toISOString(),
        updated_by:     userId,
      })
      .eq('id', id)
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Reintegros pendientes (usado por el cierre de liquidación) ──
  async getReintegrosPendientes(choferId: number, hasta: string | undefined, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('gastos_logistica')
      .select('id, fecha, categoria_id, monto, descripcion, proveedor, comprobante_url, comprobante_nro, categoria:gastos_categorias(codigo,nombre)')
      .eq('chofer_id', choferId)
      .eq('pagado_por', 'chofer')
      .eq('estado', 'aprobado')
      .is('liquidacion_id', null)
      .is('deleted_at', null)
      .order('fecha', { ascending: true })
    if (hasta) q = q.lte('fecha', hasta)
    const { data, error } = await q
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    const total = (data ?? []).reduce((s, g) => s + Number(g.monto), 0)
    return { items: data ?? [], total, count: data?.length ?? 0 }
  },
}
