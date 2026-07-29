import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateCubiertasDto, UpdateCubiertasDto } from './camion-cubiertas.schema.js'

export class CamionCubiertasError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'CamionCubiertasError'
  }
}

const COLS = 'id, camion_id, fecha, km_camion, cantidad, obs, created_at, updated_at'

export const camionCubiertasService = {
  /** Histórico de un camión, del cambio más reciente al más viejo. */
  async listByCamion(camionId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('camion_cubiertas')
      .select(COLS)
      .eq('camion_id', camionId)
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
      .order('id',    { ascending: false })
    if (error) throw new CamionCubiertasError(500, 'DB_ERROR', error.message)
    return data
  },

  async create(dto: CreateCubiertasDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('camion_cubiertas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select(COLS)
      .single()
    if (error) throw new CamionCubiertasError(500, 'DB_ERROR', error.message)
    return data
  },

  async update(id: number, dto: UpdateCubiertasDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
    const { data, error } = await sb
      .from('camion_cubiertas')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .is('deleted_at', null)
      .select(COLS)
      .maybeSingle()
    if (error) throw new CamionCubiertasError(500, 'DB_ERROR', error.message)
    if (!data) throw new CamionCubiertasError(404, 'CUBIERTAS_NO_EXISTE')
    return data
  },

  /** Soft delete: un cambio de cubiertas es historia del camión y borrarlo de
   *  verdad rompería el cálculo de km entre cambios. */
  async softDelete(id: number, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('camion_cubiertas')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new CamionCubiertasError(500, 'DB_ERROR', error.message)
    if (!data) throw new CamionCubiertasError(404, 'CUBIERTAS_NO_EXISTE')
    return { success: true }
  },
}
