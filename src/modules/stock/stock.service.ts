import type { PostgrestError } from '@supabase/supabase-js'
import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'

export interface MaterialCompra {
  material_id: number; item_id: number; solicitud_id: number; obra_cod: string; obra_nom: string | null
  descripcion: string; color: string | null; cantidad: number; unidad: string; precio_unit: number
  proveedor_id: number | null; proveedor_nombre: string | null; fecha: string | null; pagado_por: string
  factura_id: number | null; factura_numero: string | null; estado: string
}
export interface MaterialCompraProveedor {
  proveedor_id: number | null; proveedor: string; ultimo_precio: number; ultima_fecha: string | null
  compras: number; minimo: number; maximo: number
}
export interface MaterialComprasResumen { compras: MaterialCompra[]; por_proveedor: MaterialCompraProveedor[] }
import type { CreateRubroDto, UpdateRubroDto, CreateMaterialDto, UpdateMaterialDto, CreateMovimientoDto } from './stock.schema.js'
import { puedeActualizarCatalogo } from '../../middleware/permission.js'

/** Estados de precio que calcula `v_catalogo_materiales` (20260904z), más 'sin_precio' como agrupador. */
export const CATALOGO_ESTADOS = ['sin_precio', 'tasar', 'desactualizado', 'al_dia', 'sin_compra', 'unidad_distinta'] as const
export type CatalogoEstado = typeof CATALOGO_ESTADOS[number]

// ─────────────────────────────────────────────────────────────────────────
// Error tipado del módulo
// ─────────────────────────────────────────────────────────────────────────
// Las rutas lo desarman en `{ error, code, ...extra }`. Cualquier otro Error
// cae al onError global (500).
export type MaterialPrecioHist = {
  id: number; precio: number; unidad: string | null; desde: string
  fuente: 'manual' | 'compra' | 'ultima_compra' | 'migracion' | 'sql' | 'backfill'
  item_id: number | null; user_id: string | null; obs: string | null
  usuario: string | null; variacion_pct: number | null
}

export class StockHttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'StockHttpError'
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Búsqueda difusa de materiales (anti-duplicados + "¿no será este?")
// ─────────────────────────────────────────────────────────────────────────
//
// Espejo en TypeScript de lo que hace Postgres:
//   `public.norm_material(text)`  (migración 20260902c) y `similarity()` de
//   pg_trgm. Se replica acá en vez de hacer una RPC porque el catálogo son
//   ~718 filas activas: traerlas y comparar en memoria cuesta menos que
//   mantener una función más en la base, y el alta de materiales es una
//   operación poco frecuente.
//
// Si el catálogo crece a decenas de miles de filas, esto debería pasar a una
// RPC que use el índice GIN de trigramas (`stock_materiales_nombre_trgm`).

/** Minúsculas, sin tildes ni ñ, espacios colapsados. Igual que `public.norm_material`. */
export function normMaterial(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // saca los diacriticos (á -> a, ñ -> n)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Trigramas al estilo pg_trgm: se parte en palabras por caracteres no
 * alfanuméricos y cada palabra se rellena con 2 espacios adelante y 1 atrás
 * antes de cortar las ventanas de 3.
 *   "cat" → "  c", " ca", "cat", "at "
 */
export function trigramas(texto: string): Set<string> {
  const out = new Set<string>()
  // \p{Nd} y no \p{N}: pg_trgm no considera dígito a los superíndices
  // ("1.5mm²" corta la palabra antes del ²), verificado contra show_trgm().
  for (const palabra of normMaterial(texto).split(/[^\p{L}\p{Nd}]+/u)) {
    if (!palabra) continue
    const relleno = `  ${palabra} `
    for (let i = 0; i + 3 <= relleno.length; i++) out.add(relleno.slice(i, i + 3))
  }
  return out
}

/** Jaccard sobre trigramas — mismo número que `similarity()` de pg_trgm. */
export function similitud(a: string, b: string): number {
  const ta = trigramas(a)
  const tb = trigramas(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return comunes / (ta.size + tb.size - comunes)
}

/**
 * Por qué un material aparece como "¿no será este?" (de más fuerte a más débil):
 *   alias    → el nombre buscado ES uno de sus sinónimos.
 *   codigo   → comparten un código de proveedor ("cod7055" ↔ alias "cod 7055").
 *   nombre   → los nombres se parecen por trigramas (> UMBRAL_PARECIDO).
 *   palabras → comparten las palabras con contenido ("pintura de latex blanca"
 *              ↔ "Latex interior x 20lts" + alias "pintura latex").
 */
export type MotivoParecido = 'alias' | 'codigo' | 'nombre' | 'palabras'

export type MaterialCandidato = {
  id: number
  nombre: string
  unidad: string | null
  /** Similitud por trigramas contra el nombre (0..1). */
  sim: number
  /** true si el nombre buscado coincide EXACTO con uno de sus alias. */
  por_alias: boolean
  /** true si comparten un código de proveedor (ver `formasCodigo`). */
  por_codigo: boolean
  /** Qué parte de las palabras con contenido del buscado aparece en nombre+alias (0..1). */
  palabras: number
  /**
   * Qué parte del NOMBRE del candidato son esas palabras (0..1). Ordena entre
   * los que comparten palabras: "Latex interior x 20lts" (2 de 3) va antes que
   * "Pintura p/ pisos Alba látex acrílico mate grafito x 20lts" (2 de 8).
   */
  precision: number
  motivo: MotivoParecido
}

// Conectores y palabras que no dicen QUÉ es el material. No cuentan como
// coincidencia entre nombres ni como "palabra" al decidir si un nombre es
// solo un código.
const PALABRAS_VACIAS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'a', 'con', 'sin', 'para', 'por', 'x',
  'cod', 'codigo', 'cdg', 'art', 'articulo', 'ref', 'referencia', 'nro', 'num', 'numero', 'n', 'no',
  'sku', 'item', 'mod', 'modelo', 'marca',
])

function partirEnTokens(texto: string): string[] {
  return normMaterial(texto).split(/[^\p{L}\p{Nd}]+/u).filter(Boolean)
}

/**
 * Palabras con contenido de un nombre: 3+ letras o con dígitos ("4l", "40mm"),
 * sin conectores ni "cod"/"art". Es lo que se compara para el motivo 'palabras'.
 */
export function tokensMaterial(texto: string): string[] {
  return partirEnTokens(texto).filter(t => !PALABRAS_VACIAS.has(t) && (t.length >= 3 || /\p{Nd}/u.test(t)))
}

/**
 * Formas en que puede aparecer un código de proveedor en un texto: cada token
 * y cada 2 o 3 tokens adyacentes pegados, si tienen 4+ dígitos. Así "cod7055",
 * "cod 7055" y "pintura cod 7055 x 4l" comparten la forma "cod7055" (y "7055"),
 * mientras que "5lts" o "1x25" no cuentan como código (son medidas).
 */
export function formasCodigo(texto: string): Set<string> {
  const toks = partirEnTokens(texto)
  const out = new Set<string>()
  for (let i = 0; i < toks.length; i++) {
    for (let largo = 1; largo <= 3 && i + largo <= toks.length; largo++) {
      const forma = toks.slice(i, i + largo).join('')
      if ((forma.match(/\p{Nd}/gu) ?? []).length >= 4) out.add(forma)
    }
  }
  return out
}

/**
 * true si el nombre no dice qué es el material: solo códigos, medidas o
 * conectores ("7055", "cod 7055", "SW 7005", "EZ9F34125", "3M 175"). Un
 * nombre así no se puede buscar ni cotizar; el código va como sinónimo.
 */
export function esNombreSoloCodigo(nombre: string): boolean {
  return !partirEnTokens(nombre).some(t => !PALABRAS_VACIAS.has(t) && /^\p{L}{3,}$/u.test(t))
}

type FilaMaterialLite = {
  id: number
  nombre: string
  unidad: string | null
  alias: string[] | null
}

const UMBRAL_PARECIDO = 0.45
/** Parte de las palabras con contenido del buscado que tienen que aparecer en nombre+alias. */
const UMBRAL_PALABRAS = 0.5
const MAX_CANDIDATOS  = 5
/** Orden de los candidatos: primero la señal más fuerte. */
const PESO_MOTIVO: Record<MotivoParecido, number> = { alias: 4, codigo: 3, nombre: 2, palabras: 1 }
const PAGINA          = 1000 // tope duro de PostgREST: paginamos, no pedimos de más

// ── Búsqueda para pedidos dictados al asistente ───────────────────────

/** Más candidatos que en el anti-duplicados: acá el que elige es una persona. */
const MAX_CANDIDATOS_PEDIDO = 8

export type ResolucionBusqueda = 'unico' | 'varios' | 'sin_resultados'

export type CandidatoPedido = {
  material_id: number
  nombre: string
  unidad: string | null
  clase: string
  rubro: string | null
  precio_ref: number
  usa_color: boolean
  stock_deposito: number
  motivo: MotivoParecido
  /** null si la persona no dijo unidad; false = dijo una y NO es la de la ficha. */
  coincide_unidad: boolean | null
}

export type ResultadoBusquedaPedido = {
  texto: string
  resolucion: ResolucionBusqueda
  candidatos: CandidatoPedido[]
}

/** Los puntajes con los que se ordena; se descartan antes de devolver. */
type CandidatoConPuntaje = CandidatoPedido & { _sim: number; _palabras: number; _precision: number }

type FilaMaterialPedido = FilaMaterialLite & {
  clase: string | null
  rubro_id: number | null
  precio_ref: number | null
  usa_color: boolean | null
  stock_actual: number | null
  stock_materiales_rubro_id_fkey: { nombre: string } | null
}

/**
 * La palabra de presentación que dijo la persona ("bolsas", "rollos", "litros")
 * llevada a la unidad del catálogo. Devuelve null si no se reconoce, que es lo
 * mismo que no haber dicho nada: no inventamos una unidad para poder comparar.
 */
const SINONIMOS_UNIDAD: Record<string, string> = {
  unidad: 'unid', unidades: 'unid', unid: 'unid', u: 'unid',
  kilo: 'kg', kilos: 'kg', kg: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  tonelada: 'tn', toneladas: 'tn', tn: 'tn',
  litro: 'lt', litros: 'lt', lt: 'lt', l: 'lt',
  metro: 'm', metros: 'm', m: 'm', ml: 'm',
  m2: 'm2', metrocuadrado: 'm2', metroscuadrados: 'm2',
  m3: 'm3', metrocubico: 'm3', metroscubicos: 'm3',
  galon: 'gl', galones: 'gl', gl: 'gl',
  rollo: 'rollo', rollos: 'rollo',
  bolsa: 'bolsa', bolsas: 'bolsa',
  balde: 'balde', baldes: 'balde',
  lata: 'lata', latas: 'lata',
}

export function unidadNormalizada(dicha: string | null | undefined): string | null {
  if (!dicha) return null
  const limpia = normMaterial(dicha).replace(/\s+/g, '')
  return SINONIMOS_UNIDAD[limpia] ?? null
}

/** Normaliza una lista de alias: normalizados, sin vacíos y sin repetidos. */
export function normalizarAlias(alias: readonly string[] | null | undefined): string[] {
  if (!alias) return []
  const vistos = new Set<string>()
  for (const a of alias) {
    const n = normMaterial(a)
    if (n) vistos.add(n)
  }
  return [...vistos]
}

/** ¿El error de Postgres es la violación del único parcial sobre el nombre? */
function esNombreDuplicado(error: PostgrestError): boolean {
  return error.code === '23505' && /nombre|unique/i.test(`${error.message} ${error.details ?? ''}`)
}

/**
 * 400 NOMBRE_ES_CODIGO. Sosa (depósito) dio de alta desde el pedido "pintura
 * cod7055 x 4l" y compañía: un catálogo con códigos de proveedor como nombre
 * no se puede buscar ni cotizar. El código va como sinónimo de la fila real.
 */
function exigirNombreConPalabras(nombre: string): void {
  if (!esNombreSoloCodigo(nombre)) return
  throw new StockHttpError(
    400,
    'NOMBRE_ES_CODIGO',
    `"${nombre}" es solo un código o una medida. Poné qué es el material (ej.: "Esmalte sintético x 4lts") y dejá el código como sinónimo.`,
  )
}

export const stockService = {

  // ── Rubros ──
  async getRubros(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_rubros')
      .select('*')
      .eq('activo', true)
      .order('orden')
    if (error) throw new Error(error.message)
    return data
  },

  async createRubro(dto: CreateRubroDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('stock_rubros').insert(dto).select().single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateRubro(id: number, dto: UpdateRubroDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('stock_rubros').update(dto).eq('id', id).select().single()
    if (error) throw new Error(error.message)
    return data
  },

  // ── Materiales ──
  //
  // Por defecto solo los activos: las bajas lógicas no deben aparecer en el
  // selector de la solicitud. `incluirInactivos` es para el ABM.
  async getMateriales(token: string, rubro_id?: number, incluirInactivos = false) {
    const supabase = createSupabaseClient(token)
    // PostgREST recorta cada respuesta a 1000 filas y el cliente no lo puede
    // subir (CLAUDE.md §5.7). El catálogo pasó esa marca el 2026-09-04 (1001
    // filas, 997 activas): sin paginar, el ABM y el selector de los pedidos
    // perdían filas en silencio. Se trae por páginas hasta que una venga corta.
    // `select('*')` ya trae `alias` (columna de la tabla desde 20260902c).
    const PAGE = 1000
    const out: Record<string, unknown>[] = []
    for (let from = 0; ; from += PAGE) {
      let q = supabase
        .from('stock_materiales')
        .select('*, stock_rubros(nombre, icono), proveedores(id, nombre)')
        .order('nombre')
        .order('id')
        .range(from, from + PAGE - 1)
      if (!incluirInactivos) q = q.eq('activo', true)
      if (rubro_id) q = q.eq('rubro_id', rubro_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      out.push(...(data ?? []))
      if (!data || data.length < PAGE) break
    }
    return out
  },

  /**
   * Catálogo de precios: pestaña aparte del Stock (2026-09-04). Lee
   * `v_catalogo_materiales` (20260904v): rubro, precio de referencia con su
   * fecha, y la última compra real del material (precio, proveedor, fecha,
   * pedido). Paginado en el server por el mismo techo de 1000 filas. La
   * búsqueda va sobre `busq` = nombre + sinónimos + rubro normalizados con
   * `norm_txt()`, así que acá se normaliza igual y cada palabra tiene que estar.
   */
  async getCatalogo(
    token: string,
    f: { q?: string; rubro_id?: number; incluir_inactivos?: boolean; estado?: CatalogoEstado; limit: number; offset: number },
  ) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('v_catalogo_materiales')
      .select('*', { count: 'exact' })
    if (!f.incluir_inactivos) q = q.eq('activo', true)
    if (f.rubro_id) q = q.eq('rubro_id', f.rubro_id)
    // 'sin_precio' es "todo lo que no tiene precio" (con o sin compra); los
    // demás son el estado exacto que calcula la vista (20260904z).
    if (f.estado === 'sin_precio') q = q.eq('precio_ref', 0)
    else if (f.estado) q = q.eq('estado_precio', f.estado)
    for (const w of normTxt(f.q ?? '').split(' ').filter(Boolean)) q = q.ilike('busq', `%${w}%`)
    // Los desactualizados, del que más difiere al que menos: es la lista de
    // trabajo. El resto, alfabético.
    q = f.estado === 'desactualizado'
      ? q.order('dif_pct', { ascending: false, nullsFirst: false }).order('nombre')
      : q.order('nombre').order('id')
    const { data, error, count } = await q.range(f.offset, f.offset + f.limit - 1)
    if (error) throw new Error(error.message)
    return { items: data ?? [], total: count ?? 0 }
  },

  /**
   * Cuántos materiales activos hay en cada estado de precio, para los chips
   * del filtro. Un count con `head: true` por estado: son 5 requests
   * livianos, y evita traer las ~1000 filas (cap de PostgREST) para contarlas.
   */
  async getCatalogoStats(token: string) {
    const supabase = createSupabaseClient(token)
    const contar = async (estado?: CatalogoEstado) => {
      let q = supabase.from('v_catalogo_materiales').select('id', { count: 'exact', head: true }).eq('activo', true)
      if (estado === 'sin_precio') q = q.eq('precio_ref', 0)
      else if (estado) q = q.eq('estado_precio', estado)
      const { count, error } = await q
      if (error) throw new Error(error.message)
      return count ?? 0
    }
    const [total, sin_precio, tasar, desactualizado, al_dia, unidad_distinta] = await Promise.all([
      contar(), contar('sin_precio'), contar('tasar'), contar('desactualizado'), contar('al_dia'), contar('unidad_distinta'),
    ])
    return { total, sin_precio, tasar, desactualizado, al_dia, unidad_distinta }
  },

  /**
   * Historial de compras de un material (v_material_compras, 20260906f): una
   * fila por compra real, de la más nueva a la más vieja, y el resumen por
   * proveedor (último precio, cuántas veces, mínimo y máximo). Es lo que le
   * falta al catálogo: `precio_ref` es uno solo y la vista de última compra
   * solo muestra la más reciente.
   */
  async getMaterialCompras(materialId: number, token: string): Promise<MaterialComprasResumen> {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('v_material_compras')
      .select('*')
      .eq('material_id', materialId)
      .order('fecha', { ascending: false, nullsFirst: false })
      .order('item_id', { ascending: false })
      .limit(300)
    if (error) throw new Error(error.message)
    const compras = (data ?? []) as MaterialCompra[]

    const porProv = new Map<string, MaterialCompraProveedor>()
    for (const c of compras) {
      const nombre = c.proveedor_nombre ?? 'Sin proveedor'
      const cur = porProv.get(nombre)
      const precio = Number(c.precio_unit)
      if (!cur) {
        porProv.set(nombre, { proveedor_id: c.proveedor_id, proveedor: nombre, ultimo_precio: precio, ultima_fecha: c.fecha, compras: 1, minimo: precio, maximo: precio })
      } else {
        cur.compras += 1
        cur.minimo = Math.min(cur.minimo, precio)
        cur.maximo = Math.max(cur.maximo, precio)
      }
    }
    const por_proveedor = [...porProv.values()].sort((a, b) => (b.ultima_fecha ?? '').localeCompare(a.ultima_fecha ?? ''))
    return { compras, por_proveedor }
  },

  /** Historial de precio_ref (20260911a), del mas nuevo al mas viejo, con variacion contra el anterior. */
  async getMaterialPrecios(materialId: number, token: string): Promise<MaterialPrecioHist[]> {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_materiales_precios')
      .select('id, precio, unidad, desde, fuente, item_id, user_id, obs')
      .eq('material_id', materialId)
      .order('desde', { ascending: false })
      .order('id', { ascending: false })
      .limit(200)
    if (error) throw new Error(error.message)
    const filas = (data ?? []) as Omit<MaterialPrecioHist, 'usuario' | 'variacion_pct'>[]

    // Quien lo cambio: sin embed (profiles no tiene FK desde aca; ver memoria
    // "embed profiles vs auth.users"), una consulta aparte por ids.
    const ids = [...new Set(filas.map(f => f.user_id).filter((x): x is string => !!x))]
    const nombres = new Map<string, string>()
    if (ids.length) {
      const { data: perfiles } = await supabaseAdmin.from('profiles').select('id, nombre').in('id', ids)
      for (const p of (perfiles ?? []) as { id: string; nombre: string }[]) nombres.set(p.id, p.nombre)
    }
    return filas.map((f, i) => {
      const prev = filas[i + 1]
      const variacion_pct = prev && Number(prev.precio) > 0
        ? Math.round((Number(f.precio) - Number(prev.precio)) / Number(prev.precio) * 1000) / 10
        : null
      return { ...f, usuario: f.user_id ? (nombres.get(f.user_id) ?? null) : null, variacion_pct }
    })
  },

  /**
   * Materiales activos parecidos a `nombre`, para el "¿no será este?" del alta
   * (el 409 del candado y la lista en vivo del modal del pedido). Cuatro
   * señales, ver `MotivoParecido`: alias exacto, código de proveedor
   * compartido, trigramas > 0.45 contra el nombre, y palabras con contenido
   * compartidas (al menos 2, o 1 si el buscado tiene una sola). Las dos
   * últimas se sumaron el 2026-09-07: con trigramas solos, "pintura de latex
   * blanca" daba 0.18 contra "Latex interior x 20lts" y el candado no saltaba.
   */
  async buscarParecidos(nombre: string, token: string, excluirId?: number): Promise<MaterialCandidato[]> {
    const supabase = createSupabaseClient(token)
    const buscado  = normMaterial(nombre)
    if (!buscado) return []
    const palabrasBuscadas = tokensMaterial(buscado)
    const codigosBuscados  = formasCodigo(buscado)
    const minimoPalabras   = Math.min(2, palabrasBuscadas.length)

    const filas: FilaMaterialLite[] = []
    // Paginado explícito: PostgREST corta en 1000 filas por response y el
    // catálogo puede pasar ese número.
    for (let desde = 0; desde < PAGINA * 20; desde += PAGINA) {
      const { data, error } = await supabase
        .from('stock_materiales')
        .select('id, nombre, unidad, alias')
        .eq('activo', true)
        .order('id')
        .range(desde, desde + PAGINA - 1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) break
      filas.push(...(data as FilaMaterialLite[]))
      if (data.length < PAGINA) break
    }

    const candidatos: MaterialCandidato[] = []
    for (const f of filas) {
      if (f.id === excluirId) continue
      const alias = f.alias ?? []
      const blob  = normMaterial(`${f.nombre} ${alias.join(' ')}`)
      const coinciden = palabrasBuscadas.filter(t => blob.includes(t)).length
      const palabras  = palabrasBuscadas.length ? coinciden / palabrasBuscadas.length : 0
      const precision = Math.min(1, coinciden / Math.max(1, tokensMaterial(f.nombre).length))
      const sim       = Math.round(similitud(buscado, f.nombre) * 1000) / 1000
      const por_alias = alias.some(a => normMaterial(a) === buscado)
      const por_codigo = codigosBuscados.size > 0 &&
        [f.nombre, ...alias].some(t => [...formasCodigo(t)].some(c => codigosBuscados.has(c)))

      const motivo: MotivoParecido | null =
        por_alias ? 'alias'
        : por_codigo ? 'codigo'
        : sim > UMBRAL_PARECIDO ? 'nombre'
        : (coinciden >= minimoPalabras && palabras >= UMBRAL_PALABRAS) ? 'palabras'
        : null
      if (!motivo) continue
      candidatos.push({
        id: f.id, nombre: f.nombre, unidad: f.unidad,
        sim, por_alias, por_codigo,
        palabras: Math.round(palabras * 100) / 100, precision: Math.round(precision * 100) / 100, motivo,
      })
    }

    // Los que se parecen por nombre van por similitud; los que solo comparten
    // palabras, por cuántas comparten y qué tan "limpio" es el nombre del
    // candidato (así la fila genérica de la familia gana a la de un modelo).
    return candidatos
      .sort((a, b) =>
        PESO_MOTIVO[b.motivo] - PESO_MOTIVO[a.motivo]
        || (a.motivo === 'palabras' ? (b.palabras - a.palabras || b.precision - a.precision) : 0)
        || b.sim - a.sim
        || a.nombre.length - b.nombre.length)
      .slice(0, MAX_CANDIDATOS)
  },

  /**
   * Resuelve varios materiales dictados contra el catálogo, de una sola vez.
   *
   * Lo usa el asistente cuando alguien le dicta un pedido ("20 bolsas de
   * cemento, 3 rollos de alambre y una masa"). Se diferencia de
   * `buscarParecidos` en tres cosas, y por eso es una función aparte en vez de
   * un parámetro más:
   *
   *   1. Es BATCH y baja el catálogo UNA vez. `buscarParecidos` lo pagina
   *      entero en cada llamada, y envolverla en un bucle serían 6 descargas
   *      del catálogo por pedido, adentro de un chat que ya tarda.
   *   2. Devuelve lo que hace falta para DECIDIR, no solo para avisar de un
   *      duplicado: unidad, clase, rubro, precio y si el material admite color.
   *      Sin la unidad y el precio a la vista, el asistente no puede preguntar
   *      "¿Portland o plasticor?" con los datos que hacen elegir.
   *   3. Marca `coincide_unidad` contra la palabra de presentación que dijo la
   *      persona ("bolsas", "rollos"). Cuando no coincide hay que preguntar, no
   *      convertir: es el error que deja el precio mal por un factor de 20.
   *
   * NUNCA elige por su cuenta. Si un texto da más de un candidato, devuelve la
   * lista y que pregunte quien sabe. 111 alias del catálogo apuntan a más de una
   * ficha a propósito (los 6 colores de cable, los 5 largos de chapa).
   */
  async buscarParaPedido(
    consultas: { texto: string; unidad_dicha?: string | null; solo_herramientas?: boolean }[],
    token: string,
  ): Promise<ResultadoBusquedaPedido[]> {
    const supabase = createSupabaseClient(token)

    // El catálogo entero, UNA vez, para todos los términos.
    const filas: FilaMaterialPedido[] = []
    for (let desde = 0; desde < PAGINA * 20; desde += PAGINA) {
      const { data, error } = await supabase
        .from('stock_materiales')
        .select('id, nombre, unidad, alias, clase, rubro_id, precio_ref, usa_color, stock_actual, stock_materiales_rubro_id_fkey:stock_rubros(nombre)')
        .eq('activo', true)
        .order('id')
        .range(desde, desde + PAGINA - 1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) break
      filas.push(...(data as unknown as FilaMaterialPedido[]))
      if (data.length < PAGINA) break
    }

    // Precalculado una sola vez por ficha, no por término.
    const preparadas = filas.map(f => ({
      fila:    f,
      blob:    normMaterial(`${f.nombre} ${(f.alias ?? []).join(' ')}`),
      tokens:  tokensMaterial(f.nombre).length,
      alias:   (f.alias ?? []).map(a => normMaterial(a)),
      codigos: [f.nombre, ...(f.alias ?? [])].flatMap(t => [...formasCodigo(t)]),
    }))

    return consultas.map(({ texto, unidad_dicha, solo_herramientas }) => {
      const buscado = normMaterial(texto)
      if (!buscado) return { texto, resolucion: 'sin_resultados' as const, candidatos: [] }

      const palabrasBuscadas = tokensMaterial(buscado)
      const codigosBuscados  = formasCodigo(buscado)
      const minimoPalabras   = Math.min(2, palabrasBuscadas.length)
      const unidadDicha      = unidadNormalizada(unidad_dicha)

      const encontrados: CandidatoConPuntaje[] = []
      for (const p of preparadas) {
        const f = p.fila
        if (solo_herramientas && f.clase !== 'herramienta') continue
        const coinciden = palabrasBuscadas.filter(t => p.blob.includes(t)).length
        const palabras  = palabrasBuscadas.length ? coinciden / palabrasBuscadas.length : 0
        const precision = Math.min(1, coinciden / Math.max(1, p.tokens))
        const sim       = Math.round(similitud(buscado, f.nombre) * 1000) / 1000
        const porAlias  = p.alias.includes(buscado)
        const porCodigo = codigosBuscados.size > 0 && p.codigos.some(c => codigosBuscados.has(c))

        const motivo: MotivoParecido | null =
          porAlias ? 'alias'
          : porCodigo ? 'codigo'
          : sim > UMBRAL_PARECIDO ? 'nombre'
          : (coinciden >= minimoPalabras && palabras >= UMBRAL_PALABRAS) ? 'palabras'
          : null
        if (!motivo) continue

        encontrados.push({
          material_id: f.id,
          nombre:      f.nombre,
          unidad:      f.unidad,
          clase:       f.clase ?? 'material',
          rubro:       f.stock_materiales_rubro_id_fkey?.nombre ?? null,
          precio_ref:  Number(f.precio_ref ?? 0),
          usa_color:   !!f.usa_color,
          stock_deposito: Number(f.stock_actual ?? 0),
          motivo,
          coincide_unidad: unidadDicha === null ? null : unidadDicha === f.unidad,
          _sim: sim, _palabras: palabras, _precision: precision,
        })
      }

      const ordenados = encontrados
        .sort((a, b) =>
          PESO_MOTIVO[b.motivo] - PESO_MOTIVO[a.motivo]
          || (a.motivo === 'palabras' ? (b._palabras - a._palabras || b._precision - a._precision) : 0)
          || b._sim - a._sim
          || a.nombre.length - b.nombre.length)
        .slice(0, MAX_CANDIDATOS_PEDIDO)
        .map(({ _sim, _palabras, _precision, ...c }) => c)

      return {
        texto,
        resolucion: (ordenados.length === 0 ? 'sin_resultados'
                   : ordenados.length === 1 ? 'unico'
                   : 'varios') as ResolucionBusqueda,
        candidatos: ordenados,
      }
    })
  },

  async createMaterial(dto: CreateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { forzar, alias, nombre, ...campos } = dto
    const nombreLimpio = nombre.trim()
    exigirNombreConPalabras(nombreLimpio)

    // Antes de sumar una fila más al catálogo, ofrecer las que ya existen.
    // `forzar: true` es el "no, es otro material" del usuario.
    if (!forzar) {
      const candidatos = await stockService.buscarParecidos(nombreLimpio, token)
      if (candidatos.length > 0) {
        throw new StockHttpError(
          409,
          'MATERIAL_PARECIDO',
          `Ya hay ${candidatos.length === 1 ? 'un material parecido' : 'materiales parecidos'} en el catálogo. Usá uno de esos o volvé a guardar confirmando que es distinto.`,
          { candidatos },
        )
      }
    }

    const insertData: Record<string, unknown> = {
      ...campos,
      nombre:     nombreLimpio,
      alias:      normalizarAlias(alias),
      created_by: userId,
      updated_by: userId,
    }
    if (!insertData.proveedor_id) delete insertData.proveedor_id
    // El primer precio tambien va por fijar_precio_ref (20260911c): si entra
    // por el INSERT, el historial lo atribuye a 'sql' y a nadie.
    const precioInicial = Number(insertData.precio_ref ?? 0)
    insertData.precio_ref = 0

    const { data: creado, error } = await supabase
      .from('stock_materiales')
      .insert(insertData)
      .select('*, stock_rubros(nombre, icono)')
      .single()
    if (error) {
      // El índice único parcial `stock_materiales_nombre_norm_uidx` atrapa el
      // duplicado literal aunque venga con `forzar: true`.
      if (esNombreDuplicado(error)) {
        const candidatos = await stockService.buscarParecidos(nombreLimpio, token).catch(() => [])
        throw new StockHttpError(
          409,
          'MATERIAL_DUPLICADO',
          `Ya existe un material activo llamado "${nombreLimpio}". Usá ese en vez de crear otro.`,
          { candidatos },
        )
      }
      throw new Error(error.message)
    }
    if (precioInicial > 0 && creado?.id) {
      const { error: rpcErr } = await supabase.rpc('fijar_precio_ref', {
        p_material_id: creado.id, p_precio: precioInicial, p_fuente: 'manual', p_item_id: null, p_user_id: userId,
      })
      if (rpcErr) throw new Error(rpcErr.message)
      const { data: conPrecio } = await supabase
        .from('stock_materiales').select('*, stock_rubros(nombre, icono)').eq('id', creado.id).single()
      return conPrecio ?? { ...creado, precio_ref: precioInicial }
    }
    return creado
  },

  async updateMaterial(id: number, dto: UpdateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { precio_fuente, ...campos } = dto
    const updateData: Record<string, unknown> = { ...campos, updated_by: userId }
    if (updateData.proveedor_id === null || updateData.proveedor_id === undefined) delete updateData.proveedor_id
    // `alias` solo se toca si vino en el body (el schema de update no tiene
    // defaults justamente para no pisarlo con `[]` en cada PATCH).
    if (dto.alias !== undefined) updateData.alias = normalizarAlias(dto.alias)
    if (typeof dto.nombre === 'string') {
      updateData.nombre = dto.nombre.trim()
      exigirNombreConPalabras(dto.nombre.trim())
    }
    // El precio NUNCA va por UPDATE: va por fijar_precio_ref (20260911c), que es
    // el unico camino que deja fuente, renglon y usuario en el historial.
    delete updateData.precio_ref

    // 1) ¿Cambia el precio, y de donde viene? Se decide ANTES de escribir nada.
    let precioNuevo: number | null = null
    let fuente: 'manual' | 'ultima_compra' = 'manual'
    if (typeof campos.precio_ref === 'number') {
      const { data: cat } = await supabase
        .from('v_catalogo_materiales')
        .select('unidad, precio_ref, uc_precio, uc_unidad, uc_unidad_ok')
        .eq('id', id)
        .maybeSingle()
      if (!cat) throw new StockHttpError(404, 'MATERIAL_INEXISTENTE', 'No existe el material.')
      // El modal de edicion manda el form entero con el precio sin tocar: eso
      // es un no-op y no dispara ni chequeo, ni permiso, ni RPC.
      const cambia = Number(cat.precio_ref ?? 0) !== campos.precio_ref
      if (cambia) {
        // "Usar ultima compra" se infiere SOLO en un PATCH que trae unicamente
        // el precio (el boton del catalogo). Un form entero es edicion manual.
        const soloPrecioEnBody = Object.keys(campos).every(k => k === 'precio_ref')
        const coincide = cat.uc_precio != null && Number(cat.uc_precio) === campos.precio_ref
        const esUltimaCompra = precio_fuente === 'ultima_compra' || (precio_fuente === undefined && soloPrecioEnBody && coincide)
        if (esUltimaCompra) {
          if (cat.uc_precio == null) {
            throw new StockHttpError(409, 'SIN_ULTIMA_COMPRA', 'La ficha no tiene compras de las que copiar el precio.')
          }
          // Contra la unidad FINAL de la ficha: puede venir cambiada en el mismo
          // PATCH, y es justamente la forma de arreglar una ficha inconsistente.
          const unidadFinal = typeof campos.unidad === 'string' ? campos.unidad : (cat.unidad as string | null)
          let ok: boolean = !!cat.uc_unidad_ok
          if (typeof campos.unidad === 'string' && campos.unidad !== cat.unidad) {
            const { data } = await supabase.rpc('unidad_compatible', { p_renglon: cat.uc_unidad, p_ficha: unidadFinal })
            ok = data === true
          }
          if (!ok) {
            throw new StockHttpError(
              409,
              'UNIDAD_DISTINTA',
              `La última compra está en ${cat.uc_unidad ?? '?'} y la ficha en ${unidadFinal ?? '?'}: ese precio no se puede copiar sin convertir.`,
              { unidad_ficha: unidadFinal, unidad_compra: cat.uc_unidad, uc_precio: cat.uc_precio },
            )
          }
          fuente = 'ultima_compra'
        }
        if (!(await puedeActualizarCatalogo(userId))) {
          throw new StockHttpError(403, 'SIN_PERMISO_CATALOGO', 'Sin permiso para fijar el precio de referencia del catálogo.')
        }
        precioNuevo = campos.precio_ref
      }
    }

    // 2) Primero los demas campos: es el UPDATE que puede chocar con el nombre
    //    (23505). Si falla, el precio todavia no se toco.
    const hayCampos = Object.keys(updateData).some(k => k !== 'updated_by')
    if (hayCampos) {
      const { error } = await supabase.from('stock_materiales').update(updateData).eq('id', id)
      if (error) {
        if (esNombreDuplicado(error)) {
          const candidatos = await stockService.buscarParecidos(String(updateData.nombre ?? ''), token, id).catch(() => [])
          throw new StockHttpError(
            409,
            'MATERIAL_DUPLICADO',
            `Ya existe un material activo llamado "${updateData.nombre}". Renombralo distinto o editá el que ya está.`,
            { candidatos },
          )
        }
        throw new Error(error.message)
      }
    }

    // 3) Despues el precio, con el cliente POR REQUEST: lleva x-cadinc-user y
    //    audit_cambios atribuye el 'precio_ref: X -> Y' a la persona. Y como
    //    corre despues del UPDATE, el trigger del historial ya ve la unidad nueva.
    if (precioNuevo !== null) {
      const { error: rpcErr } = await supabase.rpc('fijar_precio_ref', {
        p_material_id: id,
        p_precio:      precioNuevo,
        p_fuente:      fuente,
        p_item_id:     null,
        p_user_id:     userId,
      })
      if (rpcErr) {
        const code = ['PRECIO_INVALIDO', 'MATERIAL_INEXISTENTE', 'FUENTE_INVALIDA'].find(k => rpcErr.message.includes(k))
        throw new StockHttpError(code === 'MATERIAL_INEXISTENTE' ? 404 : 400, code ?? 'PRECIO_RECHAZADO', rpcErr.message)
      }
    }

    // 4) La ficha como quedo.
    const { data, error } = await supabase
      .from('stock_materiales')
      .select('*, stock_rubros(nombre, icono)')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMaterial(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_materiales')
      .update({ activo: false, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // ── Movimientos ──
  async getMovimientos(token: string, material_id?: number) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('stock_movimientos')
      .select('*, stock_materiales(nombre, unidad)')
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (material_id) q = q.eq('material_id', material_id)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async createMovimiento(dto: CreateMovimientoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Los ajustes nacen como PENDIENTE — no impactan el stock hasta que
    // alguien con permiso `aprobar_ajustes_stock` los apruebe.
    // Los movimientos de entrada/salida (compra/despacho/devolución) siguen
    // aplicando directo: son operativos, no requieren doble control.
    const esAjuste = dto.tipo === 'ajuste'
    const estado   = esAjuste ? 'pendiente' : 'aprobado'

    const { data: mov, error } = await supabase
      .from('stock_movimientos')
      .insert({
        ...dto,
        estado,
        fecha:      dto.fecha ?? new Date().toISOString().slice(0, 10),
        created_by: userId,
        // Aprobación inmediata para no-ajustes: el mismo usuario "aprueba".
        aprobado_por: esAjuste ? null : userId,
        aprobado_at:  esAjuste ? null : new Date().toISOString(),
      })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Si es ajuste pendiente, NO tocamos stock_actual. Se aplicará en aprobar().
    if (esAjuste) return mov

    // Entradas y salidas: aplicar delta inmediato.
    const delta = dto.tipo === 'entrada' ? dto.cantidad : -dto.cantidad
    const { data: mat } = await supabase
      .from('stock_materiales')
      .select('stock_actual')
      .eq('id', dto.material_id)
      .single()
    if (mat) {
      await supabase
        .from('stock_materiales')
        .update({ stock_actual: mat.stock_actual + delta, updated_by: userId })
        .eq('id', dto.material_id)
    }
    return mov
  },

  // Lista ajustes en estado pendiente (para el panel del aprobador).
  async listAjustesPendientes(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_movimientos')
      // SIN embed del declarante. `stock_movimientos.created_by` apunta a
      // `auth.users(id)`, NO a `profiles(id)`, así que pedir
      // `profiles!stock_movimientos_created_by_fkey` hacía fallar la query
      // entera con "Could not find a relationship between
      // 'stock_movimientos' and 'profiles'". El endpoint tiraba 500, el
      // front se quedaba con la lista vacía y el panel de "Ajustes
      // pendientes" se auto-ocultaba: nunca se vio un ajuste pendiente, y el
      // botón "↔ Diferencia" declaraba ajustes que quedaban invisibles para
      // siempre. El nombre lo resuelve el front con `usePerfilesMap`, que es
      // lo que ya hacen las otras pantallas.
      .select('*, stock_materiales(id, nombre, unidad, stock_actual)')
      .eq('tipo',   'ajuste')
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  // Aprobar un ajuste pendiente: aplica el delta al stock_actual.
  async aprobarAjuste(movId: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Traer el movimiento con FOR-UPDATE-equivalente vía PostgREST: tomamos
    // la fila, validamos que sigue pendiente, y aplicamos. Race-condition
    // mínima posible si dos admin aprueban a la vez — el segundo va a fallar
    // porque el estado ya no será pendiente.
    const { data: mov, error: errGet } = await supabase
      .from('stock_movimientos')
      .select('id, tipo, cantidad, material_id, estado')
      .eq('id', movId)
      .single()
    if (errGet || !mov) throw new Error('Movimiento no existe')
    if (mov.tipo !== 'ajuste') throw new Error('Solo se aprueban ajustes')
    if (mov.estado !== 'pendiente') throw new Error('El ajuste ya no está pendiente')

    // Aplicar delta al stock.
    const { data: mat } = await supabase
      .from('stock_materiales')
      .select('stock_actual')
      .eq('id', mov.material_id)
      .single()
    if (!mat) throw new Error('Material no existe')

    const nuevoStock = mat.stock_actual + mov.cantidad
    await supabase
      .from('stock_materiales')
      .update({ stock_actual: nuevoStock, updated_by: userId })
      .eq('id', mov.material_id)

    // Marcar como aprobado.
    const { data: actualizado, error: errUp } = await supabase
      .from('stock_movimientos')
      .update({
        estado:       'aprobado',
        aprobado_por: userId,
        aprobado_at:  new Date().toISOString(),
      })
      .eq('id', movId)
      .eq('estado', 'pendiente') // guard contra race
      .select()
      .single()
    if (errUp || !actualizado) {
      // Otro admin lo aprobó/rechazó en paralelo — revertimos el stock.
      await supabase
        .from('stock_materiales')
        .update({ stock_actual: mat.stock_actual, updated_by: userId })
        .eq('id', mov.material_id)
      throw new Error('El ajuste ya fue procesado por otro usuario')
    }
    return actualizado
  },

  async rechazarAjuste(movId: number, motivo: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_movimientos')
      .update({
        estado:         'rechazado',
        aprobado_por:   userId,
        aprobado_at:    new Date().toISOString(),
        rechazo_motivo: motivo,
      })
      .eq('id', movId)
      .eq('tipo', 'ajuste')
      .eq('estado', 'pendiente')
      .select()
      .single()
    if (error || !data) throw new Error('No se pudo rechazar — ¿ya fue procesado?')
    return data
  },
}
