import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import type { CreateObraDto, UpdateObraDto } from './obras.schema.js'

export const obrasService = {

  async getAll(token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('obras')
      .select('*')
      .eq('archivada', false)
      .order('created_at')

    // Filtrar por obras del usuario si NO es admin.
    // null = admin sin restricción. Array vacío = ve cero obras.
    const allowed = await getObrasDelUsuarioCached(userId)
    if (allowed != null) {
      if (allowed.length === 0) return []
      q = q.in('cod', allowed)
    }

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getArchivadas(token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('obras')
      .select('*')
      .eq('archivada', true)
      .order('fecha_archivo', { ascending: false })

    const allowed = await getObrasDelUsuarioCached(userId)
    if (allowed != null) {
      if (allowed.length === 0) return []
      q = q.in('cod', allowed)
    }

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getByCod(cod: string, token: string, userId: string) {
    // Validar acceso del usuario a esta obra antes de devolverla.
    const allowed = await getObrasDelUsuarioCached(userId)
    if (allowed != null && !allowed.includes(cod)) {
      const e: Error & { code?: string } = new Error('OBRA_SIN_ACCESO')
      e.code = 'OBRA_SIN_ACCESO'
      throw e
    }
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('cod', cod)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Verificar que el código no exista
    const { data: existing } = await supabase
      .from('obras')
      .select('cod')
      .eq('cod', dto.cod)
      .single()

    if (existing) throw new Error(`El código ${dto.cod} ya existe`)

    const { data, error } = await supabase
      .from('obras')
      .insert({
        cod: dto.cod,
        nom: dto.nom,
        cc: dto.cc,
        dir: dto.dir,
        resp: dto.resp,
        obs: dto.obs,
        archivada: false,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async update(cod: string, dto: UpdateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({ ...dto, updated_by: userId })
      .eq('cod', cod)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async archivar(cod: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({
        archivada: true,
        fecha_archivo: new Date().toISOString().slice(0, 10),
        updated_by: userId,
      })
      .eq('cod', cod)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async desarchivar(cod: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({ archivada: false, fecha_archivo: null, updated_by: userId })
      .eq('cod', cod)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Auto-archiva obras sin actividad en los últimos N días.
  //
  // Implementación vía RPC `obras_a_auto_archivar` (ver migración
  // 20260430): el cálculo corre del lado del servidor con NOT EXISTS
  // contra los índices de horas/certificaciones, así no depende del cap
  // de filas de PostgREST (~1000) que en la implementación anterior
  // generaba falsos "sin actividad" → obras archivadas por error.
  async autoArchivar(_token: string, userId: string) {
    const { data: candidatas, error: errRpc } = await supabaseAdmin
      .rpc('obras_a_auto_archivar', { p_dias_atras: 21 })
    if (errRpc) throw new Error(errRpc.message)

    const cods = (candidatas ?? []).map((r: { cod: string }) => r.cod)
    if (cods.length === 0) return { archivadas: [] }

    const hoy = new Date().toISOString().slice(0, 10)
    const { error: errUpd } = await supabaseAdmin
      .from('obras')
      .update({ archivada: true, fecha_archivo: hoy, updated_by: userId })
      .in('cod', cods)
    if (errUpd) throw new Error(errUpd.message)

    return { archivadas: cods }
  },

  async delete(cod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('obras')
      .delete()
      .eq('cod', cod)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
