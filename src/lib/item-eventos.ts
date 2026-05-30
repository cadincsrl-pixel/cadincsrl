import type { SupabaseClient } from '@supabase/supabase-js'

// Registro de transiciones de estado de un ítem de solicitud de compra.
// Tabla: solicitud_item_eventos (append-only). Es la fuente de verdad de la
// traza del ciclo de vida del ítem — el audit_log genérico no captura
// estado_anterior -> estado_nuevo ni la cantidad/comentario.

export type RegistrarItemEventoArgs = {
  itemId:          number
  solicitudId?:    number | null
  accion:          string            // 'creado','comprado','despachado','en_proveedor','retirado','retiro_parcial','enviado','rechazado','revertido','envio_revertido'
  estadoAnterior?: string | null
  estadoNuevo:     string
  cantidad?:       number | null
  comentario?:     string | null
  meta?:           Record<string, unknown> | null
  userId?:         string | null
}

// Inserta un evento. BEST-EFFORT: si falla, NO propaga el error — la traza no
// debe tumbar la operación de negocio (compra/despacho/envío). Solo loguea.
// Cuando se consoliden las RPCs (USE_RPC_RESOLVER), estas escrituras se moverán
// adentro de las funciones para que sean atómicas con el cambio de estado.
export async function registrarItemEvento(
  sb: SupabaseClient,
  e: RegistrarItemEventoArgs,
): Promise<void> {
  const { error } = await sb.from('solicitud_item_eventos').insert({
    item_id:         e.itemId,
    solicitud_id:    e.solicitudId ?? null,
    accion:          e.accion,
    estado_anterior: e.estadoAnterior ?? null,
    estado_nuevo:    e.estadoNuevo,
    cantidad:        e.cantidad ?? null,
    comentario:      e.comentario ?? null,
    meta:            e.meta ?? null,
    user_id:         e.userId ?? null,
  })
  if (error) {
    console.error(`[item-eventos] fallo al registrar "${e.accion}" item=${e.itemId}: ${error.message}`)
  }
}
