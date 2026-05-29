import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import type { CreateMovimientoDto, UpdateMovimientoDto } from './caja.schema.js'

export const cajaService = {

  // ── Movimientos ────────────────────────────────────────────────────────

  async getMovimientos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('movimientos_caja')
      .select('*')
      .order('fecha', { ascending: false })
      .order('id',    { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createMovimiento(dto: CreateMovimientoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Insertamos con saldo_acum = 0 como placeholder; el RPC lo recalcula
    // junto con todos los posteriores en una sola query atómica con window
    // function. Así evitamos el loop N+1 que tenía race condition.
    const { data, error } = await supabase
      .from('movimientos_caja')
      .insert({ ...dto, saldo_acum: 0, creado_por: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)

    await cajaService._recalcularTodos(token)

    // Re-leer el row con el saldo actualizado por el RPC.
    const { data: refreshed } = await supabase
      .from('movimientos_caja')
      .select('*')
      .eq('id', data.id)
      .single()
    return refreshed ?? data
  },

  async updateMovimiento(id: number, dto: UpdateMovimientoDto, token: string) {
    const supabase = createSupabaseClient(token)

    const { data, error } = await supabase
      .from('movimientos_caja')
      .update(dto)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)

    await cajaService._recalcularTodos(token)

    // Re-leer para devolver el saldo recalculado.
    const { data: refreshed } = await supabase
      .from('movimientos_caja')
      .select('*')
      .eq('id', id)
      .single()
    return refreshed ?? data
  },

  async deleteMovimiento(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('movimientos_caja').delete().eq('id', id)
    if (error) throw new Error(error.message)
    await cajaService._recalcularTodos(token)
    return { success: true }
  },

  /**
   * Recalcula saldo_acum de todos los movimientos vía RPC transaccional con
   * window function (migración 20260424_rpc_recalcular_saldos_caja).
   * Reemplaza el loop N+1 anterior que tenía race condition bajo concurrencia.
   */
  async _recalcularTodos(_token: string) {
    // supabaseAdmin: sp_recalcular_saldos_caja es SECURITY DEFINER y la migración
    // 20260527 revocó EXECUTE para `authenticated` (rol efectivo del token client).
    const { error } = await supabaseAdmin.rpc('sp_recalcular_saldos_caja')
    if (error) throw new Error(`Error recalculando saldos: ${error.message}`)
  },

  // ── Conceptos ──────────────────────────────────────────────────────────

  async getConceptos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('caja_conceptos')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createConcepto(dto: { nombre: string; tipo: string }, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('caja_conceptos')
      .insert(dto)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async toggleConcepto(id: number, activo: boolean, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('caja_conceptos')
      .update({ activo })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // ── Centros de costo ───────────────────────────────────────────────────

  async getCentros(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('caja_centros_costo')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createCentro(nombre: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('caja_centros_costo')
      .insert({ nombre })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async toggleCentro(id: number, activo: boolean, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('caja_centros_costo')
      .update({ activo })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },
}
