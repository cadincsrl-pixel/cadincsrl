import { createSupabaseClient } from '../../lib/supabase.js'
import type { UpsertHoraDto, UpsertHorasLoteDto } from './horas.schema.js'

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
  async upsert(dto: UpsertHoraDto, token: string) {
    const supabase = createSupabaseClient(token)

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
        },
        { onConflict: 'obra_cod,fecha,leg' }
      )
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  // Upsert en lote — para autoFill o importación Excel
  // Upsert en lote — para autoFill, importación Excel, y agregar a semana
  async upsertLote(dto: UpsertHorasLoteDto, token: string) {
    const supabase = createSupabaseClient(token)

    const rows = dto.horas.map(h => ({
      obra_cod: dto.obra_cod,
      fecha: h.fecha,
      leg: h.leg,
      horas: h.horas,
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