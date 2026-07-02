// src/modules/categorias/categorias.service.ts
import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateCategoriaDto, UpdateCategoriaDto } from './categorias.schema.js'

export const categoriasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .select('*, categoria_tarifas ( id, vh, desde )')
      .order('id')

    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .select('*, categoria_tarifas ( id, vh, desde )')
      .eq('id', id)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateCategoriaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('categorias')
      .insert({ nom: dto.nom, vh: dto.vh, created_by: userId, updated_by: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Versión inicial del historial de precios (categoria_tarifas).
    const { error: histError } = await supabase
      .from('categoria_tarifas')
      .insert({
        cat_id: data.id,
        vh: dto.vh,
        desde: new Date().toISOString().slice(0, 10),
        created_by: userId,
        updated_by: userId,
      })
    if (histError) throw new Error(histError.message)

    return data
  },

  async update(id: number, dto: UpdateCategoriaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Cambio de precio → nueva versión en el historial. Upsert por
    // (cat_id, desde): re-editar la misma semana pisa esa versión.
    if (dto.vh !== undefined) {
      const desde = dto.desde ?? new Date().toISOString().slice(0, 10)
      const { error: histError } = await supabase
        .from('categoria_tarifas')
        .upsert(
          { cat_id: id, vh: dto.vh, desde, created_by: userId, updated_by: userId },
          { onConflict: 'cat_id,desde' },
        )
      if (histError) throw new Error(histError.message)
    }

    // categorias.vh es cache de la ÚLTIMA versión del historial: si el
    // cambio vino backdated, el precio vigente puede no ser dto.vh.
    const patch: Record<string, unknown> = { updated_by: userId }
    if (dto.nom !== undefined) patch.nom = dto.nom
    if (dto.vh !== undefined) {
      const { data: ultima, error: ultError } = await supabase
        .from('categoria_tarifas')
        .select('vh')
        .eq('cat_id', id)
        .order('desde', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (ultError) throw new Error(ultError.message)
      patch.vh = ultima?.vh ?? dto.vh
    }

    const { data, error } = await supabase
      .from('categorias')
      .update(patch)
      .eq('id', id)
      .select('*, categoria_tarifas ( id, vh, desde )')
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('categorias')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
