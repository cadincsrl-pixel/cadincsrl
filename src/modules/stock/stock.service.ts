import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateRubroDto, UpdateRubroDto, CreateMaterialDto, UpdateMaterialDto, CreateMovimientoDto } from './stock.schema.js'

export const stockService = {

  // ── Rubros ──
  async getRubros(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_rubros')
      .select('*')
      .eq('activo', true)
      .order('orden')
    if (error) throw new Error(error.message)
    return data
  },

  async createRubro(dto: CreateRubroDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('stock_rubros').insert(dto).select().single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateRubro(id: number, dto: UpdateRubroDto, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('stock_rubros').update(dto).eq('id', id).select().single()
    if (error) throw new Error(error.message)
    return data
  },

  // ── Materiales ──
  async getMateriales(token: string, rubro_id?: number) {
    const supabase = createSupabaseClient(token)
    // Intentar con proveedores, fallback sin
    let q = supabase
      .from('stock_materiales')
      .select('*, stock_rubros(nombre, icono), proveedores(id, nombre)')
      .eq('activo', true)
      .order('nombre')
    if (rubro_id) q = q.eq('rubro_id', rubro_id)
    let { data, error } = await q
    if (error) {
      // Fallback sin proveedores (columna puede no existir aún)
      let q2 = supabase
        .from('stock_materiales')
        .select('*, stock_rubros(nombre, icono)')
        .eq('activo', true)
        .order('nombre')
      if (rubro_id) q2 = q2.eq('rubro_id', rubro_id)
      const res = await q2
      if (res.error) throw new Error(res.error.message)
      data = res.data
    }
    return data
  },

  async createMaterial(dto: CreateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const insertData: any = { ...dto, created_by: userId, updated_by: userId }
    if (!insertData.proveedor_id) delete insertData.proveedor_id
    const { data, error } = await supabase
      .from('stock_materiales')
      .insert(insertData)
      .select('*, stock_rubros(nombre, icono)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMaterial(id: number, dto: UpdateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const updateData: any = { ...dto, updated_by: userId }
    if (updateData.proveedor_id === null || updateData.proveedor_id === undefined) delete updateData.proveedor_id
    const { data, error } = await supabase
      .from('stock_materiales')
      .update(updateData)
      .eq('id', id)
      .select('*, stock_rubros(nombre, icono)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMaterial(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_materiales')
      .update({ activo: false, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // ── Movimientos ──
  async getMovimientos(token: string, material_id?: number) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('stock_movimientos')
      .select('*, stock_materiales(nombre, unidad)')
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (material_id) q = q.eq('material_id', material_id)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async createMovimiento(dto: CreateMovimientoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Los ajustes nacen como PENDIENTE — no impactan el stock hasta que
    // alguien con permiso `aprobar_ajustes_stock` los apruebe.
    // Los movimientos de entrada/salida (compra/despacho/devolución) siguen
    // aplicando directo: son operativos, no requieren doble control.
    const esAjuste = dto.tipo === 'ajuste'
    const estado   = esAjuste ? 'pendiente' : 'aprobado'

    const { data: mov, error } = await supabase
      .from('stock_movimientos')
      .insert({
        ...dto,
        estado,
        fecha:      dto.fecha ?? new Date().toISOString().slice(0, 10),
        created_by: userId,
        // Aprobación inmediata para no-ajustes: el mismo usuario "aprueba".
        aprobado_por: esAjuste ? null : userId,
        aprobado_at:  esAjuste ? null : new Date().toISOString(),
      })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Si es ajuste pendiente, NO tocamos stock_actual. Se aplicará en aprobar().
    if (esAjuste) return mov

    // Entradas y salidas: aplicar delta inmediato.
    const delta = dto.tipo === 'entrada' ? dto.cantidad : -dto.cantidad
    const { data: mat } = await supabase
      .from('stock_materiales')
      .select('stock_actual')
      .eq('id', dto.material_id)
      .single()
    if (mat) {
      await supabase
        .from('stock_materiales')
        .update({ stock_actual: mat.stock_actual + delta, updated_by: userId })
        .eq('id', dto.material_id)
    }
    return mov
  },

  // Lista ajustes en estado pendiente (para el panel del aprobador).
  async listAjustesPendientes(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_movimientos')
      .select('*, stock_materiales(id, nombre, unidad, stock_actual), declarante:profiles!stock_movimientos_created_by_fkey(id, nombre)')
      .eq('tipo',   'ajuste')
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  // Aprobar un ajuste pendiente: aplica el delta al stock_actual.
  async aprobarAjuste(movId: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Traer el movimiento con FOR-UPDATE-equivalente vía PostgREST: tomamos
    // la fila, validamos que sigue pendiente, y aplicamos. Race-condition
    // mínima posible si dos admin aprueban a la vez — el segundo va a fallar
    // porque el estado ya no será pendiente.
    const { data: mov, error: errGet } = await supabase
      .from('stock_movimientos')
      .select('id, tipo, cantidad, material_id, estado')
      .eq('id', movId)
      .single()
    if (errGet || !mov) throw new Error('Movimiento no existe')
    if (mov.tipo !== 'ajuste') throw new Error('Solo se aprueban ajustes')
    if (mov.estado !== 'pendiente') throw new Error('El ajuste ya no está pendiente')

    // Aplicar delta al stock.
    const { data: mat } = await supabase
      .from('stock_materiales')
      .select('stock_actual')
      .eq('id', mov.material_id)
      .single()
    if (!mat) throw new Error('Material no existe')

    const nuevoStock = mat.stock_actual + mov.cantidad
    await supabase
      .from('stock_materiales')
      .update({ stock_actual: nuevoStock, updated_by: userId })
      .eq('id', mov.material_id)

    // Marcar como aprobado.
    const { data: actualizado, error: errUp } = await supabase
      .from('stock_movimientos')
      .update({
        estado:       'aprobado',
        aprobado_por: userId,
        aprobado_at:  new Date().toISOString(),
      })
      .eq('id', movId)
      .eq('estado', 'pendiente') // guard contra race
      .select()
      .single()
    if (errUp || !actualizado) {
      // Otro admin lo aprobó/rechazó en paralelo — revertimos el stock.
      await supabase
        .from('stock_materiales')
        .update({ stock_actual: mat.stock_actual, updated_by: userId })
        .eq('id', mov.material_id)
      throw new Error('El ajuste ya fue procesado por otro usuario')
    }
    return actualizado
  },

  async rechazarAjuste(movId: number, motivo: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_movimientos')
      .update({
        estado:         'rechazado',
        aprobado_por:   userId,
        aprobado_at:    new Date().toISOString(),
        rechazo_motivo: motivo,
      })
      .eq('id', movId)
      .eq('tipo', 'ajuste')
      .eq('estado', 'pendiente')
      .select()
      .single()
    if (error || !data) throw new Error('No se pudo rechazar — ¿ya fue procesado?')
    return data
  },
}
