import { z } from 'zod'

const ItemSchema = z.object({
  descripcion: z.string().min(1),
  cantidad:    z.number().min(0).default(1),
  unidad:      z.string().default('unid'),
  obs:         z.string().nullable().optional().default(null),
  material_id: z.number().int().positive().nullable().optional().default(null),
})

export const CreateSolicitudSchema = z.object({
  obra_cod:  z.string().min(1),
  prioridad: z.enum(['normal', 'urgente']).default('normal'),
  obs:       z.string().nullable().optional().default(null),
  items:     z.array(ItemSchema).min(1),
})

// Solo aprobación a nivel solicitud
export const UpdateSolicitudSchema = z.object({
  estado:    z.enum(['pendiente', 'aprobada', 'rechazada']).optional(),
  prioridad: z.enum(['normal', 'urgente']).optional(),
  obs:       z.string().nullable().optional(),
})

// Resolver ítem: comprar a proveedor
export const ComprarItemSchema = z.object({
  proveedor_id: z.number().int().positive(),
  precio_unit:  z.number().min(0),
  factura_id:   z.number().int().positive().nullable().optional(),
})

// Resolver ítem: despachar de depósito
export const DespacharItemSchema = z.object({
  precio_unit: z.number().min(0),
})

// Enviar ítem
export const EnviarItemSchema = z.object({
  fecha_envio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

// Editar ítem resuelto (corregir precio/proveedor)
export const EditarItemSchema = z.object({
  proveedor_id: z.number().int().positive().optional(),
  precio_unit:  z.number().min(0).optional(),
  factura_id:   z.number().int().positive().nullable().optional(),
})

export type CreateSolicitudDto = z.infer<typeof CreateSolicitudSchema>
export type UpdateSolicitudDto = z.infer<typeof UpdateSolicitudSchema>
export type ComprarItemDto     = z.infer<typeof ComprarItemSchema>
export type DespacharItemDto   = z.infer<typeof DespacharItemSchema>
export type EnviarItemDto      = z.infer<typeof EnviarItemSchema>
export type EditarItemDto      = z.infer<typeof EditarItemSchema>
