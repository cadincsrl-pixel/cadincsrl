import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateFacturaDto, UpdateFacturaDto } from './facturas-compra.schema.js'

export const facturasCompraService = {
  async getAll(token: string, proveedor_id?: number) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('facturas_compra')
      .select('*, proveedores(nombre)')
      .order('fecha', { ascending: false })
    if (proveedor_id) q = q.eq('proveedor_id', proveedor_id)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateFacturaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('facturas_compra')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select('*, proveedores(nombre)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateFacturaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('facturas_compra')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select('*, proveedores(nombre)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('facturas_compra').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
