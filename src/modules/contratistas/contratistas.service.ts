import { createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateContratistaDto,
  UpdateContratistaDto,
  AsigContratistaDto,
  CertificacionDto,
} from './contratistas.schema.js'

export const contratistasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .select('*')
      .order('id')

    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateContratistaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .insert(dto)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateContratistaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .update(dto)
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('contratistas')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Asignaciones a obras ──
  async getAsigByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asig_contrat')
      .select('*, contratistas(*)')
      .eq('obra_cod', obraCod)

    if (error) throw new Error(error.message)
    return data
  },

  async asignar(dto: AsigContratistaDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asig_contrat')
      .insert(dto)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async desasignar(obraCod: string, contratId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('asig_contrat')
      .delete()
      .eq('obra_cod', obraCod)
      .eq('contrat_id', contratId)

    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Certificaciones ──
  async getCertByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('certificaciones')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('sem_key', { ascending: false })

    if (error) throw new Error(error.message) 
    return data
  },

  async upsertCert(dto: CertificacionDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('certificaciones')
      .upsert(dto, { onConflict: 'obra_cod,contrat_id,sem_key' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },
}