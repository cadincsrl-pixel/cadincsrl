import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateMaquinaDto,
  UpdateMaquinaDto,
  CreateObraDto,
  UpdateObraDto,
  CreateObraMaquinaDto,
  UpdateObraMaquinaDto,
  CreateParteDto,
  UpdateParteDto,
  ListPartesQuery,
  ListRemitosQuery,
} from './alquiler.schema.js'

export const alquilerService = {
  // ── Máquinas ──────────────────────────────────────────────────
  async getMaquinas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_maquinas')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createMaquina(dto: CreateMaquinaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_maquinas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMaquina(id: number, dto: UpdateMaquinaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_maquinas')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMaquina(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_maquinas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Obras ─────────────────────────────────────────────────────
  async getObras(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obras')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getObraById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Embebemos las máquinas asignadas + datos de cada máquina. La FK
    // alquiler_obra_maquinas.maquina_id → alquiler_maquinas resuelve el join.
    const { data, error } = await supabase
      .from('alquiler_obras')
      .select('*, alquiler_obra_maquinas(*, alquiler_maquinas(*))')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createObra(dto: CreateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obras')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateObra(id: number, dto: UpdateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obras')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteObra(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_obras').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Asignación máquina ↔ obra ─────────────────────────────────
  async getObraMaquinas(obraId: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Trae máquinas asignadas + datos de la máquina. maquinista_user_id
    // viaja crudo (Fase 1 sin embed de profiles; el front lo resuelve).
    const { data, error } = await supabase
      .from('alquiler_obra_maquinas')
      .select('*, alquiler_maquinas(*)')
      .eq('obra_id', obraId)
      .order('id')
    if (error) throw new Error(error.message)
    return data
  },

  async createObraMaquina(obraId: number, dto: CreateObraMaquinaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obra_maquinas')
      .insert({
        obra_id:            obraId,
        maquina_id:         dto.maquina_id,
        maquinista_user_id: dto.maquinista_user_id ?? null,
        created_by:         userId,
        updated_by:         userId,
      })
      .select('*, alquiler_maquinas(*)')
      .single()
    if (error) {
      // 23505 = unique_violation: la máquina ya está asignada a esta obra.
      if ((error as { code?: string }).code === '23505') {
        throw new Error('La máquina ya está asignada a esta obra')
      }
      throw new Error(error.message)
    }
    return data
  },

  async updateObraMaquina(id: number, dto: UpdateObraMaquinaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obra_maquinas')
      .update({ maquinista_user_id: dto.maquinista_user_id ?? null, updated_by: userId })
      .eq('id', id)
      .select('*, alquiler_maquinas(*)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteObraMaquina(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_obra_maquinas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Partes ────────────────────────────────────────────────────
  async getPartes(query: ListPartesQuery, token: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('alquiler_partes')
      .select('*, alquiler_maquinas(*)')
      .eq('obra_id', query.obra_id)

    if (query.maquina_id != null) q = q.eq('maquina_id', query.maquina_id)
    if (query.desde) q = q.gte('fecha', query.desde)
    if (query.hasta) q = q.lte('fecha', query.hasta)

    const { data, error } = await q.order('fecha', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createParte(dto: CreateParteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_partes')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) {
      // 23505 = unique_violation: ya hay un parte para esa obra+máquina+fecha.
      if ((error as { code?: string }).code === '23505') {
        throw new Error('Ya existe un parte para esta máquina en esta obra y fecha')
      }
      throw new Error(error.message)
    }
    return data
  },

  async updateParte(id: number, dto: UpdateParteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_partes')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteParte(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_partes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Remitos (Fase 2) ──────────────────────────────────────────
  // Emite (o refresca) el remito de un parte. La numeración RA-NNNN y el
  // snapshot los hace el RPC `emitir_remito_alquiler`, que es idempotente:
  // re-emitir el mismo parte conserva el número y refresca los datos.
  //
  // §9: el RPC es SECURITY DEFINER → SIEMPRE con el cliente admin
  // (service_role). El gate de permiso (requirePermiso) ya corrió en el
  // middleware ANTES de llegar acá; el RPC recibe el userId explícito.
  async emitirRemito(parteId: number, userId: string) {
    const { data, error } = await supabaseAdmin.rpc('emitir_remito_alquiler', {
      p_parte_id: parteId,
      p_user_id:  userId,
    })
    if (error) {
      if (error.message?.includes('PARTE_NO_EXISTE')) {
        throw new Error('No se encontró el parte para emitir el remito')
      }
      throw new Error(error.message)
    }
    return data
  },

  async getRemitos(query: ListRemitosQuery, token: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase.from('alquiler_remitos').select('*')
    if (query.obra_id    != null) q = q.eq('obra_id', query.obra_id)
    if (query.maquina_id != null) q = q.eq('maquina_id', query.maquina_id)
    if (query.desde) q = q.gte('fecha_trabajo', query.desde)
    if (query.hasta) q = q.lte('fecha_trabajo', query.hasta)
    // Más recientes primero por emisión; desempate por id.
    const { data, error } = await q
      .order('fecha_emision', { ascending: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async deleteRemito(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_remitos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
