import { z } from 'zod'

const RemitoItemSchema = z.object({
  item_id:     z.number().int().positive().nullable().optional(),
  descripcion: z.string().min(1),
  cantidad:    z.number().min(0),
  unidad:      z.string(),
  precio_unit: z.number().min(0).nullable().optional(),
  origen:      z.string().default('deposito'),
  proveedor:   z.string().nullable().optional(),
})

export const CreateRemitoEnvioSchema = z.object({
  obra_cod:     z.string().min(1),
  solicitud_id: z.number().int().positive().nullable().optional(),
  origen:       z.string().default('deposito'),
  obs:          z.string().nullable().optional().default(null),
  items:        z.array(RemitoItemSchema).min(1),
  // IDs de ítems de solicitud a marcar como enviados
  enviar_items: z.array(z.number().int().positive()).optional(),
})

export type CreateRemitoEnvioDto = z.infer<typeof CreateRemitoEnvioSchema>
