import { createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateCategoriaDto, UpdateCategoriaDto, CreateEntregaDto,
} from './ropa.schema.js'

export const ropaService = {

  // ── Categorías ──

  async createCategoria(dto: CreateCategoriaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('ropa_categorias')
      .insert({
        nombre:            dto.nombre,
        icono:             dto.icono ?? null,
        // meses_vencimiento es NOT NULL en DB; 0 = sin vencimiento programado.
        meses_vencimiento: dto.meses_vencimiento ?? 0,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCategoria(id: number, dto: UpdateCategoriaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('ropa_categorias')
      .update({ meses_vencimiento: dto.meses_vencimiento })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Soft delete: marca activo=false en vez de borrar (preserva FKs hacia
  // ropa_entregas que ya quedaron históricas).
  async deleteCategoria(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('ropa_categorias')
      .update({ activo: false })
      .eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Entregas ──

  async createEntrega(dto: CreateEntregaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('ropa_entregas')
      .insert({
        leg:           dto.leg,
        categoria_id:  dto.categoria_id,
        fecha_entrega: dto.fecha_entrega,
        obs:           dto.obs ?? null,
        created_by:    userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteEntrega(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('ropa_entregas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
