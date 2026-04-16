import { createSupabaseClient } from '../../lib/supabase.js'
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

    // Calcular saldo acumulado: obtener el último movimiento en orden ASC
    const { data: todos } = await supabase
      .from('movimientos_caja')
      .select('id, fecha, saldo_acum, tipo, monto')
      .order('fecha', { ascending: true })
      .order('id',    { ascending: true })

    const lista = todos ?? []

    // Encontrar la posición donde va el nuevo movimiento
    let saldoAnterior = 0
    let insertPos = lista.length
    for (let i = lista.length - 1; i >= 0; i--) {
      const m = lista[i]!
      if (m.fecha <= dto.fecha) {
        saldoAnterior = m.saldo_acum ?? 0
        insertPos = i + 1
        break
      }
      if (i === 0) {
        insertPos = 0
      }
    }

    const delta = dto.tipo === 'ingreso' ? dto.monto : -dto.monto
    const saldo_acum = saldoAnterior + delta

    const { data, error } = await supabase
      .from('movimientos_caja')
      .insert({ ...dto, saldo_acum, creado_por: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Recalcular saldos de los movimientos posteriores
    const posteriores = lista.slice(insertPos)
    let saldoActual = saldo_acum
    for (const m of posteriores) {
      const d = m.tipo === 'ingreso' ? m.monto : -m.monto
      saldoActual += d
      await supabase.from('movimientos_caja').update({ saldo_acum: saldoActual }).eq('id', m.id)
    }

    return data
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

    // Recalcular todos los saldos desde el inicio
    await cajaService._recalcularTodos(token)
    return data
  },

  async deleteMovimiento(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('movimientos_caja').delete().eq('id', id)
    if (error) throw new Error(error.message)
    await cajaService._recalcularTodos(token)
    return { success: true }
  },

  async _recalcularTodos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data } = await supabase
      .from('movimientos_caja')
      .select('id, fecha, tipo, monto')
      .order('fecha', { ascending: true })
      .order('id',    { ascending: true })

    let saldo = 0
    for (const m of (data ?? [])) {
      saldo += m.tipo === 'ingreso' ? m.monto : -m.monto
      await supabase.from('movimientos_caja').update({ saldo_acum: saldo }).eq('id', m.id)
    }
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
