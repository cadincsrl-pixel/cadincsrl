import { createSupabaseClient } from '../../lib/supabase.js'
import { registrarItemEvento } from '../../lib/item-eventos.js'
import type { CreateRemitoEnvioDto } from './remitos-envio.schema.js'

export const remitosEnvioService = {

  async getAll(token: string, obra_cod?: string) {
    const supabase = createSupabaseClient(token)
    // PostgREST capea cada respuesta a 1000 filas y el recorte es silencioso
    // (mismo patrón que tramos, arreglado el 30/07). Hay ~460 remitos creciendo
    // ~180/mes: sin esto, en unos meses el historial perdería los más viejos.
    // Orden fecha DESC + id DESC estable para paginar sin solapes.
    const PAGINA = 1000
    const todos: Record<string, unknown>[] = []
    for (let desde = 0; ; desde += PAGINA) {
      let q = supabase
        .from('remitos_envio')
        .select('*, items:remitos_envio_item(*)')
        .order('fecha', { ascending: false })
        .order('id', { ascending: false })
        .range(desde, desde + PAGINA - 1)
      if (obra_cod) q = q.eq('obra_cod', obra_cod)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      todos.push(...(data ?? []))
      if ((data ?? []).length < PAGINA) break
    }
    // Dedup por id: un INSERT entre páginas puede repetir una fila en el borde.
    const vistos = new Set<number>()
    return todos.filter(r => {
      const id = Number(r.id)
      if (vistos.has(id)) return false
      vistos.add(id)
      return true
    })
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

    // Marcar ítems de solicitud como enviados (total o PARCIAL) y vincular remito.
    if (dto.enviar_items && dto.enviar_items.length > 0) {
      // ¿El destino es la obra depósito? Si es así, al recibir ingresan al
      // stock las compras a proveedor (motivo: la compra es el pedido, el
      // material llega después y se recibe acá).
      const { data: obraDest } = await supabase
        .from('obras').select('es_deposito').eq('cod', dto.obra_cod).maybeSingle()
      const esDeposito = obraDest?.es_deposito === true

      // Ítems cuyo UPDATE falló. Antes el error se descartaba en silencio y el
      // endpoint devolvía 201 con el ítem sin marcar: nadie se enteraba.
      const fallidos: string[] = []

      for (const entrada of dto.enviar_items) {
        const itemId = typeof entrada === 'number' ? entrada : entrada.item_id

        const { data: itemPrev } = await supabase
          .from('solicitud_compra_item')
          .select('estado, material_id, cantidad, cantidad_comprada, cantidad_enviada, precio_unit')
          .eq('id', itemId)
          .maybeSingle()
        if (!itemPrev) continue
        // Solo estados listos para enviar ('retirado' = ya se trajo del
        // proveedor, flujo en_proveedor → retirar; 'de_stock_cliente' =
        // material del cliente en depósito, ya descontado de su ledger).
        if (!['comprado', 'de_deposito', 'retirado', 'de_stock_cliente'].includes(itemPrev.estado)) continue

        const efectiva  = Number(itemPrev.cantidad_comprada ?? itemPrev.cantidad)
        const yaEnviada = Number(itemPrev.cantidad_enviada ?? 0)
        const pendiente = efectiva - yaEnviada
        // number solo (shape viejo) = enviar el pendiente completo.
        const aEnviar = typeof entrada === 'number' ? pendiente : Number(entrada.cantidad)

        if (aEnviar <= 0) continue
        if (aEnviar > pendiente + 0.001) {
          throw new Error(
            `El item #${itemId} tiene ${pendiente} pendientes de envío y se intentaron enviar ${aEnviar}.`,
          )
        }

        const nuevaAcum = yaEnviada + aEnviar
        // Tolerancia por decimales de numeric.
        const completo = nuevaAcum >= efectiva - 0.001

        // `error` se capturaba y se tiraba. Un fallo del UPDATE dejaba el remito
        // creado y el ítem sin marcar, con 201 en la respuesta: nadie se entera.
        // `data` null SIN error sigue siendo un skip legítimo (el `.in(estado)`
        // filtró un ítem que ya no estaba listo para enviar).
        const { data: updated, error: errUpd } = await supabase
          .from('solicitud_compra_item')
          .update({
            cantidad_enviada: nuevaAcum,
            // El item pasa a 'enviado' recién cuando el acumulado cubre la
            // cantidad efectiva; un parcial conserva el estado y sigue
            // apareciendo "por enviar" con el pendiente restante.
            ...(completo ? { estado: 'enviado', fecha_envio: hoy, remito_envio_id: remito.id } : {}),
          })
          .eq('id', itemId)
          .in('estado', ['comprado', 'de_deposito', 'retirado', 'de_stock_cliente'])
          .select('id')
          .maybeSingle()
        // NO se corta el loop: el remito y todos sus renglones ya se insertaron
        // arriba y no hay transacción que los revierta, así que tirar acá dejaba
        // parte de los ítems marcados y parte no. Se anotan los que fallaron y se
        // reporta DESPUÉS de procesar todos, para que el fallo de uno no arrastre
        // a los demás.
        if (errUpd) {
          fallidos.push(`#${itemId}: ${errUpd.message}`)
          continue
        }

        if (updated) {
          await registrarItemEvento(supabase, {
            itemId,
            solicitudId:    dto.solicitud_id ?? null,
            accion:         completo ? 'enviado' : 'envio_parcial',
            estadoAnterior: itemPrev.estado,
            estadoNuevo:    completo ? 'enviado' : itemPrev.estado,
            cantidad:       aEnviar,
            meta:           { remito_id: remito.id, numero, obra_cod: dto.obra_cod, recibido_en_deposito: esDeposito, enviado_acumulado: nuevaAcum, cantidad_efectiva: efectiva },
            userId,
          })
        }

        // Compra a proveedor con destino depósito → cada envío (parcial o
        // total) ingresa SU cantidad al stock: el material llegó físicamente.
        // (Los despachos de_deposito ya descontaron stock al despachar.)
        if (updated && esDeposito && itemPrev.estado === 'comprado' && itemPrev.material_id) {
          const { data: mat } = await supabase
            .from('stock_materiales').select('stock_actual').eq('id', itemPrev.material_id).maybeSingle()
          if (mat) {
            await supabase
              .from('stock_materiales')
              .update({
                stock_actual: Number(mat.stock_actual) + aEnviar,
                ...(itemPrev.precio_unit != null ? { precio_ref: itemPrev.precio_unit } : {}),
                updated_by: userId,
              })
              .eq('id', itemPrev.material_id)
          }
          await supabase.from('stock_movimientos').insert({
            material_id:       itemPrev.material_id,
            tipo:              'entrada',
            cantidad:          aEnviar,
            motivo:            'compra',
            obra_cod:          dto.obra_cod,
            solicitud_item_id: itemId,
            fecha:             hoy,
            created_by:        userId,
          })
        }
      }

      // El remito quedó creado igual (es lo correcto: los renglones existen y el
      // papel ya se puede imprimir), pero el llamador tiene que enterarse de que
      // esos ítems no quedaron marcados como enviados.
      if (fallidos.length > 0) {
        throw new Error(
          `El remito ${remito.numero} se creó, pero ${fallidos.length} ítem(s) no se pudieron marcar como enviados: ${fallidos.join(' · ')}`,
        )
      }
    }

    return this.getById(remito.id, token)
  },
}
