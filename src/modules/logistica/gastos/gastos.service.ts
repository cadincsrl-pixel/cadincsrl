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
  // 'fecha' es financiero de facto: getReintegrosPendientes filtra por
  // fecha<=hasta, así que mover la fecha de un gasto chofer aprobado lo
  // mete/saca de la ventana de una liquidación. Inmutable una vez aprobado.
  'fecha',
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

// La tabla tiene UNIQUE partial sobre (comprobante_hash) WHERE deleted_at
// IS NULL. Si dos requests concurrentes pasan el pre-check SELECT y ambos
// intentan insertar, el segundo falla con SQLSTATE 23505. Este helper
// traduce ese error al COMPROBANTE_DUPLICADO limpio y borra el archivo
// huérfano del bucket.
async function handleCompHashViolation(
  error: { code?: string; message?: string },
  comprobantePath: string | null | undefined,
): Promise<never | void> {
  const is23505 = error.code === '23505' || /23505|unique_violation/i.test(error.message ?? '')
  const isHashCollision = /comprobante_hash/i.test(error.message ?? '')
  if (!is23505 || !isHashCollision) return  // no es el caso, caller continúa

  // Cleanup del huérfano (igual que en procesarComprobante).
  if (comprobantePath) {
    await supabase.storage.from(BUCKET).remove([comprobantePath]).catch(() => undefined)
  }
  throw new HttpError(409, 'COMPROBANTE_DUPLICADO', {
    message: 'Ya existe un gasto con este comprobante (detectado por hash en el INSERT).',
  })
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

// Heurísticas de detección de odómetro sospechoso. Devuelven warnings
// que se persisten en cargas_combustible.warnings (jsonb).
async function detectarWarningsOdometro(
  sb: ReturnType<typeof createSupabaseClient>,
  camionId: number,
  odometroNuevo: number,
  fecha: string,
  warnings: Array<{ code: string; detail?: unknown }>,
) {
  // Última carga del camión con odómetro registrado.
  const { data: ultima } = await sb
    .from('v_cargas_combustible')
    .select('odometro_km, fecha')
    .eq('camion_id', camionId)
    .not('odometro_km', 'is', null)
    .lte('fecha', fecha)
    .order('fecha', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!ultima || ultima.odometro_km == null) return

  const prev = Number(ultima.odometro_km)
  const delta = odometroNuevo - prev

  // Retroceso o estancado.
  if (delta < 0) {
    warnings.push({
      code: 'ODOMETRO_RETROCEDE',
      detail: { ultimo_km: prev, este_km: odometroNuevo, fecha_ultimo: ultima.fecha },
    })
    return
  }
  if (delta === 0) {
    warnings.push({ code: 'ODOMETRO_ESTANCADO', detail: { km: prev } })
    return
  }

  // Cross-check contra tramos: sumar km_ida_vuelta entre fecha_ultimo y fecha.
  const { data: tramos } = await sb
    .from('tramos')
    .select('cantera_id, deposito_id')
    .eq('camion_id', camionId)
    .gt('fecha_operacion', ultima.fecha)
    .lte('fecha_operacion', fecha)

  if (tramos && tramos.length > 0) {
    const canteraIds  = [...new Set(tramos.map((t: any) => t.cantera_id).filter(Boolean))]
    const depositoIds = [...new Set(tramos.map((t: any) => t.deposito_id).filter(Boolean))]
    if (canteraIds.length > 0 && depositoIds.length > 0) {
      // RPC para evitar el hard cap de PostgREST (1000 rows). La RPC
      // devuelve setof rutas completo; acá solo usamos 3 campos.
      const { data: rutas } = await sb
        .rpc('rutas_de_canteras_depositos', {
          p_canteras: canteraIds,
          p_depositos: depositoIds,
        })
      const rutaMap = new Map<string, number>()
      for (const r of (rutas ?? []) as any[]) {
        rutaMap.set(`${r.cantera_id}_${r.deposito_id}`, Number(r.km_ida_vuelta ?? 0))
      }
      const kmTramos = tramos.reduce((s: number, t: any) =>
        s + (rutaMap.get(`${t.cantera_id}_${t.deposito_id}`) ?? 0), 0)
      if (kmTramos > 0) {
        const discrepancia = Math.abs(delta - kmTramos) / kmTramos
        if (discrepancia > 0.3) {
          warnings.push({
            code: 'ODOMETRO_VS_TRAMOS_DISCREPANCIA',
            detail: {
              delta_odometro: delta,
              km_tramos: Math.round(kmTramos),
              discrepancia_pct: Math.round(discrepancia * 100),
              message: 'El km recorrido por odómetro difiere mucho de los km de tramos registrados.',
            },
          })
        }
      }
    }
  }
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
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)', { count: 'exact' })
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
    if (filters.liquidacion_id)      q = q.eq('liquidacion_id', filters.liquidacion_id)
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
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new HttpError(404, 'GASTO_NO_EXISTE')
    return data
  },

  // ── Crear gasto ──────────────────────────────────────────────
  // Admin auto-aprueba: los gastos creados por un usuario con rol='admin'
  // entran directo a 'aprobado' (caso típico en PYMEs donde el admin es
  // el único que carga gastos). Operadores siguen entrando a 'pendiente'
  // y requieren que OTRO usuario los apruebe (separación de funciones).
  //
  // Si categoría = 'combustible' y viene carga_combustible, usamos la RPC
  // sp_crear_gasto_con_carga para que ambos inserts sean atómicos.
  async create(dto: CreateGastoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    // Procesar comprobante si viene en el body (ya está en el bucket desde
    // /upload-comprobante). Calcula hash + valida duplicados.
    const comp = await procesarComprobante(dto.comprobante_path ?? null)

    // Chequear rol del usuario para decidir estado inicial.
    const { data: profile } = await sb
      .from('profiles')
      .select('rol')
      .eq('id', userId)
      .maybeSingle()
    const esAdmin = profile?.rol === 'admin'

    // Resolver codigo de categoría para validación cruzada con carga de
    // combustible (RPC también valida, pero queremos feedback rápido sin
    // ir al RPC si es obvio).
    const { data: cat } = await sb
      .from('gastos_categorias')
      .select('codigo')
      .eq('id', dto.categoria_id)
      .maybeSingle()
    const esCombustible = cat?.codigo === 'combustible'

    if (esCombustible && !dto.carga_combustible) {
      throw new HttpError(400, 'CARGA_REQUERIDA', {
        message: 'Los gastos de combustible requieren litros. Completá la sección de carga.',
      })
    }
    if (!esCombustible && dto.carga_combustible) {
      throw new HttpError(400, 'CARGA_NO_PERMITIDA', {
        categoria_codigo: cat?.codigo,
        message: 'Solo los gastos de combustible admiten metadata de carga.',
      })
    }

    // Validación opcional contra capacidad del tanque del camión.
    if (esCombustible && dto.carga_combustible && dto.camion_id) {
      const { data: cam } = await sb
        .from('camiones')
        .select('capacidad_tanque_l')
        .eq('id', dto.camion_id)
        .maybeSingle()
      const cap = cam?.capacidad_tanque_l ? Number(cam.capacidad_tanque_l) : null
      if (cap && dto.carga_combustible.litros > cap * 1.05) {
        throw new HttpError(400, 'LITROS_EXCEDE_TANQUE', {
          litros: dto.carga_combustible.litros,
          capacidad_tanque: cap,
          message: `La carga supera en más del 5% la capacidad del tanque (${cap} L).`,
        })
      }
    }

    // Recolección de warnings no-bloqueantes antes del insert.
    const warnings: Array<{ code: string; detail?: unknown }> = []
    if (esCombustible && dto.carga_combustible?.odometro_km != null && dto.camion_id) {
      await detectarWarningsOdometro(sb, dto.camion_id, dto.carga_combustible.odometro_km, dto.fecha, warnings)
    }

    // Rama A — RPC atómica (combustible con carga)
    if (esCombustible && dto.carga_combustible) {
      const gastoPayload = {
        camion_id:        dto.camion_id ?? null,
        chofer_id:        dto.chofer_id ?? null,
        tramo_id:         dto.tramo_id ?? null,
        lugar_id:         dto.lugar_id ?? null,
        categoria_id:     dto.categoria_id,
        fecha:            dto.fecha,
        monto:            dto.monto,
        descripcion:      dto.descripcion ?? '',
        proveedor:        dto.proveedor ?? null,
        metodo_pago:      dto.metodo_pago ?? 'efectivo',
        pagado_por:       dto.pagado_por ?? 'empresa',
        comprobante_url:  comp?.url  ?? null,
        comprobante_hash: comp?.hash ?? null,
        comprobante_nro:  dto.comprobante_nro ?? '',
        obs:              dto.obs ?? '',
      }
      const cargaPayload = {
        litros:           dto.carga_combustible.litros,
        odometro_km:      dto.carga_combustible.odometro_km ?? null,
        tipo_combustible: dto.carga_combustible.tipo_combustible ?? 'gasoil',
        tanque_lleno:     dto.carga_combustible.tanque_lleno ?? true,
        warnings,
        obs:              dto.carga_combustible.obs ?? '',
      }

      const { data, error } = await sb.rpc('sp_crear_gasto_con_carga', {
        p_gasto:        gastoPayload,
        p_carga:        cargaPayload,
        p_user_id:      userId,
        p_auto_aprobar: esAdmin,
      })
      if (error) {
        // Race: otra request insertó el mismo hash entre pre-check y este RPC.
        await handleCompHashViolation(error, comp?.url ?? null)
        const msg = error.message || ''
        if (msg.includes('CARGA_REQUERIDA'))    throw new HttpError(400, 'CARGA_REQUERIDA', msg)
        if (msg.includes('CARGA_NO_PERMITIDA')) throw new HttpError(400, 'CARGA_NO_PERMITIDA', msg)
        if (msg.includes('CATEGORIA_INVALIDA')) throw new HttpError(400, 'CATEGORIA_INVALIDA', msg)
        throw new HttpError(500, 'DB_ERROR', msg)
      }
      // data es { gasto, carga_combustible }. Devolvemos el gasto con la
      // carga anidada + warnings para que el front muestre toasts amarillos.
      const response: Record<string, unknown> = { ...(data as any).gasto, carga_combustible: (data as any).carga_combustible }
      if (warnings.length > 0) response.warnings = warnings
      return response
    }

    // Rama B — insert simple (no-combustible)
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
      estado:          esAdmin ? 'aprobado' : 'pendiente',
      aprobado_por:    esAdmin ? userId : null,
      aprobado_at:     esAdmin ? new Date().toISOString() : null,
      created_by:      userId,
      updated_by:      userId,
    }

    const { data, error } = await sb
      .from('gastos_logistica')
      .insert(row)
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)')
      .single()
    if (error) {
      // Race: otra request insertó el mismo hash entre pre-check y este insert.
      await handleCompHashViolation(error, comp?.url ?? null)
      throw new HttpError(500, 'DB_ERROR', error.message)
    }
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
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)')
      .single()
    if (error) {
      // Race: otro gasto tomó este hash entre el pre-check y este update.
      // Limpieza solo si el comprobante es nuevo (no reutilizamos el path
      // anterior del mismo gasto).
      const nuevoPath = dto.comprobante_path ?? null
      await handleCompHashViolation(error, nuevoPath)
      throw new HttpError(500, 'DB_ERROR', error.message)
    }
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
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Marcar pagado ─────────────────────────────────────────────
  // Flujo: aprobado → pagado. Solo para pagado_por='empresa' (los gastos
  // del chofer se "pagan" al cerrarse la liquidación, eso vive en Fase 3).
  // Separación de funciones: el que creó no puede marcar pagado (defensa
  // simétrica al /aprobar).
  async marcarPagado(id: number, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    const { data: actual, error: e0 } = await sb
      .from('gastos_logistica')
      .select('id, estado, pagado_por, created_by, liquidacion_id')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (e0)     throw new HttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new HttpError(404, 'GASTO_NO_EXISTE')

    if (actual.estado !== 'aprobado') {
      throw new HttpError(409, 'GASTO_NO_APROBADO', { estado_actual: actual.estado })
    }
    if (actual.pagado_por !== 'empresa') {
      throw new HttpError(400, 'SOLO_EMPRESA_SE_PAGA', {
        message: 'Los gastos pagados por el chofer se reintegran al cerrar la liquidación, no se marcan como pagado aquí.',
      })
    }
    if (actual.created_by === userId) {
      throw new HttpError(403, 'NO_PUEDE_PAGAR_PROPIO', {
        message: 'No podés marcar pagado un gasto que vos mismo creaste.',
      })
    }

    const { data, error } = await sb
      .from('gastos_logistica')
      .update({ estado: 'pagado', updated_by: userId })
      .eq('id', id)
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Rechazar ─────────────────────────────────────────────────
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
      .select('*, categoria:gastos_categorias(id,codigo,nombre,aplica_a), carga_combustible:cargas_combustible!cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)')
      .single()
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Reportes agregados ────────────────────────────────────────
  // Todos operan sobre gastos no eliminados del rango [desde, hasta].
  // Volumen PYME: agregación en JS es viable. Si crece, migrar a RPC.

  async reporteResumen(desde: string, hasta: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('gastos_logistica')
      .select('monto, estado, pagado_por, metodo_pago, liquidacion_id')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .is('deleted_at', null)
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    const rows = data ?? []
    const num  = (v: any) => Number(v ?? 0)
    // "Gastos del período" = erogación real: solo aprobado + pagado. Rechazado
    // nunca cuenta; pendiente se reporta aparte (pendientes_aprobacion) para no
    // inflar la erogación con montos no confirmados. Las tablas por categoría/
    // camión/chofer usan el mismo criterio para que todo cuadre.
    const reales = rows.filter(g => g.estado === 'aprobado' || g.estado === 'pagado')
    const total = reales.reduce((s, g) => s + num(g.monto), 0)
    const count = reales.length

    const groupBy = (key: string) => {
      const out: Record<string, { total: number; count: number }> = {}
      for (const g of reales) {
        const k = String((g as any)[key])
        if (!out[k]) out[k] = { total: 0, count: 0 }
        out[k].total += num(g.monto)
        out[k].count += 1
      }
      return out
    }

    const reintegros_pendientes = rows
      .filter(g => g.pagado_por === 'chofer' && g.estado === 'aprobado' && !g.liquidacion_id)
      .reduce((s, g) => s + num(g.monto), 0)

    const pendientes_aprobacion = rows
      .filter(g => g.estado === 'pendiente')
      .reduce((s, g) => s + num(g.monto), 0)

    return {
      total,
      count,
      promedio:               count > 0 ? total / count : 0,
      reintegros_pendientes,
      pendientes_aprobacion,
      por_estado:      groupBy('estado'),
      por_pagado_por:  groupBy('pagado_por'),
      por_metodo_pago: groupBy('metodo_pago'),
    }
  },

  async reportePorCamion(desde: string, hasta: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('gastos_logistica')
      .select('monto, camion_id, categoria:gastos_categorias(id,codigo,nombre), camion:camiones(id,patente)')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .is('deleted_at', null)
      .in('estado', ['aprobado', 'pagado'])
      .not('camion_id', 'is', null)
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    const map = new Map<number, { camion_id: number; patente: string; total: number; count: number; por_categoria: Record<string, number> }>()
    for (const g of (data ?? []) as any[]) {
      const id = g.camion_id as number
      if (!map.has(id)) {
        map.set(id, { camion_id: id, patente: g.camion?.patente ?? `#${id}`, total: 0, count: 0, por_categoria: {} })
      }
      const row = map.get(id)!
      const monto = Number(g.monto ?? 0)
      row.total += monto
      row.count += 1
      const cat = g.categoria?.codigo ?? 'desconocida'
      row.por_categoria[cat] = (row.por_categoria[cat] ?? 0) + monto
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  },

  async reportePorChofer(desde: string, hasta: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('gastos_logistica')
      .select('monto, chofer_id, pagado_por, liquidacion_id, estado, categoria:gastos_categorias(id,codigo,nombre), chofer:choferes(id,nombre)')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .is('deleted_at', null)
      .in('estado', ['aprobado', 'pagado'])
      .not('chofer_id', 'is', null)
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    const map = new Map<number, { chofer_id: number; nombre: string; total: number; count: number; reintegros_pendientes: number; por_categoria: Record<string, number> }>()
    for (const g of (data ?? []) as any[]) {
      const id = g.chofer_id as number
      if (!map.has(id)) {
        map.set(id, { chofer_id: id, nombre: g.chofer?.nombre ?? `#${id}`, total: 0, count: 0, reintegros_pendientes: 0, por_categoria: {} })
      }
      const row = map.get(id)!
      const monto = Number(g.monto ?? 0)
      row.total += monto
      row.count += 1
      if (g.pagado_por === 'chofer' && g.estado === 'aprobado' && !g.liquidacion_id) {
        row.reintegros_pendientes += monto
      }
      const cat = g.categoria?.codigo ?? 'desconocida'
      row.por_categoria[cat] = (row.por_categoria[cat] ?? 0) + monto
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  },

  async reportePorCategoria(desde: string, hasta: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('gastos_logistica')
      .select('monto, categoria_id, categoria:gastos_categorias(id,codigo,nombre,orden)')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .is('deleted_at', null)
      .in('estado', ['aprobado', 'pagado'])
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    const rows = (data ?? []) as any[]
    const totalGeneral = rows.reduce((s, g) => s + Number(g.monto ?? 0), 0)

    const map = new Map<number, { categoria_id: number; codigo: string; nombre: string; orden: number; total: number; count: number; pct: number }>()
    for (const g of rows) {
      const id = g.categoria_id as number
      if (!map.has(id)) {
        map.set(id, {
          categoria_id: id,
          codigo:  g.categoria?.codigo  ?? `#${id}`,
          nombre:  g.categoria?.nombre  ?? `#${id}`,
          orden:   g.categoria?.orden   ?? 0,
          total: 0, count: 0, pct: 0,
        })
      }
      const row = map.get(id)!
      row.total += Number(g.monto ?? 0)
      row.count += 1
    }
    for (const row of map.values()) {
      row.pct = totalGeneral > 0 ? (row.total / totalGeneral) * 100 : 0
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  },

  // ── Reintegros pendientes (usado por el cierre de liquidación) ──
  async getReintegrosPendientes(choferId: number | null, hasta: string | undefined, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('gastos_logistica')
      .select('id, chofer_id, fecha, categoria_id, monto, descripcion, proveedor, comprobante_url, comprobante_nro, categoria:gastos_categorias(codigo,nombre)')
      .eq('pagado_por', 'chofer')
      .eq('estado', 'aprobado')
      .is('liquidacion_id', null)
      .is('deleted_at', null)
      .order('fecha', { ascending: true })
    if (choferId) q = q.eq('chofer_id', choferId)
    if (hasta) q = q.lte('fecha', hasta)
    const { data, error } = await q
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    const total = (data ?? []).reduce((s, g) => s + Number(g.monto), 0)
    return { items: data ?? [], total, count: data?.length ?? 0 }
  },
}
