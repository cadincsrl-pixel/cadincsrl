import { createSupabaseClient, supabase as supabaseAdmin } from '../../../lib/supabase.js'
import type { CreateChoferDto, UpdateChoferDto, TraspasoChoferDto } from './choferes.schema.js'

export const choferesService = {
  // Guarda una VERSIÓN de las tarifas del chofer vigente desde una fecha, en
  // lugar de pisar las columnas. Antes era un UPDATE in-place y el "parcial" de
  // Gastos > Reportes (trabajo hecho y sin liquidar) se valúa con la tarifa
  // actual: el día de un aumento se re-valuaba retroactivamente todo lo
  // pendiente. Es el mismo bug que tarja el 2026-06-26.
  // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
  async setTarifas(
    id: number,
    dto: { desde: string; basico_dia?: number; precio_km_cargado?: number; precio_km_vacio?: number; pct_facturacion?: number },
    _token: string,
    userId: string,
  ) {
    const { data, error } = await supabaseAdmin.rpc('set_tarifas_chofer', {
      p_chofer_id:  id,
      p_desde:      dto.desde,
      p_basico_dia: dto.basico_dia        ?? null,
      p_km_cargado: dto.precio_km_cargado ?? null,
      p_km_vacio:   dto.precio_km_vacio   ?? null,
      p_user_id:    userId,
      p_pct:        dto.pct_facturacion   ?? null,
    })
    if (error) {
      const msg = error.message || ''
      if (/CHOFER_NO_EXISTE/.test(msg)) throw Object.assign(new Error('CHOFER_NO_EXISTE'), { status: 404, code: 'CHOFER_NO_EXISTE' })
      if (/DESDE_REQUERIDO/.test(msg))  throw Object.assign(new Error('DESDE_REQUERIDO'),  { status: 400, code: 'DESDE_REQUERIDO' })
      throw new Error(msg)
    }
    return Array.isArray(data) ? data[0] : data
  },

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('choferes')
      // Historial de tarifas embebido, igual que categorias con categoria_tarifas:
      // basico_dia / precio_km_* en `choferes` son sólo cache de la última
      // versión, así que cualquier cálculo con fecha necesita el historial.
      .select('*, choferes_basico_hist ( id, valor_dia, desde ), choferes_km_hist ( id, valor_km, desde, tipo ), choferes_pct_hist ( id, pct, desde )')
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

  // Traspaso de camión/batea entre dos choferes en una operación. Orden de
  // updates pensado para no chocar nunca con la regla 1↔1: (1) se liberan las
  // unidades del origen, (2) el destino recibe las del origen, (3) si es
  // intercambio, el origen recibe las que tenía el destino (ya liberadas en 2).
  async traspaso(dto: TraspasoChoferDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    const { data: ambos, error: errGet } = await supabase
      .from('choferes')
      .select('id, nombre, camion_id, batea_id')
      .in('id', [dto.origen_id, dto.destino_id])
    if (errGet) throw new Error(errGet.message)

    const origen  = ambos?.find(c => c.id === dto.origen_id)
    const destino = ambos?.find(c => c.id === dto.destino_id)
    if (!origen)  throw new Error('Chofer de origen no encontrado')
    if (!destino) throw new Error('Chofer de destino no encontrado')

    // Solo se traspasan los tipos pedidos Y que el origen efectivamente tenga.
    const pasaCamion = dto.camion && origen.camion_id != null
    const pasaBatea  = dto.batea  && origen.batea_id  != null
    if (!pasaCamion && !pasaBatea) {
      throw new Error(`${origen.nombre} no tiene unidades para traspasar`)
    }

    // (1) Liberar las unidades del origen.
    const clearOrigen: Record<string, unknown> = { updated_by: userId }
    if (pasaCamion) clearOrigen.camion_id = null
    if (pasaBatea)  clearOrigen.batea_id  = null
    const { error: err1 } = await supabase.from('choferes').update(clearOrigen).eq('id', origen.id)
    if (err1) throw new Error(err1.message)

    // (2) El destino recibe las unidades del origen.
    const setDestino: Record<string, unknown> = { updated_by: userId }
    if (pasaCamion) setDestino.camion_id = origen.camion_id
    if (pasaBatea)  setDestino.batea_id  = origen.batea_id
    const { error: err2 } = await supabase.from('choferes').update(setDestino).eq('id', destino.id)
    if (err2) throw new Error(err2.message)

    // (3) Intercambio: el origen recibe lo que tenía el destino (puede ser null).
    if (dto.intercambio) {
      const setOrigen: Record<string, unknown> = { updated_by: userId }
      if (pasaCamion) setOrigen.camion_id = destino.camion_id
      if (pasaBatea)  setOrigen.batea_id  = destino.batea_id
      const { error: err3 } = await supabase.from('choferes').update(setOrigen).eq('id', origen.id)
      if (err3) throw new Error(err3.message)
    }

    const { data: actualizados, error: errFinal } = await supabase
      .from('choferes')
      .select('*')
      .in('id', [dto.origen_id, dto.destino_id])
    if (errFinal) throw new Error(errFinal.message)

    return {
      origen:  actualizados?.find(c => c.id === dto.origen_id),
      destino: actualizados?.find(c => c.id === dto.destino_id),
    }
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('choferes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
