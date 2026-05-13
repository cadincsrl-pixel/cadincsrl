import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateChoferDto, UpdateChoferDto } from './choferes.schema.js'

export const choferesService = {
  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('choferes')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateChoferDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Mismo principio que en update: la preasignación de camión/batea es 1↔1.
    // Si la unidad ya estaba en otro chofer, la liberamos antes de crear.
    const displaced: {
      camion?: { chofer_id: number; nombre: string; camion_id: number }
      batea?:  { chofer_id: number; nombre: string; batea_id:  number }
    } = {}

    if (dto.camion_id != null) {
      const { data: prev } = await supabase
        .from('choferes')
        .select('id, nombre')
        .eq('camion_id', dto.camion_id)
        .maybeSingle()
      if (prev) {
        const { error: errClear } = await supabase
          .from('choferes')
          .update({ camion_id: null, updated_by: userId })
          .eq('id', prev.id)
        if (errClear) throw new Error(errClear.message)
        displaced.camion = { chofer_id: prev.id, nombre: prev.nombre, camion_id: dto.camion_id }
      }
    }

    if (dto.batea_id != null) {
      const { data: prev } = await supabase
        .from('choferes')
        .select('id, nombre')
        .eq('batea_id', dto.batea_id)
        .maybeSingle()
      if (prev) {
        const { error: errClear } = await supabase
          .from('choferes')
          .update({ batea_id: null, updated_by: userId })
          .eq('id', prev.id)
        if (errClear) throw new Error(errClear.message)
        displaced.batea = { chofer_id: prev.id, nombre: prev.nombre, batea_id: dto.batea_id }
      }
    }

    const { data, error } = await supabase
      .from('choferes')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return { ...data, displaced }
  },

  async update(id: number, dto: UpdateChoferDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Liberar camión/batea del chofer que los tenía: la preasignación es 1↔1.
    // Si el frontend manda valor explícito (incluido null), aplica la liberación
    // contra cualquier OTRO chofer (no contra el propio id).
    const displaced: {
      camion?: { chofer_id: number; nombre: string; camion_id: number }
      batea?:  { chofer_id: number; nombre: string; batea_id:  number }
    } = {}

    if (dto.camion_id != null) {
      const { data: prev } = await supabase
        .from('choferes')
        .select('id, nombre')
        .eq('camion_id', dto.camion_id)
        .neq('id', id)
        .maybeSingle()
      if (prev) {
        const { error: errClear } = await supabase
          .from('choferes')
          .update({ camion_id: null, updated_by: userId })
          .eq('id', prev.id)
        if (errClear) throw new Error(errClear.message)
        displaced.camion = { chofer_id: prev.id, nombre: prev.nombre, camion_id: dto.camion_id }
      }
    }

    if (dto.batea_id != null) {
      const { data: prev } = await supabase
        .from('choferes')
        .select('id, nombre')
        .eq('batea_id', dto.batea_id)
        .neq('id', id)
        .maybeSingle()
      if (prev) {
        const { error: errClear } = await supabase
          .from('choferes')
          .update({ batea_id: null, updated_by: userId })
          .eq('id', prev.id)
        if (errClear) throw new Error(errClear.message)
        displaced.batea = { chofer_id: prev.id, nombre: prev.nombre, batea_id: dto.batea_id }
      }
    }

    const { data, error } = await supabase
      .from('choferes')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return { ...data, displaced }
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('choferes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
