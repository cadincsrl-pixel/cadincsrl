import { createSupabaseClient } from '../../lib/supabase.js'
import type { CreateRemitoEnvioDto } from './remitos-envio.schema.js'

export const remitosEnvioService = {

  async getAll(token: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('remitos_envio')
      .select('*, items:remitos_envio_item(*)')
      .order('fecha', { ascending: false })
    if (obra_cod) q = q.eq('obra_cod', obra_cod)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('remitos_envio')
      .select('*, items:remitos_envio_item(*)')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateRemitoEnvioDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const hoy = new Date().toISOString().slice(0, 10)

    // Generar número de remito (buscar último + 1)
    const { data: ultimo } = await supabase
      .from('remitos_envio')
      .select('numero')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastNum = ultimo?.numero ? parseInt(ultimo.numero.replace('RM-', '')) : 0
    const numero = `RM-${String(lastNum + 1).padStart(4, '0')}`

    // Crear remito
    const { data: remito, error } = await supabase
      .from('remitos_envio')
      .insert({
        numero,
        fecha:        hoy,
        obra_cod:     dto.obra_cod,
        solicitud_id: dto.solicitud_id ?? null,
        origen:       dto.origen,
        obs:          dto.obs,
        created_by:   userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Insertar ítems del remito
    const itemsData = dto.items.map(it => ({
      remito_id:   remito.id,
      item_id:     it.item_id ?? null,
      descripcion: it.descripcion,
      cantidad:    it.cantidad,
      unidad:      it.unidad,
      precio_unit: it.precio_unit ?? null,
      origen:      it.origen,
      proveedor:   it.proveedor ?? null,
    }))
    await supabase.from('remitos_envio_item').insert(itemsData)

    // Marcar ítems de solicitud como enviados y vincular remito
    if (dto.enviar_items && dto.enviar_items.length > 0) {
      for (const itemId of dto.enviar_items) {
        await supabase
          .from('solicitud_compra_item')
          .update({
            estado: 'enviado',
            fecha_envio: hoy,
            remito_envio_id: remito.id,
          })
          .eq('id', itemId)
          .in('estado', ['comprado', 'de_deposito'])
      }
    }

    return this.getById(remito.id, token)
  },
}
