import { createSupabaseClient } from '../../../lib/supabase.js'
import type { UpsertTarifaCanteraDto } from './tarifas.schema.js'

export const tarifasService = {

  async getTarifasCantera(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_cantera')
      .select('*, canteras(nombre, localidad)')
      .order('cantera_id')
    if (error) throw new Error(error.message)
    return data
  },

  async upsertTarifaCantera(dto: UpsertTarifaCanteraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_cantera')
      .upsert(
        { ...dto, updated_by: userId, updated_at: new Date().toISOString() },
        { onConflict: 'cantera_id' }
      )
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteTarifaCantera(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('tarifas_cantera').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
