import { createSupabaseClient } from '../../lib/supabase.js'
import { registrarItemEvento } from '../../lib/item-eventos.js'
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
      // ¿El destino es la obra depósito? Si es así, al recibir (marcar enviado)
      // recién ahora ingresan al stock las compras a proveedor (motivo: la
      // compra es el pedido, el material llega después y se recibe acá).
      const { data: obraDest } = await supabase
        .from('obras').select('es_deposito').eq('cod', dto.obra_cod).maybeSingle()
      const esDeposito = obraDest?.es_deposito === true

      for (const itemId of dto.enviar_items) {
        // Estado previo del ítem (antes de marcar enviado) para decidir si suma stock.
        const { data: itemPrev } = await supabase
          .from('solicitud_compra_item')
          .select('estado, material_id, cantidad, cantidad_comprada, precio_unit')
          .eq('id', itemId)
          .maybeSingle()

        const { data: updated } = await supabase
          .from('solicitud_compra_item')
          .update({
            estado: 'enviado',
            fecha_envio: hoy,
            remito_envio_id: remito.id,
          })
          .eq('id', itemId)
          // 'retirado' = ya se trajo del proveedor (flujo en_proveedor → retirar),
          // queda listo para enviar. Antes faltaba acá y el ítem se quedaba
          // colgado en 'retirado' sin fecha_envio aunque el remito se creara.
          .in('estado', ['comprado', 'de_deposito', 'retirado'])
          .select('id')
          .maybeSingle()

        // Traza: solo si efectivamente pasó a 'enviado'.
        if (updated) {
          await registrarItemEvento(supabase, {
            itemId,
            solicitudId:    dto.solicitud_id ?? null,
            accion:         'enviado',
            estadoAnterior: itemPrev?.estado ?? null,
            estadoNuevo:    'enviado',
            cantidad:       itemPrev ? Number(itemPrev.cantidad_comprada ?? itemPrev.cantidad) : null,
            meta:           { remito_id: remito.id, numero, obra_cod: dto.obra_cod, recibido_en_deposito: esDeposito },
            userId,
          })
        }

        // Compra a proveedor con destino depósito → al recibir ingresa al stock.
        // (Los despachos de_deposito ya descontaron stock al despachar; no se tocan.)
        if (updated && esDeposito && itemPrev?.estado === 'comprado' && itemPrev.material_id) {
          const qty = Number(itemPrev.cantidad_comprada ?? itemPrev.cantidad)
          const { data: mat } = await supabase
            .from('stock_materiales').select('stock_actual').eq('id', itemPrev.material_id).maybeSingle()
          if (mat) {
            await supabase
              .from('stock_materiales')
              .update({
                stock_actual: Number(mat.stock_actual) + qty,
                ...(itemPrev.precio_unit != null ? { precio_ref: itemPrev.precio_unit } : {}),
                updated_by: userId,
              })
              .eq('id', itemPrev.material_id)
          }
          await supabase.from('stock_movimientos').insert({
            material_id:       itemPrev.material_id,
            tipo:              'entrada',
            cantidad:          qty,
            motivo:            'compra',
            obra_cod:          dto.obra_cod,
            solicitud_item_id: itemId,
            fecha:             hoy,
            created_by:        userId,
          })
        }
      }
    }

    return this.getById(remito.id, token)
  },
}
