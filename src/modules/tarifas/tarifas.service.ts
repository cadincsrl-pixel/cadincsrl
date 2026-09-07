import { createSupabaseClient } from '../../lib/supabase.js'
import { hoyArgentinaISO } from '../../lib/semanas.js'
import { viernesISO } from '../horas/costo-obra.js'
import type { CreateTarifaDto } from './tarifas.schema.js'

export const tarifasService = {

  async getByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('desde')

    if (error) throw new Error(error.message)
    return data
  },

  async upsert(dto: CreateTarifaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // Sin `desde`, rige desde la semana en curso (viernes, hora Argentina).
    const desde = dto.desde ?? viernesISO(hoyArgentinaISO())

    const { data, error } = await supabase
      .from('tarifas')
      .upsert(
        {
          obra_cod: dto.obra_cod,
          cat_id: dto.cat_id,
          vh: dto.vh,
          desde,
          created_by: userId,
          updated_by: userId,
        },
        { onConflict: 'obra_cod,cat_id,desde' }
      )
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('tarifas')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
