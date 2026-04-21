import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateTramoDto, UpdateTramoDto, RegistrarDescargaDto } from './tramos.schema.js'

export const tramosService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    // Orden estable: fecha_operacion DESC; tiebreaker manual (orden_dia)
    // y finalmente id DESC.
    const { data, error } = await supabase
      .from('tramos')
      .select('*')
      .order('fecha_operacion', { ascending: false, nullsFirst: false })
      .order('orden_dia', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async mover(id: number, dir: 'up' | 'down', token: string) {
    const supabase = createSupabaseClient(token)
    // Cargamos el tramo objetivo
    const { data: actual, error: e1 } = await supabase
      .from('tramos')
      .select('id, fecha_operacion, orden_dia')
      .eq('id', id)
      .single()
    if (e1) throw new Error(e1.message)
    if (!actual?.fecha_operacion) throw new Error('El tramo no tiene fecha asignada')

    // Buscamos el vecino dentro del mismo día.
    // up  → vecino con orden_dia > actual.orden_dia (el inmediato superior).
    // down→ vecino con orden_dia < actual.orden_dia (el inmediato inferior).
    const baseOrden = actual.orden_dia ?? actual.id
    const vecinoQ = supabase
      .from('tramos')
      .select('id, orden_dia')
      .eq('fecha_operacion', actual.fecha_operacion)
      .neq('id', id)
      .limit(1)

    const { data: vecinos, error: e2 } = dir === 'up'
      ? await vecinoQ.gt('orden_dia', baseOrden).order('orden_dia', { ascending: true })
      : await vecinoQ.lt('orden_dia', baseOrden).order('orden_dia', { ascending: false })
    if (e2) throw new Error(e2.message)
    const vecino = vecinos?.[0]
    if (!vecino) return { moved: false }

    // Swap atómico de orden_dia entre ambos tramos
    const vecinoOrden = vecino.orden_dia ?? vecino.id
    const { error: e3 } = await supabase
      .from('tramos')
      .update({ orden_dia: vecinoOrden })
      .eq('id', actual.id)
    if (e3) throw new Error(e3.message)
    const { error: e4 } = await supabase
      .from('tramos')
      .update({ orden_dia: baseOrden })
      .eq('id', vecino.id)
    if (e4) throw new Error(e4.message)
    return { moved: true }
  },

  async create(dto: CreateTramoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // Los tramos vacíos quedan completados de inmediato
    const estado = dto.tipo === 'vacio' ? 'completado' : 'en_curso'
    const { data, error } = await supabase
      .from('tramos')
      .insert({ ...dto, estado, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateTramoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // Eliminar keys con valor undefined para no pisar campos existentes en Supabase
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined)
    )
    const { data, error } = await supabase
      .from('tramos')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async registrarDescarga(id: number, dto: RegistrarDescargaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tramos')
      .update({ ...dto, estado: 'completado', updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    await supabase.from('liquidacion_tramos').delete().eq('tramo_id', id)
    const { error } = await supabase.from('tramos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
