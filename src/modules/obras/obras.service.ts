import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import type { CreateObraDto, UpdateObraDto } from './obras.schema.js'

export const obrasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('archivada', false)
      .order('created_at')

    if (error) throw new Error(error.message)
    return data
  },

  async getArchivadas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('archivada', true)
      .order('fecha_archivo', { ascending: false })

    if (error) throw new Error(error.message)
    return data
  },

  async getByCod(cod: string, token: string) {
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

  async autoArchivar(token: string, userId: string) {
    // Usar cliente admin para las lecturas — evita que RLS filtre filas
    // y cause falsos "sin actividad" en obras que sí tienen horas/certs
    const supabaseUser = createSupabaseClient(token)

    // Fecha de corte: hoy - 21 días
    const corte = new Date()
    corte.setDate(corte.getDate() - 21)
    const corteISO = corte.toISOString().slice(0, 10)

    // Obras activas con más de 21 días de antigüedad (las recién creadas
    // aún no tienen horas ni certs cargadas; sin este filtro se archivarían solas)
    const { data: obras, error: errObras } = await supabaseAdmin
      .from('obras')
      .select('cod')
      .eq('archivada', false)
      .lt('created_at', corteISO)
    if (errObras) throw new Error(errObras.message)
    if (!obras || obras.length === 0) return { archivadas: [] }

    // Obras con horas de personal en los últimos 21 días.
    // .limit alto: PostgREST trunca a 1000 filas por default y, con varias
    // obras activas, ese tope se pasa fácil → falsos "sin actividad" → archivado erróneo.
    const { data: horasRecientes, error: errHoras } = await supabaseAdmin
      .from('horas')
      .select('obra_cod')
      .gte('fecha', corteISO)
      .limit(100000)
    if (errHoras) throw new Error(errHoras.message)

    // Obras con certificaciones de contratistas en los últimos 21 días (sem_key es el viernes)
    const { data: certRecientes, error: errCert } = await supabaseAdmin
      .from('certificaciones')
      .select('obra_cod')
      .gte('sem_key', corteISO)
      .limit(100000)
    if (errCert) throw new Error(errCert.message)

    const codsConActividad = new Set([
      ...(horasRecientes ?? []).map((h: any) => h.obra_cod),
      ...(certRecientes ?? []).map((c: any) => c.obra_cod),
    ])

    // Obras sin actividad reciente (ni personal ni contratistas)
    const codsArchivar = obras
      .map(o => o.cod)
      .filter(cod => !codsConActividad.has(cod))

    if (codsArchivar.length === 0) return { archivadas: [] }

    const hoy = new Date().toISOString().slice(0, 10)
    const { error: errUpd } = await supabaseAdmin
      .from('obras')
      .update({ archivada: true, fecha_archivo: hoy, updated_by: userId })
      .in('cod', codsArchivar)
    if (errUpd) throw new Error(errUpd.message)

    return { archivadas: codsArchivar }
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
