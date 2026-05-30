import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreatePrestamoDto } from './prestamos.schema.js'

export const prestamosService = {

  async create(dto: CreatePrestamoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('prestamos')
      .insert({
        leg:        dto.leg,
        sem_key:    dto.sem_key,
        tipo:       dto.tipo,
        monto:      dto.monto,
        concepto:   dto.concepto ?? null,
        created_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('prestamos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
