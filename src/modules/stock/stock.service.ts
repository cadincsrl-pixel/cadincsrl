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
    let q = supabase
      .from('stock_materiales')
      .select('*, stock_rubros(nombre, icono), proveedores(id, nombre)')
      .eq('activo', true)
      .order('nombre')
    if (rubro_id) q = q.eq('rubro_id', rubro_id)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async createMaterial(dto: CreateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_materiales')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select('*, stock_rubros(nombre, icono), proveedores(id, nombre)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMaterial(id: number, dto: UpdateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_materiales')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select('*, stock_rubros(nombre, icono), proveedores(id, nombre)')
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

    // Insertar movimiento
    const { data: mov, error } = await supabase
      .from('stock_movimientos')
      .insert({
        ...dto,
        fecha: dto.fecha ?? new Date().toISOString().slice(0, 10),
        created_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Actualizar stock_actual
    const delta = dto.tipo === 'entrada' ? dto.cantidad
                : dto.tipo === 'salida'  ? -dto.cantidad
                : 0 // ajuste se maneja diferente

    if (dto.tipo === 'ajuste') {
      // En ajuste, la cantidad ES el nuevo stock
      await supabase
        .from('stock_materiales')
        .update({ stock_actual: dto.cantidad, updated_by: userId })
        .eq('id', dto.material_id)
    } else if (delta !== 0) {
      // Leer stock actual y sumar/restar
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
    }

    // Actualizar precio_ref si es compra
    if (dto.motivo === 'compra' && dto.tipo === 'entrada') {
      // El precio se puede pasar via obs o se actualiza después — por ahora no cambiamos precio_ref aquí
    }

    return mov
  },
}
