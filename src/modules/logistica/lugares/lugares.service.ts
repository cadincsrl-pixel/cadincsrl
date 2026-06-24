import { createSupabaseClient } from '../../../lib/supabase.js'
import type {
  CreateLugarDto, UpdateLugarDto, CreateRutaDto, UpdateRutaDto,
  CrearLugarOperativoDto, UpdateLugarOperativoDto,
} from './lugares.schema.js'

function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string }
  e.code = code
  return e
}

export const lugaresService = {
  async getCanteras(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('canteras').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getDepositos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('depositos').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getRutas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .select('*, canteras(nombre), depositos(nombre)')
      .order('id')
    if (error) throw new Error(error.message)
    return data
  },

  async createCantera(dto: CreateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('canteras')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createDeposito(dto: CreateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('depositos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createRuta(dto: CreateRutaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCantera(id: number, dto: UpdateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('canteras')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateDeposito(id: number, dto: UpdateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('depositos')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateRuta(id: number, dto: UpdateRutaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteRuta(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('rutas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Lugares operativos (par cantera+depósito gestionado como un concepto) ──

  async getLugaresOperativos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('lugares_operativos').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  /** Crea el lugar operativo = cantera (operativo) + depósito (operativo) +
   *  fila que los vincula. Si algún paso falla, limpia los anteriores. */
  async crearLugarOperativo(dto: CrearLugarOperativoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const base = { nombre: dto.nombre, operativo: true, created_by: userId, updated_by: userId }

    const { data: cantera, error: e1 } = await supabase
      .from('canteras').insert(base).select('id').single()
    if (e1) throw new Error(e1.message)

    const { data: deposito, error: e2 } = await supabase
      .from('depositos').insert(base).select('id').single()
    if (e2) {
      await supabase.from('canteras').delete().eq('id', cantera.id)
      throw new Error(e2.message)
    }

    const { data, error: e3 } = await supabase
      .from('lugares_operativos')
      .insert({ nombre: dto.nombre, obs: dto.obs ?? null, cantera_id: cantera.id, deposito_id: deposito.id, created_by: userId, updated_by: userId })
      .select('*').single()
    if (e3) {
      await supabase.from('depositos').delete().eq('id', deposito.id)
      await supabase.from('canteras').delete().eq('id', cantera.id)
      throw new Error(e3.message)
    }
    return data
  },

  async actualizarLugarOperativo(id: number, dto: UpdateLugarOperativoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data: lugar, error: e0 } = await supabase
      .from('lugares_operativos').select('*').eq('id', id).maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!lugar) throw codedError('NO_EXISTE', 'Lugar operativo no encontrado')

    // Renombrar mantiene en sync el par cantera+depósito.
    if (dto.nombre) {
      const r1 = await supabase.from('canteras').update({ nombre: dto.nombre, updated_by: userId }).eq('id', lugar.cantera_id)
      if (r1.error) throw new Error(r1.error.message)
      const r2 = await supabase.from('depositos').update({ nombre: dto.nombre, updated_by: userId }).eq('id', lugar.deposito_id)
      if (r2.error) throw new Error(r2.error.message)
    }

    const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date().toISOString() }
    if (dto.nombre !== undefined) patch.nombre = dto.nombre
    if (dto.obs !== undefined)    patch.obs = dto.obs
    const { data, error } = await supabase
      .from('lugares_operativos').update(patch).eq('id', id).select('*').single()
    if (error) throw new Error(error.message)
    return data
  },

  async eliminarLugarOperativo(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data: lugar, error: e0 } = await supabase
      .from('lugares_operativos').select('*').eq('id', id).maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!lugar) throw codedError('NO_EXISTE', 'Lugar operativo no encontrado')

    // No borrar si la cantera/depósito está en uso. Chequeamos las tablas que
    // referencian con RESTRICT (tramos, rutas); cualquier otra FK no contemplada
    // se atrapa abajo (Postgres 23503 → EN_USO) para no devolver un 500 crudo.
    const filtro = `cantera_id.eq.${lugar.cantera_id},deposito_id.eq.${lugar.deposito_id}`
    for (const tabla of ['tramos', 'rutas']) {
      const { count, error } = await supabase.from(tabla).select('id', { count: 'exact', head: true }).or(filtro)
      if (error) throw new Error(error.message)
      if ((count ?? 0) > 0) throw codedError('EN_USO', 'No se puede eliminar: el lugar tiene tramos o rutas asociadas')
    }

    // Primero la fila operativa (FK a canteras/depositos), después el par.
    try {
      for (const op of [
        () => supabase.from('lugares_operativos').delete().eq('id', id),
        () => supabase.from('depositos').delete().eq('id', lugar.deposito_id),
        () => supabase.from('canteras').delete().eq('id', lugar.cantera_id),
      ]) {
        const { error } = await op()
        if (error) throw error
      }
    } catch (err: any) {
      if (err?.code === '23503') throw codedError('EN_USO', 'No se puede eliminar: el lugar está en uso en otra parte del sistema')
      throw new Error(err?.message ?? 'Error al eliminar el lugar operativo')
    }
    return { success: true }
  },
}
