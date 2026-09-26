/**
 * Legajos (ficha laboral). Anexo de Personal y/o de un chofer de Logística:
 * los datos de la persona siguen viviendo allá; acá van los laborales.
 * Lectura desde `v_sueldos_legajos` (nombre, convenio, categoría y
 * faltantes); escritura por `sueldos_guardar_legajo` (edición parcial).
 *
 * CUIL, CBU y DNI se enmascaran sin `ver_pii` (`***1234`). Mandar `cuil` o
 * `cbu` sin ese permiso es 403 SIN_PERMISO_PII (acá y en la base).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todasLasFilas } from '../../lib/paginar.js'
import { rpc, filas, enmascararFila, enmascarar, textoBusqueda } from './comun.js'
import { SueldosHttpError, mapRpcError, type PgError } from './sueldos.errors.js'

type Fila = Record<string, unknown>

/** Campos de Personal que se muestran en la ficha (sin talles ni datos de tarja). */
const CAMPOS_PERSONAL = ['leg', 'nom', 'dni', 'tel', 'dir', 'condicion', 'modalidad', 'fecha_nacimiento', 'cat_id'] as const
/** Campos del chofer que se muestran en la ficha. */
const CAMPOS_CHOFER = ['id', 'nombre', 'cuil', 'tel', 'licencia', 'cbu', 'alias', 'estado', 'es_propio'] as const
/** Datos de contacto y bancarios que, sin `ver_pii`, no salen (igual criterio que Personal). */
const PII_FICHA = new Set(['tel', 'dir', 'fecha_nacimiento', 'licencia', 'alias'])

function elegir(row: Fila | null | undefined, campos: readonly string[]): Fila | null {
  if (!row) return null
  const o: Fila = {}
  for (const k of campos) o[k] = row[k] ?? null
  return o
}

export interface FiltroLegajos {
  convenio_id?: number
  activo?: 'true' | 'false' | 'todos'
  incompleto?: 'true' | 'false'
  q?: string
}

export const legajosService = {
  async listar(f: FiltroLegajos, verPii: boolean, db: SupabaseClient) {
    const rows = await todasLasFilas<Fila>((d, h) => {
      let s = db.from('v_sueldos_legajos').select('*').order('nombre_mostrar').order('id').range(d, h)
      if (f.convenio_id) s = s.eq('convenio_id', f.convenio_id)
      if (f.activo !== 'todos') s = s.eq('activo', f.activo !== 'false')
      if (f.incompleto) s = s.eq('incompleto', f.incompleto === 'true')
      const q = textoBusqueda(f.q ?? '')
      if (q) s = s.or(`nombre_mostrar.ilike.*${q}*,leg.ilike.*${q}*`)
      return s
    })
    return rows.map(r => enmascararFila(r, verPii))
  },

  async obtener(id: number, verPii: boolean, db: SupabaseClient) {
    const { data, error } = await db.from('v_sueldos_legajos').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new SueldosHttpError(404, 'LEGAJO_NO_EXISTE', { id })
    const l = data as Fila
    const [personal, chofer, recibos] = await Promise.all([
      l.leg ? db.from('personal').select('*').eq('leg', l.leg).maybeSingle() : Promise.resolve({ data: null, error: null }),
      l.chofer_id ? db.from('choferes').select('*').eq('id', l.chofer_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      db.from('sueldos_recibos')
        .select('id, liquidacion_id, estado, total_remunerativo, total_no_remunerativo, total_descuentos, neto, liquidacion:sueldos_liquidaciones(id, codigo, tipo, periodo, quincena, estado)')
        .eq('legajo_id', id).order('id', { ascending: false }).limit(24),
    ])
    for (const r of [personal, chofer, recibos]) if (r.error) throw mapRpcError(r.error as PgError)
    const visibles = (campos: readonly string[]) => verPii ? campos : campos.filter(k => !PII_FICHA.has(k))
    const p = elegir(personal.data as Fila | null, visibles(CAMPOS_PERSONAL))
    const ch = elegir(chofer.data as Fila | null, visibles(CAMPOS_CHOFER))
    return {
      ...enmascararFila(l, verPii),
      personal: p ? enmascararFila(p, verPii) : null,
      chofer: ch ? enmascararFila(ch, verPii) : null,
      recibos: (recibos.data ?? []) as Fila[],
    }
  },

  async guardar(p: Fila, uid: string, verPii: boolean, db: SupabaseClient) {
    if (!verPii && ('cuil' in p || 'cbu' in p)) {
      throw new SueldosHttpError(403, 'SIN_PERMISO_PII', { campo: 'cuil' in p ? 'cuil' : 'cbu' })
    }
    const row = await rpc<Fila>(db, 'sueldos_guardar_legajo', { p_legajo: p, p_user_id: uid })
    return enmascararFila(row, verPii)
  },

  /**
   * Personas y choferes que todavía no tienen legajo, para «Alta desde
   * Personal / Chofer». `convenio_sugerido`: personal por hora → uocra, por
   * mes → uecara; chofer → camioneros.
   */
  async candidatos(verPii: boolean, db: SupabaseClient) {
    const [legajos, personal, choferes] = await Promise.all([
      todasLasFilas<Fila>((d, h) => db.from('sueldos_legajos').select('id, leg, chofer_id').order('id').range(d, h)),
      todasLasFilas<Fila>((d, h) => db.from('personal').select('leg, nom, dni, condicion, modalidad').order('leg').range(d, h)),
      todasLasFilas<Fila>((d, h) => db.from('choferes').select('id, nombre, cuil, cbu, estado, es_propio').order('id').range(d, h)),
    ])
    const legs = new Set(legajos.map(x => x.leg).filter(Boolean).map(String))
    const chofs = new Set(legajos.map(x => x.chofer_id).filter(x => x != null).map(Number))
    return {
      personal: personal.filter(p => !legs.has(String(p.leg))).map(p => ({
        leg: p.leg, nombre: p.nom, dni: enmascarar(p.dni, verPii), condicion: p.condicion ?? null, modalidad: p.modalidad ?? null,
        convenio_sugerido: p.modalidad === 'mes' ? 'uecara' : 'uocra',
      })),
      choferes: choferes.filter(c => !chofs.has(Number(c.id))).map(c => ({
        chofer_id: c.id, nombre: c.nombre, cuil: enmascarar(c.cuil, verPii), cbu: enmascarar(c.cbu, verPii),
        estado: c.estado ?? null, es_propio: c.es_propio ?? null, convenio_sugerido: 'camioneros',
      })),
    }
  },

  /** Fila cruda del legajo (con CUIL/CBU) para el motor y las exportaciones. Nunca sale tal cual al front. */
  async crudo(id: number, db: SupabaseClient): Promise<Fila> {
    const { data, error } = await db.from('v_sueldos_legajos').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new SueldosHttpError(404, 'LEGAJO_NO_EXISTE', { id })
    return data as Fila
  },

  async crudos(ids: number[], db: SupabaseClient): Promise<Fila[]> {
    if (!ids.length) return []
    return todasLasFilas<Fila>((d, h) => db.from('v_sueldos_legajos').select('*').in('id', ids).order('id').range(d, h))
  },

  async delConvenio(convenioId: number, db: SupabaseClient): Promise<Fila[]> {
    return filas(await db.from('v_sueldos_legajos').select('*').eq('convenio_id', convenioId).order('nombre_mostrar').order('id')) as Fila[]
  },
}
