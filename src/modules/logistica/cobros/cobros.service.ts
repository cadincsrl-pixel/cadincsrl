import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateCobroDto } from './cobros.schema.js'

export const cobrosService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      .select('*, empresas_transportistas(nombre)')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // 1. Crear el cobro
    const { data: cobro, error: errCobro } = await supabase
      .from('cobros')
      .insert({
        empresa_id:        dto.empresa_id,
        fecha_desde:       dto.fecha_desde,
        fecha_hasta:       dto.fecha_hasta,
        toneladas_totales: dto.toneladas_totales,
        total:             dto.total,
        obs:               dto.obs,
        estado:            'pendiente',
        created_by:        userId,
      })
      .select()
      .single()
    if (errCobro) throw new Error(errCobro.message)

    // 2. Marcar tramos con cobro_id
    if (dto.tramo_ids && dto.tramo_ids.length > 0) {
      const { error: errTramos } = await supabase
        .from('tramos')
        .update({ cobro_id: cobro.id })
        .in('id', dto.tramo_ids)
      if (errTramos) throw new Error(errTramos.message)
    }

    return cobro
  },

  async marcarCobrado(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      .update({ estado: 'cobrado', updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Liberar tramos
    await supabase.from('tramos').update({ cobro_id: null }).eq('cobro_id', id)
    const { error } = await supabase.from('cobros').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
