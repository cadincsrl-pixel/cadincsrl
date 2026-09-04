import type { PostgrestError } from '@supabase/supabase-js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'
import type { CreateRubroDto, UpdateRubroDto, CreateMaterialDto, UpdateMaterialDto, CreateMovimientoDto } from './stock.schema.js'

/** Estados de precio que calcula `v_catalogo_materiales` (20260904z), más 'sin_precio' como agrupador. */
export const CATALOGO_ESTADOS = ['sin_precio', 'tasar', 'desactualizado', 'al_dia', 'sin_compra'] as const
export type CatalogoEstado = typeof CATALOGO_ESTADOS[number]

// ─────────────────────────────────────────────────────────────────────────
// Error tipado del módulo
// ─────────────────────────────────────────────────────────────────────────
// Las rutas lo desarman en `{ error, code, ...extra }`. Cualquier otro Error
// cae al onError global (500).
export class StockHttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
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

export type MaterialCandidato = {
  id: number
  nombre: string
  unidad: string | null
  /** Similitud por trigramas contra el nombre (0..1). */
  sim: number
  /** true si el nombre buscado coincide EXACTO con uno de sus alias. */
  por_alias: boolean
}

type FilaMaterialLite = {
  id: number
  nombre: string
  unidad: string | null
  alias: string[] | null
}

const UMBRAL_PARECIDO = 0.45
const MAX_CANDIDATOS  = 5
const PAGINA          = 1000 // tope duro de PostgREST: paginamos, no pedimos de más

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
    const [total, sin_precio, tasar, desactualizado, al_dia] = await Promise.all([
      contar(), contar('sin_precio'), contar('tasar'), contar('desactualizado'), contar('al_dia'),
    ])
    return { total, sin_precio, tasar, desactualizado, al_dia }
  },

  /**
   * Materiales activos parecidos a `nombre`, para el "¿no será este?" del alta.
   * Matchea por alias exacto (el sinónimo con el que se pide en obra) o por
   * similitud de trigramas > 0.45 contra el nombre. Los de alias van primero:
   * son la señal más fuerte aunque el nombre técnico no se parezca en nada
   * ("t1" → "Tornillo T1 autoperforante").
   */
  async buscarParecidos(nombre: string, token: string, excluirId?: number): Promise<MaterialCandidato[]> {
    const supabase = createSupabaseClient(token)
    const buscado  = normMaterial(nombre)
    if (!buscado) return []

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

    return filas
      .filter(f => f.id !== excluirId)
      .map<MaterialCandidato>(f => ({
        id:        f.id,
        nombre:    f.nombre,
        unidad:    f.unidad,
        sim:       Math.round(similitud(buscado, f.nombre) * 1000) / 1000,
        por_alias: (f.alias ?? []).some(a => normMaterial(a) === buscado),
      }))
      .filter(c => c.por_alias || c.sim > UMBRAL_PARECIDO)
      .sort((a, b) => Number(b.por_alias) - Number(a.por_alias) || b.sim - a.sim)
      .slice(0, MAX_CANDIDATOS)
  },

  async createMaterial(dto: CreateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { forzar, alias, nombre, ...campos } = dto
    const nombreLimpio = nombre.trim()

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

    const { data, error } = await supabase
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
    return data
  },

  async updateMaterial(id: number, dto: UpdateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const updateData: Record<string, unknown> = { ...dto, updated_by: userId }
    if (updateData.proveedor_id === null || updateData.proveedor_id === undefined) delete updateData.proveedor_id
    // `alias` solo se toca si vino en el body (el schema de update no tiene
    // defaults justamente para no pisarlo con `[]` en cada PATCH).
    if (dto.alias !== undefined) updateData.alias = normalizarAlias(dto.alias)
    if (typeof dto.nombre === 'string') updateData.nombre = dto.nombre.trim()

    const { data, error } = await supabase
      .from('stock_materiales')
      .update(updateData)
      .eq('id', id)
      .select('*, stock_rubros(nombre, icono)')
      .single()
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
      .select('*, stock_materiales(id, nombre, unidad, stock_actual), declarante:profiles!stock_movimientos_created_by_fkey(id, nombre)')
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
