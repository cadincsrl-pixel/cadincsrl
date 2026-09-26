/**
 * Configuración de Sueldos: convenios, categorías, escalas (con «nueva
 * paritaria»), conceptos y sus valores, parámetros. Las lecturas van directo
 * a las tablas (son chicas; igual se paginan); las escrituras, por las RPC
 * `sueldos_guardar_*` / `sueldos_borrar_*` (flag `configurar`, que la base
 * vuelve a chequear).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todasLasFilas } from '../../lib/paginar.js'
import { rpc, filas, hoyAR } from './comun.js'
import type { ValoresAFecha } from './calculo.js'

type Fila = Record<string, unknown>

export const configService = {
  async convenios(db: SupabaseClient) {
    return filas(await db.from('sueldos_convenios').select('*').order('id'))
  },

  guardarConvenio(p: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_guardar_convenio', { p, p_user_id: uid })
  },

  async categorias(convenioId: number | undefined, db: SupabaseClient) {
    let q = db.from('sueldos_categorias').select('*').order('convenio_id').order('orden').order('id')
    if (convenioId) q = q.eq('convenio_id', convenioId)
    return filas(await q)
  },

  guardarCategoria(p: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_guardar_categoria', { p, p_user_id: uid })
  },

  /** Escalas con su categoría; `vigente` marca la que rige hoy por categoría y zona. */
  async escalas(q: { convenio_id?: number; categoria_id?: number; zona?: string }, db: SupabaseClient) {
    let catIds: number[] | null = null
    if (q.convenio_id) {
      const cats = filas(await db.from('sueldos_categorias').select('id').eq('convenio_id', q.convenio_id)) as { id: number }[]
      catIds = cats.map(c => Number(c.id))
      if (!catIds.length) return []
    }
    const rows = await todasLasFilas<Fila>((d, h) => {
      let s = db.from('sueldos_escalas')
        .select('*, categoria:sueldos_categorias(id, convenio_id, codigo, nombre, orden)')
        .order('categoria_id').order('zona').order('vigente_desde', { ascending: false }).order('id')
        .range(d, h)
      if (catIds) s = s.in('categoria_id', catIds)
      if (q.categoria_id) s = s.eq('categoria_id', q.categoria_id)
      if (q.zona) s = s.eq('zona', q.zona.toUpperCase())
      return s
    })
    const hoy = hoyAR()
    const vista = new Set<string>()
    return rows.map(r => {
      const k = `${r.categoria_id}|${r.zona}`
      let vigente = false
      if (!vista.has(k) && String(r.vigente_desde) <= hoy) { vigente = true; vista.add(k) }
      return { ...r, vigente }
    })
  },

  guardarEscala(p: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_guardar_escala', { p, p_user_id: uid })
  },

  borrarEscala(id: number, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_borrar_escala', { p_id: id, p_user_id: uid })
  },

  nuevaParitaria(b: { convenio_id: number; desde: string; porcentaje: number; fuente?: string; a_confirmar?: boolean; zona?: string | null }, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_nueva_paritaria', {
      p_convenio_id: b.convenio_id, p_desde: b.desde, p_porcentaje: b.porcentaje, p_user_id: uid,
      p_fuente: b.fuente ?? '', p_a_confirmar: b.a_confirmar ?? false, p_zona: b.zona ?? null,
    })
  },

  /**
   * Conceptos del convenio + los comunes (convenio_id null), cada uno con su
   * historial de valores y el valor vigente a `fecha` (hoy por defecto). Un
   * común pisado por uno propio del convenio viene con `pisado_por`.
   */
  async conceptos(q: { convenio_id?: number; incluir_inactivos?: boolean; fecha?: string }, db: SupabaseClient) {
    let s = db.from('sueldos_conceptos').select('*').order('orden').order('id')
    if (q.convenio_id) s = s.or(`convenio_id.eq.${q.convenio_id},convenio_id.is.null`)
    if (!q.incluir_inactivos) s = s.eq('activo', true)
    const conceptos = filas(await s) as Fila[]
    const ids = conceptos.map(c => Number(c.id))
    const valores = ids.length
      ? await todasLasFilas<Fila>((d, h) => db.from('sueldos_concepto_valores').select('*').in('concepto_id', ids)
          .order('concepto_id').order('vigente_desde', { ascending: false }).order('id').range(d, h))
      : []
    const claves = [...new Set(conceptos.map(c => c.parametro_clave).filter((x): x is string => typeof x === 'string' && x !== ''))]
    const params = claves.length
      ? filas(await db.from('sueldos_parametros').select('*').in('clave', claves).order('vigente_desde', { ascending: false })) as Fila[]
      : []
    const fecha = q.fecha ?? hoyAR()
    const propios = new Map<string, number>()
    if (q.convenio_id) for (const c of conceptos) if (c.convenio_id != null) propios.set(String(c.codigo), Number(c.id))
    return conceptos.map(c => {
      const vs = valores.filter(v => Number(v.concepto_id) === Number(c.id))
      let valor_vigente: Fila | null = null
      if (c.parametro_clave) {
        const p = params.find(x => x.clave === c.parametro_clave && String(x.vigente_desde) <= fecha)
        if (p) {
          valor_vigente = {
            origen: 'parametro', parametro_clave: c.parametro_clave,
            porcentaje: c.calculo === 'porcentaje' ? p.valor : null, monto: c.calculo !== 'porcentaje' ? p.valor : null,
            vigente_desde: p.vigente_desde, a_confirmar: p.a_confirmar, fuente: p.fuente,
          }
        }
      } else {
        const v = vs.find(x => String(x.vigente_desde) <= fecha)
        if (v) {
          valor_vigente = {
            origen: 'concepto', parametro_clave: null, porcentaje: v.porcentaje, monto: v.monto,
            vigente_desde: v.vigente_desde, a_confirmar: v.a_confirmar, fuente: v.fuente,
          }
        }
      }
      const pisado = c.convenio_id == null ? propios.get(String(c.codigo)) ?? null : null
      return { ...c, valores: vs, valor_vigente, pisado_por: pisado }
    })
  },

  guardarConcepto(p: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_guardar_concepto', { p, p_user_id: uid })
  },

  guardarConceptoValor(p: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_guardar_concepto_valor', { p, p_user_id: uid })
  },

  borrarConceptoValor(id: number, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_borrar_concepto_valor', { p_id: id, p_user_id: uid })
  },

  /** Parámetros con historial; `vigente` = el que rige a `fecha` (hoy) por clave. */
  async parametros(q: { clave?: string; fecha?: string }, db: SupabaseClient) {
    let s = db.from('sueldos_parametros').select('*').order('clave').order('vigente_desde', { ascending: false }).order('id')
    if (q.clave) s = s.eq('clave', q.clave)
    const rows = filas(await s) as Fila[]
    const fecha = q.fecha ?? hoyAR()
    const vista = new Set<string>()
    return rows.map(r => {
      let vigente = false
      if (!vista.has(String(r.clave)) && String(r.vigente_desde) <= fecha) { vigente = true; vista.add(String(r.clave)) }
      return { ...r, vigente }
    })
  },

  guardarParametro(p: Fila, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_guardar_parametro', { p, p_user_id: uid })
  },

  borrarParametro(id: number, uid: string, db: SupabaseClient) {
    return rpc<Fila>(db, 'sueldos_borrar_parametro', { p_id: id, p_user_id: uid })
  },

  valoresAFecha(convenioId: number, fecha: string, zona: string | undefined, db: SupabaseClient) {
    return rpc<ValoresAFecha>(db, 'sueldos_valores_a_fecha', { p_convenio_id: convenioId, p_fecha: fecha, p_zona: zona || 'A' })
  },
}
