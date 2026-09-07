import { HTTPException } from 'hono/http-exception'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { ensureNoAfectaSemanasCerradas, hoyArgentinaISO } from '../../lib/semanas.js'
import { viernesISO } from '../horas/costo-obra.js'
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

/** 409 si otro legajo ya tiene ese DNI. Vacío = sin DNI cargado, no se controla. */
async function ensureDniLibre(supabase: SupabaseClient, dni: string, legPropio: string | null): Promise<void> {
  if (!dni) return
  let q = supabase.from('personal').select('leg, nom').eq('dni', dni)
  if (legPropio) q = q.neq('leg', legPropio)
  const { data, error } = await q.limit(1).maybeSingle()
  if (error) throw new Error(error.message)
  if (data) {
    throw new HTTPException(409, {
      message: `DNI_DUPLICADO: el DNI ${dni} ya está cargado en el legajo ${data.leg} (${String(data.nom).trim()})`,
    })
  }
}

/**
 * Deja constancia de la categoría que rige desde el viernes `desde`. Hay una
 * sola fila por legajo y fecha (índice único `personal_cat_historial_leg_desde_uidx`):
 * si ese viernes ya tenía una, se corrige en lugar de duplicarla.
 */
async function registrarCategoria(
  supabase: SupabaseClient,
  leg: string,
  catId: number,
  desde: string,
  userId: string,
): Promise<void> {
  const { data: previa, error: e1 } = await supabase
    .from('personal_cat_historial')
    .select('id')
    .eq('leg', leg)
    .eq('desde', desde)
    .maybeSingle()
  if (e1) throw new Error(e1.message)

  const { error } = previa
    ? await supabase.from('personal_cat_historial').update({ cat_id: catId, updated_by: userId }).eq('id', previa.id)
    : await supabase.from('personal_cat_historial').insert({ leg, cat_id: catId, desde, created_by: userId, updated_by: userId })
  if (error) throw new Error(error.message)
}

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

    const { data: existente, error: e0 } = await supabase
      .from('personal')
      .select('leg, nom')
      .eq('leg', dto.leg)
      .maybeSingle()
    if (e0) throw new Error(e0.message)
    if (existente) {
      throw new HTTPException(409, {
        message: `LEGAJO_DUPLICADO: el legajo ${dto.leg} ya es de ${String(existente.nom).trim()}`,
      })
    }
    await ensureDniLibre(supabase, dto.dni, null)

    const { data, error } = await supabase
      .from('personal')
      .insert({
        leg:              dto.leg,
        nom:              dto.nom,
        dni:              dto.dni,
        condicion:        dto.condicion ?? null,
        modalidad:        dto.modalidad,
        cat_id:           dto.cat_id,
        tel:              dto.tel,
        dir:              dto.dir,
        obs:              dto.obs,
        talle_pantalon:   dto.talle_pantalon || null,
        talle_botines:    dto.talle_botines  || null,
        talle_camisa:     dto.talle_camisa   || null,
        fecha_nacimiento: dto.fecha_nacimiento ?? null,
        created_by:       userId,
        updated_by:       userId,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // La categoría rige desde la semana en curso (su viernes): la tarja que se
    // está cargando ya la usa y, para fechas anteriores, getCatIdEfectivo cae
    // en personal.cat_id, que es la misma.
    await registrarCategoria(supabase, dto.leg, dto.cat_id, viernesISO(hoyArgentinaISO()), userId)

    return data
  },

  async update(leg: string, dto: UpdatePersonalDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // cat_desde y confirmar_historico gobiernan el historial; no son columnas.
    const { cat_desde, confirmar_historico, ...campos } = dto

    const { data: actual, error: e0 } = await supabase
      .from('personal')
      .select('leg, cat_id, dni')
      .eq('leg', leg)
      .maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!actual) throw new HTTPException(404, { message: `NO_EXISTE: no hay trabajador con legajo ${leg}` })

    if (campos.dni !== undefined && campos.dni !== (actual.dni ?? '')) {
      // El DNI es obligatorio: si ya tenía uno, se corrige pero no se borra.
      if (campos.dni === '') {
        throw new HTTPException(400, { message: 'DNI_OBLIGATORIO: el DNI no se puede dejar vacío; si está mal, cargá el correcto' })
      }
      await ensureDniLibre(supabase, campos.dni, leg)
    }

    // Historial solo cuando la categoría realmente cambia. Hasta 2026-09-06 se
    // insertaba una fila por CADA edición (teléfono, talles…): 453 filas para
    // 116 cambios reales.
    const nuevaCat = campos.cat_id !== undefined && campos.cat_id !== actual.cat_id ? campos.cat_id : null
    const hoy = hoyArgentinaISO()
    const desde = cat_desde ?? viernesISO(hoy)
    if (nuevaCat !== null) {
      // Cambia el costo de todas las obras donde trabajó: obraCod null.
      await ensureNoAfectaSemanasCerradas(supabase, null, desde, confirmar_historico, hoy)
    }

    const { data, error } = await supabase
      .from('personal')
      .update({ ...campos, updated_by: userId })
      .eq('leg', leg)
      .select()
      .single()

    if (error) throw new Error(error.message)

    if (nuevaCat !== null) await registrarCategoria(supabase, leg, nuevaCat, desde, userId)

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
