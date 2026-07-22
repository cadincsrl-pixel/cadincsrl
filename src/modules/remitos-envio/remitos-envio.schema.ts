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
  // Ítems de solicitud a enviar con este remito. Con `cantidad` se soportan
  // ENVÍOS PARCIALES (2026-07-22): el item acumula cantidad_enviada y pasa a
  // 'enviado' recién cuando cubre la cantidad efectiva; mientras tanto sigue
  // "por enviar" con el pendiente. Se acepta el shape viejo (number[]) por
  // compat: number solo = enviar el pendiente completo.
  enviar_items: z.array(z.union([
    z.number().int().positive(),
    z.object({
      item_id:  z.number().int().positive(),
      cantidad: z.number().positive(),
    }),
  ])).optional(),
})

export type CreateRemitoEnvioDto = z.infer<typeof CreateRemitoEnvioSchema>
