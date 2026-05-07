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

    // Validar que exista comprobante de pago antes de marcar como cobrado.
    // Sin comprobante no hay forma de demostrar el pago — y el user
    // pidió que el sistema lo bloquee para evitar olvidos.
    const { data: adjs, error: errAdj } = await supabase
      .from('cobros_adjuntos')
      .select('id')
      .eq('cobro_id', id)
      .eq('tipo', 'comprobante')
      .is('deleted_at', null)
      .limit(1)
    if (errAdj) throw new Error(errAdj.message)
    if (!adjs || adjs.length === 0) {
      const e = new Error('FALTA_COMPROBANTE_PAGO') as Error & { code?: string }
      e.code = 'FALTA_COMPROBANTE_PAGO'
      throw e
    }

    const { data, error } = await supabase
      .from('cobros')
      .update({ estado: 'cobrado', updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Volver un cobro de 'cobrado' a 'pendiente' — útil cuando se marcó
  // por error o falta corregir el comprobante.
  async revertirCobrado(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      .update({ estado: 'pendiente', updated_by: userId, updated_at: new Date().toISOString() })
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
