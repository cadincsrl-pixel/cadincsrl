import { HTTPException } from 'hono/http-exception'
import { createSupabaseClient } from '../../lib/supabase.js'
import type { UpsertHoraDto, UpsertHorasLoteDto } from './horas.schema.js'
import { viernesISO } from './costo-obra.js'

type SupabaseClient = ReturnType<typeof createSupabaseClient>

// Candado de semana cerrada (2026-08-06): la web bloquea editar tarjas
// cerradas SOLO en el cliente — la API aceptaba upserts sobre semanas ya
// pagadas en silencio. Con humanos por la web nunca pasó; con clientes de
// API (bot de WhatsApp) es un agujero real. Mismo criterio que hs-extras:
// estado 'cerrado' en cierres → 409.
async function ensureSemanasAbiertas(
  supabase: SupabaseClient,
  obraCod: string,
  fechas: string[],
) {
  const semKeys = [...new Set(fechas.map(viernesISO))]
  if (semKeys.length === 0) return
  const { data, error } = await supabase
    .from('cierres')
    .select('sem_key, estado')
    .eq('obra_cod', obraCod)
    .in('sem_key', semKeys)
  if (error) throw new Error(error.message)
  const cerrada = (data ?? []).find(c => c.estado === 'cerrado')
  if (cerrada) {
    throw new HTTPException(409, {
      message: `SEMANA_CERRADA: la semana ${cerrada.sem_key} de ${obraCod} está cerrada — reabrila antes de modificar horas`,
    })
  }
}

export const horasService = {

  // Obtener horas de una obra en un rango de fechas (semana)
  async getBySemana(obraCod: string, desde: string, hasta: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('horas')
      .select('*')
      .eq('obra_cod', obraCod)
      .gte('fecha', desde)
      .lte('fecha', hasta)

    if (error) throw new Error(error.message)
    return data
  },

  // Obtener todas las horas de una obra
  async getByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('horas')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('fecha')

    if (error) throw new Error(error.message)
    return data
  },

  // Upsert de una hora individual
  async upsert(dto: UpsertHoraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    await ensureSemanasAbiertas(supabase, dto.obra_cod, [dto.fecha])

    // Si horas es 0 o vacío, eliminar el registro
    if (dto.horas === 0) {
      const { error } = await supabase
        .from('horas')
        .delete()
        .eq('obra_cod', dto.obra_cod)
        .eq('fecha', dto.fecha)
        .eq('leg', dto.leg)

      if (error) throw new Error(error.message)
      return { deleted: true }
    }

    const { data, error } = await supabase
      .from('horas')
      .upsert(
        {
          obra_cod: dto.obra_cod,
          fecha: dto.fecha,
          leg: dto.leg,
          horas: dto.horas,
          // El trigger preserva created_by en UPDATE; en INSERT lo toma de aquí
          created_by: userId,
          updated_by: userId,
        },
        { onConflict: 'obra_cod,fecha,leg' }
      )
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  // Upsert en lote — para autoFill, importación Excel, y agregar a semana
  async upsertLote(dto: UpsertHorasLoteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    await ensureSemanasAbiertas(supabase, dto.obra_cod, dto.horas.map(h => h.fecha))

    const rows = dto.horas.map(h => ({
      obra_cod: dto.obra_cod,
      fecha: h.fecha,
      leg: h.leg,
      horas: h.horas,
      created_by: userId,
      updated_by: userId,
    }))

    if (rows.length > 0) {
      const { error } = await supabase
        .from('horas')
        .upsert(rows, { onConflict: 'obra_cod,fecha,leg' })

      if (error) throw new Error(error.message)
    }

    return { success: true, upserted: rows.length }
  },

  // Limpiar todas las horas de una semana en una obra
  async limpiarSemana(obraCod: string, desde: string, hasta: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('horas')
      .delete()
      .eq('obra_cod', obraCod)
      .gte('fecha', desde)
      .lte('fecha', hasta)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
