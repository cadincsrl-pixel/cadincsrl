import { createSupabaseClient } from '../../lib/supabase.js'
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
    const desde = dto.desde ?? new Date().toISOString().slice(0, 10)

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
