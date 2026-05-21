import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreatePersonalDto, UpdatePersonalDto } from './personal.schema.js'

// Columnas mínimas que un capataz necesita para cargar horas. NO incluye
// DNI, dirección, teléfono, fecha_nacimiento ni cat_id (este último es
// derivable a un costo si tiene acceso a categorías).
const SELECT_LIMITADO = 'leg, nom, condicion, modalidad, activo_override, created_at, updated_at'
const SELECT_COMPLETO = `
  *,
  personal_cat_historial (
    cat_id,
    desde
  )
`

export const personalService = {

  async getAll(token: string, opts: { limitado?: boolean } = {}) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('personal')
      .select(opts.limitado ? SELECT_LIMITADO : SELECT_COMPLETO)
      .order('leg')

    if (error) throw new Error(error.message)
    return data
  },

  async getByLeg(leg: string, token: string, opts: { limitado?: boolean } = {}) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('personal')
      .select(opts.limitado ? SELECT_LIMITADO : SELECT_COMPLETO)
      .eq('leg', leg)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreatePersonalDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    const { data, error } = await supabase
      .from('personal')
      .insert({
        leg: dto.leg,
        nom: dto.nom,
        dni: dto.dni,
        cat_id: dto.cat_id,
        tel: dto.tel,
        dir: dto.dir,
        obs: dto.obs,
        fecha_nacimiento: dto.fecha_nacimiento ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Insertar primer registro en historial de categorías
    await supabase
      .from('personal_cat_historial')
      .insert({
        leg: dto.leg,
        cat_id: dto.cat_id,
        desde: new Date().toISOString().slice(0, 10),
        created_by: userId,
        updated_by: userId,
      })

    return data
  },

  async update(leg: string, dto: UpdatePersonalDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('personal')
      .update({ ...dto, updated_by: userId })
      .eq('leg', leg)
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Si cambió la categoría, registrar en historial
    if (dto.cat_id) {
      await supabase
        .from('personal_cat_historial')
        .insert({
          leg,
          cat_id: dto.cat_id,
          desde: new Date().toISOString().slice(0, 10),
          created_by: userId,
          updated_by: userId,
        })
    }

    return data
  },

  async delete(leg: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('personal')
      .delete()
      .eq('leg', leg)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
