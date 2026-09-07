/**
 * Gastos del área de Áridos: combustible, gomería, taller, VTV, seguro.
 *
 * Es un clon RECORTADO de `gastos_logistica`, no una copia. Lo que se dejó
 * afuera a propósito y por qué:
 *
 *  - `estado` / aprobación / rechazo. En logística un gasto cargado por alguien
 *    que no es admin nace 'pendiente' y los reportes suman solo aprobado+pagado.
 *    Acá los carga Alina, que es quien tiene los comprobantes en la mano, y el
 *    dueño mira el resultado del mes. Con el workflow puesto, todo lo que
 *    cargue ella quedaría invisible en el resultado hasta que alguien apruebe
 *    de a uno — el reporte diría "ganamos" porque los gastos no se contaron.
 *  - `liquidacion_id` / `adelanto_id` / `pagado_por`. Los choferes de áridos
 *    cobran por día trabajado (ver `aridos-choferes.service.ts`), no tienen
 *    liquidación con reintegros de gastos.
 *
 * Lo que sí se clonó porque en logística demostró servir: el dedup de
 * comprobantes por sha256, el alta atómica gasto+carga, y los warnings de
 * odómetro persistidos en la fila.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'

const BUCKET = 'gastos-aridos'

export class GastoAridosError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'GastoAridosError'
  }
}

export interface CargaDto {
  litros:            number
  odometro_km?:      number | null
  tipo_combustible?: 'gasoil' | 'nafta'
  tanque_lleno?:     boolean
  obs?:              string | null
}

export interface CreateGastoAridosDto {
  fecha:            string
  categoria_id:     number
  unidad_id?:       number | null
  monto:            number
  descripcion?:     string | null
  proveedor?:       string | null
  metodo_pago?:     string | null
  comprobante_nro?: string | null
  /** Path devuelto por /gastos/upload-comprobante, ya subido al bucket. */
  comprobante_path?: string | null
  obs?:             string | null
  carga?:           CargaDto | null
}

export interface ListGastosAridosQuery {
  desde?:        string
  hasta?:        string
  mes?:          string        // YYYY-MM, atajo de desde/hasta
  unidad_id?:    number
  categoria_id?: number
  /** true = solo gastos sin camión asignado (del área). */
  sin_unidad?:   boolean
  limit?:        number
  offset?:       number
}

// Hoy en Argentina (UTC-3 fijo, sin horario de verano). Después de las 21:00 AR
// el "hoy" en UTC ya es mañana, así que un toISOString() pelado dejaría pasar
// fechas futuras que la categoría prohíbe.
function hoyAR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
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
  return `gastos/${yyyy}/${mm}/${randomUUID()}.${extFromMime(contentType)}`
}

/**
 * Baja el archivo recién subido, le saca el sha256 y verifica que no esté ya
 * cargado. Si está repetido borra el huérfano del bucket: sin eso, cada intento
 * fallido deja una foto que nadie va a limpiar nunca.
 */
async function procesarComprobante(
  path: string | null | undefined,
  excluirGastoId?: number,
): Promise<{ path: string; hash: string } | null> {
  if (!path) return null

  const dl = await supabase.storage.from(BUCKET).download(path)
  if (dl.error || !dl.data) {
    throw new GastoAridosError(400, 'COMPROBANTE_INEXISTENTE', { path, detail: dl.error?.message })
  }
  const hash = createHash('sha256')
    .update(Buffer.from(await dl.data.arrayBuffer()))
    .digest('hex')

  let q = supabase.from('aridos_gastos').select('id, fecha, monto')
    .eq('comprobante_hash', hash).is('deleted_at', null).limit(1)
  if (excluirGastoId != null) q = q.neq('id', excluirGastoId)
  const { data: dup, error } = await q
  if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)

  if (dup && dup.length > 0) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined)
    throw new GastoAridosError(409, 'COMPROBANTE_DUPLICADO', { gasto_existente: dup[0] })
  }
  return { path, hash }
}

/**
 * Heurísticas sobre el odómetro. No bloquean la carga: se guardan en la fila
 * para que el que lee el reporte sepa de cuál desconfiar. Descartar la carga
 * sería peor — el gasto existió igual y tiene que sumar.
 *
 * A diferencia de logística no hay cross-check contra tramos: los movimientos
 * de áridos no registran kilómetros. En su lugar se mira el consumo, que para
 * un camión cargado cae en una banda conocida.
 */
async function warningsDeOdometro(
  sb: ReturnType<typeof createSupabaseClient>,
  unidadId: number | null | undefined,
  carga: CargaDto,
  fecha: string,
): Promise<Array<{ code: string; detail?: unknown }>> {
  const warnings: Array<{ code: string; detail?: unknown }> = []
  if (unidadId == null || carga.odometro_km == null) return warnings

  const { data: ultima } = await sb
    .from('v_aridos_cargas_combustible')
    .select('odometro_km, fecha, litros')
    .eq('unidad_id', unidadId)
    .not('odometro_km', 'is', null)
    .lte('fecha', fecha)
    .order('fecha', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!ultima || ultima.odometro_km == null) return warnings

  const prev  = Number(ultima.odometro_km)
  const delta = carga.odometro_km - prev

  if (delta < 0) {
    warnings.push({ code: 'ODOMETRO_RETROCEDE', detail: { ultimo_km: prev, este_km: carga.odometro_km, fecha_ultimo: ultima.fecha } })
    return warnings
  }
  if (delta === 0) {
    warnings.push({ code: 'ODOMETRO_ESTANCADO', detail: { km: prev } })
    return warnings
  }

  // Consumo del tramo entre las dos cargas. Un camión volcador cargado anda
  // entre 1,5 y 4 km/l; fuera de esa banda o el odómetro o los litros están mal.
  const kmPorLitro = delta / Number(carga.litros)
  if (kmPorLitro > 6) {
    warnings.push({ code: 'CONSUMO_IMPROBABLE_BAJO', detail: { km_recorridos: delta, litros: carga.litros, km_por_litro: Number(kmPorLitro.toFixed(2)) } })
  } else if (kmPorLitro < 0.8) {
    warnings.push({ code: 'CONSUMO_IMPROBABLE_ALTO', detail: { km_recorridos: delta, litros: carga.litros, km_por_litro: Number(kmPorLitro.toFixed(2)) } })
  }
  return warnings
}

// El mensaje de una excepción de plpgsql viene como texto; estos son los
// códigos que levanta sp_aridos_gasto_con_carga.
function traducirErrorRpc(msg: string): GastoAridosError {
  for (const code of ['CATEGORIA_INVALIDA', 'CARGA_REQUERIDA', 'CARGA_NO_PERMITIDA', 'CATEGORIA_BLOQUEADA']) {
    if (msg.includes(code)) return new GastoAridosError(400, code, msg)
  }
  if (/comprobante_hash/i.test(msg) && /23505|unique/i.test(msg)) {
    return new GastoAridosError(409, 'COMPROBANTE_DUPLICADO', msg)
  }
  return new GastoAridosError(500, 'DB_ERROR', msg)
}

const SELECT_GASTO =
  '*, categoria:aridos_gastos_categorias(id,codigo,nombre,lleva_iva), ' +
  'unidad:aridos_unidades(id,nombre,patente), ' +
  'carga:aridos_cargas_combustible!aridos_cargas_combustible_gasto_id_fkey(litros,odometro_km,tipo_combustible,tanque_lleno,warnings,obs)'

export const gastosAridosService = {

  async categorias(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('aridos_gastos_categorias').select('*')
      .eq('activo', true).order('orden').order('nombre')
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    return data
  },

  async list(f: ListGastosAridosQuery, token: string) {
    const sb = createSupabaseClient(token)
    const limit  = Math.min(f.limit ?? 100, 500)
    const offset = f.offset ?? 0

    let q = sb.from('aridos_gastos').select(SELECT_GASTO, { count: 'exact' })
      .is('deleted_at', null)
      .order('fecha', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    // `mes` es un atajo para no obligar al frontend a calcular fin de mes.
    if (f.mes) {
      const [y, m] = f.mes.split('-').map(Number)
      const desde = `${f.mes}-01`
      const hasta = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10)
      q = q.gte('fecha', desde).lte('fecha', hasta)
    } else {
      if (f.desde) q = q.gte('fecha', f.desde)
      if (f.hasta) q = q.lte('fecha', f.hasta)
    }
    if (f.unidad_id)    q = q.eq('unidad_id', f.unidad_id)
    if (f.categoria_id) q = q.eq('categoria_id', f.categoria_id)
    if (f.sin_unidad)   q = q.is('unidad_id', null)

    const { data, error, count } = await q
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    return { data, total: count ?? 0, limit, offset }
  },

  async getById(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb.from('aridos_gastos').select(SELECT_GASTO)
      .eq('id', id).is('deleted_at', null).maybeSingle()
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    if (!data) throw new GastoAridosError(404, 'GASTO_NO_EXISTE')
    return data
  },

  async create(dto: CreateGastoAridosDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)

    const { data: cat, error: eCat } = await sb
      .from('aridos_gastos_categorias')
      .select('id, codigo, permite_fecha_futura')
      .eq('id', dto.categoria_id).maybeSingle()
    if (eCat) throw new GastoAridosError(500, 'DB_ERROR', eCat.message)
    if (!cat) throw new GastoAridosError(400, 'CATEGORIA_INVALIDA')

    // Un peaje o una gomería con fecha de mañana es siempre un error de tipeo:
    // son hechos consumados. Un seguro o una patente sí pueden ir adelantados.
    if (!cat.permite_fecha_futura && dto.fecha > hoyAR()) {
      throw new GastoAridosError(400, 'FECHA_FUTURA', { categoria: cat.codigo, hoy: hoyAR() })
    }

    const comp = await procesarComprobante(dto.comprobante_path)

    let carga: (CargaDto & { warnings: unknown[] }) | null = null
    if (dto.carga) {
      carga = {
        ...dto.carga,
        warnings: await warningsDeOdometro(sb, dto.unidad_id, dto.carga, dto.fecha),
      }
    }

    const { data, error } = await sb.rpc('sp_aridos_gasto_con_carga', {
      p_gasto: {
        fecha: dto.fecha, categoria_id: dto.categoria_id,
        unidad_id: dto.unidad_id ?? null, monto: dto.monto,
        descripcion: dto.descripcion ?? null, proveedor: dto.proveedor ?? null,
        metodo_pago: dto.metodo_pago ?? null, comprobante_nro: dto.comprobante_nro ?? null,
        comprobante_bucket: comp ? BUCKET : null,
        comprobante_path:   comp?.path ?? null,
        comprobante_hash:   comp?.hash ?? null,
        obs: dto.obs ?? null,
      },
      p_carga:   carga,
      p_user_id: userId,
    })
    if (error) {
      // El archivo ya está en el bucket pero el gasto no entró: sacarlo.
      if (comp) await supabase.storage.from(BUCKET).remove([comp.path]).catch(() => undefined)
      throw traducirErrorRpc(error.message)
    }
    return data
  },

  /**
   * Editar NO toca la carga de combustible ni la categoría de un gasto que ya
   * tiene litros: el trigger `trg_aridos_gasto_protege_categoria` lo rechaza.
   * Para corregir litros hay que borrar y volver a cargar, que deja rastro.
   */
  async update(id: number, dto: Partial<CreateGastoAridosDto>, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }

    for (const k of ['fecha', 'categoria_id', 'unidad_id', 'monto', 'descripcion',
                     'proveedor', 'metodo_pago', 'comprobante_nro', 'obs'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k]
    }

    if (dto.comprobante_path !== undefined) {
      if (dto.comprobante_path === null) {
        patch.comprobante_bucket = null
        patch.comprobante_path   = null
        patch.comprobante_hash   = null
      } else {
        const comp = await procesarComprobante(dto.comprobante_path, id)
        patch.comprobante_bucket = BUCKET
        patch.comprobante_path   = comp!.path
        patch.comprobante_hash   = comp!.hash
      }
    }

    const { data, error } = await sb.from('aridos_gastos')
      .update(patch).eq('id', id).is('deleted_at', null)
      .select(SELECT_GASTO).maybeSingle()
    if (error) throw traducirErrorRpc(error.message)
    if (!data) throw new GastoAridosError(404, 'GASTO_NO_EXISTE')
    return data
  },

  /** Borrado suave. El trigger arrastra la carga de combustible asociada. */
  async softDelete(id: number, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb.from('aridos_gastos')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id).is('deleted_at', null)
      .select('id').maybeSingle()
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    if (!data) throw new GastoAridosError(404, 'GASTO_NO_EXISTE')
    return { success: true, id: data.id }
  },

  // ── Comprobantes ────────────────────────────────────────────────────

  async firmarUpload(contentType: string) {
    const path = pathForUpload(contentType)
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error || !data) throw new GastoAridosError(500, 'STORAGE_ERROR', error?.message)
    return { path, signedUrl: data.signedUrl, token: data.token, expiresIn: 300 }
  },

  async comprobanteUrl(id: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: g, error } = await sb.from('aridos_gastos')
      .select('comprobante_path').eq('id', id).is('deleted_at', null).maybeSingle()
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    if (!g?.comprobante_path) throw new GastoAridosError(404, 'COMPROBANTE_NO_EXISTE')
    const { data, error: e2 } = await supabase.storage.from(BUCKET)
      .createSignedUrl(g.comprobante_path, 900)
    if (e2 || !data) throw new GastoAridosError(500, 'STORAGE_ERROR', e2?.message)
    return { signedUrl: data.signedUrl, expiresIn: 900 }
  },

  // ── Importación desde Excel ─────────────────────────────────────────

  /**
   * El dueño carga el combustible del mes pegando un Excel. Va como una sola
   * request y no como N altas sueltas: con doscientas cargas, N requests
   * significa que un corte de red a mitad de camino deja medio mes adentro y
   * medio afuera, sin forma de saber dónde quedó.
   *
   * Cada fila se resuelve sola: una que falla no arrastra a las demás y vuelve
   * con su motivo, así el que importa corrige esas y reintenta el archivo
   * entero — las ya cargadas salen marcadas como duplicadas, no repetidas.
   *
   * `dry_run` corre las mismas validaciones sin escribir nada. Es la previsual
   * del modal: sirve para ver cuántas entran antes de confirmar.
   */
  async importar(
    filas: CreateGastoAridosDto[],
    opts: { dry_run?: boolean },
    token: string,
    userId: string,
  ) {
    if (filas.length === 0)   throw new GastoAridosError(400, 'SIN_FILAS')
    if (filas.length > 500)   throw new GastoAridosError(400, 'DEMASIADAS_FILAS', { max: 500, recibidas: filas.length })

    const sb = createSupabaseClient(token)
    const dryRun = opts.dry_run === true

    // Un Excel se reimporta seguido (se corrigen tres filas y se vuelve a
    // subir entero). Sin este chequeo la segunda pasada duplica todo lo que ya
    // había entrado: el hash del comprobante no ayuda porque estas filas no
    // traen foto. La clave es fecha + categoría + monto + camión.
    const fechas = filas.map(f => f.fecha).sort()
    const { data: existentes, error: eDup } = await sb
      .from('aridos_gastos')
      .select('fecha, categoria_id, monto, unidad_id')
      .gte('fecha', fechas[0]!)
      .lte('fecha', fechas[fechas.length - 1]!)
      .is('deleted_at', null)
    if (eDup) throw new GastoAridosError(500, 'DB_ERROR', eDup.message)

    const clave = (f: { fecha: string; categoria_id: number; monto: number | string; unidad_id?: number | null }) =>
      `${f.fecha}|${f.categoria_id}|${Number(f.monto).toFixed(2)}|${f.unidad_id ?? ''}`
    const yaCargados = new Set((existentes ?? []).map(clave))

    const resultados: Array<{
      n: number; estado: 'ok' | 'duplicado' | 'error'
      gasto_id?: number; code?: string; detail?: unknown
      warnings?: unknown[]
    }> = []

    for (let i = 0; i < filas.length; i++) {
      const fila = filas[i]!
      const n = i + 1
      const k = clave(fila)

      // También contra las filas anteriores del MISMO archivo: un Excel con la
      // misma carga repetida dos veces entra una sola vez.
      if (yaCargados.has(k)) {
        resultados.push({ n, estado: 'duplicado' })
        continue
      }

      if (dryRun) {
        try {
          await this.validarFila(fila, sb)
          yaCargados.add(k)
          resultados.push({ n, estado: 'ok' })
        } catch (err) {
          const e = err as GastoAridosError
          resultados.push({ n, estado: 'error', code: e.code ?? 'ERROR', detail: e.detail })
        }
        continue
      }

      try {
        const creado = await this.create(fila, token, userId) as any
        yaCargados.add(k)
        resultados.push({
          n, estado: 'ok',
          gasto_id: creado?.gasto?.id,
          warnings: creado?.carga?.warnings ?? undefined,
        })
      } catch (err) {
        const e = err as GastoAridosError
        resultados.push({ n, estado: 'error', code: e.code ?? 'ERROR', detail: e.detail ?? (err as Error).message })
      }
    }

    return {
      dry_run:    dryRun,
      total:      filas.length,
      creados:    resultados.filter(r => r.estado === 'ok').length,
      duplicados: resultados.filter(r => r.estado === 'duplicado').length,
      errores:    resultados.filter(r => r.estado === 'error').length,
      resultados,
    }
  },

  /** Las validaciones de `create` sin escribir. Solo la usa el dry_run. */
  async validarFila(dto: CreateGastoAridosDto, sb: ReturnType<typeof createSupabaseClient>) {
    if (!dto.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(dto.fecha)) {
      throw new GastoAridosError(400, 'FECHA_INVALIDA', { fecha: dto.fecha })
    }
    if (!(Number(dto.monto) > 0)) {
      throw new GastoAridosError(400, 'MONTO_INVALIDO', { monto: dto.monto })
    }
    const { data: cat } = await sb.from('aridos_gastos_categorias')
      .select('id, codigo, permite_fecha_futura').eq('id', dto.categoria_id).maybeSingle()
    if (!cat) throw new GastoAridosError(400, 'CATEGORIA_INVALIDA', { categoria_id: dto.categoria_id })
    if (!cat.permite_fecha_futura && dto.fecha > hoyAR()) {
      throw new GastoAridosError(400, 'FECHA_FUTURA', { categoria: cat.codigo, hoy: hoyAR() })
    }
    if (cat.codigo === 'combustible' && !dto.carga) {
      throw new GastoAridosError(400, 'CARGA_REQUERIDA')
    }
    if (cat.codigo !== 'combustible' && dto.carga) {
      throw new GastoAridosError(400, 'CARGA_NO_PERMITIDA')
    }
    if (dto.carga && !(Number(dto.carga.litros) > 0)) {
      throw new GastoAridosError(400, 'LITROS_INVALIDOS', { litros: dto.carga.litros })
    }
    if (dto.unidad_id != null) {
      const { data: u } = await sb.from('aridos_unidades').select('id').eq('id', dto.unidad_id).maybeSingle()
      if (!u) throw new GastoAridosError(400, 'UNIDAD_INVALIDA', { unidad_id: dto.unidad_id })
    }
    return true
  },

  // ── Lecturas para el reporte ────────────────────────────────────────

  async cargasCombustible(token: string, unidadId?: number, desde?: string, hasta?: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_aridos_cargas_combustible').select('*').order('fecha', { ascending: false })
    if (unidadId) q = q.eq('unidad_id', unidadId)
    if (desde)    q = q.gte('fecha', desde)
    if (hasta)    q = q.lte('fecha', hasta)
    const { data, error } = await q
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    return data
  },

  /**
   * El número que el dueño quiere ver: ingresos menos material de cantera,
   * gastos y jornales, por camión. `mes` en YYYY-MM; sin mes devuelve todo.
   */
  async resultado(token: string, mes?: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_aridos_resultado_mes').select('*')
      .order('mes', { ascending: false }).order('unidad')
    if (mes) q = q.eq('mes', `${mes}-01`)
    const { data, error } = await q
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    return data
  },

  /** Desglose de gastos por categoría, para abrir el renglón "gastos". */
  async gastosPorCategoria(token: string, mes?: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_aridos_gastos_mes').select('*')
      .order('mes', { ascending: false }).order('total', { ascending: false })
    if (mes) q = q.eq('mes', `${mes}-01`)
    const { data, error } = await q
    if (error) throw new GastoAridosError(500, 'DB_ERROR', error.message)
    return data
  },
}
