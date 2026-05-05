import { createSupabaseClient } from '../../../lib/supabase.js'
import { HttpError } from './gastos.service.js'
import type {
  ListCargasQuery, ConsumoCamionQuery, ConsumoChoferMesQuery, RankingChoferesQuery,
} from './combustible.schema.js'

// La vista v_consumo_chofer_mes agrupa por `date_trunc('month', fecha)::date`
// → cada fila tiene `mes = '2026-04-01'` (primer día del mes).
// Si filtramos directo con `>= desde` y desde = '2026-04-15', perdemos
// abril completo. Truncamos los extremos al primer día de su mes.
function inicioDeMes(fechaISO: string): string {
  return fechaISO.slice(0, 7) + '-01'   // 'YYYY-MM-DD' → 'YYYY-MM-01'
}

export const combustibleService = {

  // ── Listado de cargas ──────────────────────────────────────
  async listCargas(filters: ListCargasQuery, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('v_cargas_combustible')
      .select('*, camion:camiones(id,patente), chofer:choferes(id,nombre)', { count: 'exact' })

    if (filters.camion_id)        q = q.eq('camion_id', filters.camion_id)
    if (filters.chofer_id)        q = q.eq('chofer_id', filters.chofer_id)
    if (filters.tipo_combustible) q = q.eq('tipo_combustible', filters.tipo_combustible)
    if (filters.tanque_lleno != null) q = q.eq('tanque_lleno', filters.tanque_lleno)
    if (filters.desde)            q = q.gte('fecha', filters.desde)
    if (filters.hasta)            q = q.lte('fecha', filters.hasta)

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

  // ── Reporte: consumo por camión ───────────────────────────
  async consumoCamion(q: ConsumoCamionQuery, token: string) {
    const sb = createSupabaseClient(token)
    const { data: filas, error } = await sb
      .from('v_consumo_camion_odometro')
      .select('*')
      .eq('camion_id', q.camion_id)
      .gte('fecha', q.desde)
      .lte('fecha', q.hasta)
      .order('fecha', { ascending: false })
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    // Traer patente del camión para enriquecer.
    const { data: cam } = await sb.from('camiones').select('id,patente').eq('id', q.camion_id).maybeSingle()

    const rows = filas ?? []
    const totalKm     = rows.reduce((s, r: any) => s + Number(r.km_recorridos ?? 0), 0)
    const totalLitros = rows.reduce((s, r: any) => s + Number(r.litros_intervalo ?? 0), 0)
    const kmPorLitroPromedio = totalLitros > 0 ? Number((totalKm / totalLitros).toFixed(2)) : null

    return {
      camion:     cam,
      filas:      rows,
      total_km:   totalKm,
      total_litros: totalLitros,
      km_por_litro_promedio: kmPorLitroPromedio,
    }
  },

  // ── Reporte: consumo por chofer y mes ─────────────────────
  async consumoChoferMes(q: ConsumoChoferMesQuery, token: string) {
    const sb = createSupabaseClient(token)
    let sel = sb
      .from('v_consumo_chofer_mes')
      .select('*, chofer:choferes(id,nombre)')
      .gte('mes', inicioDeMes(q.desde))
      .lte('mes', inicioDeMes(q.hasta))
      .order('mes', { ascending: false })
    if (q.chofer_id) sel = sel.eq('chofer_id', q.chofer_id)

    const { data, error } = await sel
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)
    return { items: data ?? [] }
  },

  // ── Reporte: ranking de choferes ──────────────────────────
  async rankingChoferes(q: RankingChoferesQuery, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('v_consumo_chofer_mes')
      .select('chofer_id, km_recorridos, litros, gasto_combustible, cargas_count, chofer:choferes(id,nombre)')
      .gte('mes', inicioDeMes(q.desde))
      .lte('mes', inicioDeMes(q.hasta))
    if (error) throw new HttpError(500, 'DB_ERROR', error.message)

    // Agrupar por chofer (colapsando los meses del rango).
    const map = new Map<number, {
      chofer_id: number; nombre: string;
      total_km: number; total_litros: number; total_gasto: number; cargas_count: number;
    }>()
    for (const r of (data ?? []) as any[]) {
      if (r.chofer_id == null) continue
      if (!map.has(r.chofer_id)) {
        map.set(r.chofer_id, {
          chofer_id: r.chofer_id,
          nombre:    r.chofer?.nombre ?? `#${r.chofer_id}`,
          total_km: 0, total_litros: 0, total_gasto: 0, cargas_count: 0,
        })
      }
      const row = map.get(r.chofer_id)!
      row.total_km     += Number(r.km_recorridos ?? 0)
      row.total_litros += Number(r.litros ?? 0)
      row.total_gasto  += Number(r.gasto_combustible ?? 0)
      row.cargas_count += Number(r.cargas_count ?? 0)
    }

    const items = Array.from(map.values())
      .filter(r => r.cargas_count >= q.min_cargas && r.total_litros > 0)
      .map(r => ({
        ...r,
        km_por_litro: Number((r.total_km / r.total_litros).toFixed(2)),
      }))
      .sort((a, b) => b.km_por_litro - a.km_por_litro)
      .slice(0, q.limit)

    return { items, umbral_min_cargas: q.min_cargas }
  },
}
