// La carga de datos del resumen de todas las obras. El cálculo está aparte,
// en resumen-obras.ts, sin I/O, para poder congelarlo en tests.
//
// Doce lecturas en paralelo, todas de una vez para todas las obras (no una
// por obra): las tablas chicas con un `.in('obra_cod', …)`, y las dos que
// pueden pasar de 1000 filas — las horas agregadas y la cuenta del cliente —
// con `todasLasFilas` (§5.7: el tope de PostgREST aplica también a las RPC).
//
// Qué obras entran: las de CLIENTE (materiales a su cargo, ni depósito ni
// internas), activas y archivadas — CC-009 Misión Salta está archivada y debe
// $315.665. Las llave en mano no: no hay nada que cobrarles por este canal.

import { supabase as supabaseAdmin } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { armarResumenObras, type DatosResumenObras, type ResumenObraFila } from './resumen-obras.js'

export interface ResumenObras {
  filas:       ResumenObraFila[]
  /** false = el que pide no ve costos de tarja: sin jornales ni contratistas. */
  con_tarja:   boolean
  generado_en: string
}

function ok<T>(r: { data: T[] | null; error: { message: string } | null }): T[] {
  if (r.error) throw new Error(r.error.message)
  return r.data ?? []
}

export async function cargarResumenObras(allowed: string[] | null, conTarja: boolean): Promise<ResumenObras> {
  let q = supabaseAdmin
    .from('obras')
    .select('cod, nom, archivada, por_administracion')
    .eq('materiales_a_cargo_de', 'cliente')
    .eq('es_deposito', false)
    .eq('es_interna', false)
  if (allowed != null) q = q.in('cod', allowed)
  const obras = ok<{ cod: string; nom: string; archivada: boolean; por_administracion: boolean }>(await q)
  const codes = obras.map(o => o.cod)
  const hoyISO = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)

  if (codes.length === 0) return { filas: [], con_tarja: conTarja, generado_en: new Date().toISOString() }

  const vacio = Promise.resolve([] as never[])
  const [horasSemLeg, hsExtras, personal, categorias, tarifas, catObra, pcts, certs, imputaciones, materiales, cobros, notas] = await Promise.all([
    conTarja
      ? todasLasFilas<{ obra_cod: string; sem_key: string; leg: string; horas: number }>((d, h) =>
          supabaseAdmin.rpc('horas_semana_leg', { p_obras: codes }).order('obra_cod').order('sem_key').order('leg').range(d, h))
      : vacio,
    conTarja
      ? todasLasFilas<{ obra_cod: string; leg: string; sem_key: string; hs: number }>((d, h) =>
          supabaseAdmin.from('tarja_hs_extras').select('obra_cod, leg, sem_key, hs').in('obra_cod', codes).order('id').range(d, h))
      : vacio,
    conTarja ? supabaseAdmin.from('personal').select('leg, cat_id, personal_cat_historial(cat_id, desde)').then(ok) : vacio,
    conTarja ? supabaseAdmin.from('categorias').select('id, vh, categoria_tarifas(vh, desde)').then(ok) : vacio,
    conTarja ? supabaseAdmin.from('tarifas').select('obra_cod, cat_id, vh, desde').in('obra_cod', codes).then(ok) : vacio,
    conTarja ? supabaseAdmin.from('cat_obra').select('obra_cod, leg, cat_id, desde').in('obra_cod', codes).then(ok) : vacio,
    supabaseAdmin.from('obras_admin_tarifas').select('obra_cod, desde, pct_operarios, pct_contratistas, pct_materiales').in('obra_cod', codes).order('desde').then(ok),
    conTarja ? supabaseAdmin.from('certificaciones').select('obra_cod, sem_key, monto').in('obra_cod', codes).then(ok) : vacio,
    supabaseAdmin.from('cuenta_admin_imputaciones').select('obra_cod, sem_key, pata, monto').in('obra_cod', codes).then(ok),
    todasLasFilas<{ obra_cod: string; fecha_resolucion: string | null; precio_total: number; precio_unit: number }>((d, h) =>
      supabaseAdmin.from('v_cuenta_corriente').select('obra_cod, fecha_resolucion, precio_total, precio_unit')
        .in('estado', ['a_cobrar', 'cobrado']).in('obra_cod', codes).order('id').range(d, h)),
    supabaseAdmin.from('cuenta_cliente_cobros').select('obra_cod, monto').in('obra_cod', codes).then(ok),
    supabaseAdmin.from('cuenta_cliente_notas_credito').select('obra_cod, monto').eq('anulada', false).in('obra_cod', codes).then(ok),
  ])

  const datos: DatosResumenObras = {
    obras,
    horasSemLeg: horasSemLeg.map(h => ({ ...h, sem_key: String(h.sem_key) })),
    hsExtras, personal: personal as never, categorias: categorias as never,
    tarifas, catObra, pcts: pcts as never, certs: certs as never, imputaciones: imputaciones as never,
    materiales, cobros: cobros as never, notas: notas as never,
  }
  return { filas: armarResumenObras(datos, hoyISO, conTarja), con_tarja: conTarja, generado_en: new Date().toISOString() }
}
