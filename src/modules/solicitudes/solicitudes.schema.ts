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

const UpdateItemSchema = z.object({
  id:          z.number().int().positive().optional(), // si tiene id, es update; si no, es nuevo
  descripcion: z.string().min(1),
  cantidad:    z.number().min(0).default(1),
  unidad:      z.string().default('unid'),
  obs:         z.string().nullable().optional().default(null),
  material_id: z.number().int().positive().nullable().optional().default(null),
})

export const UpdateSolicitudSchema = z.object({
  estado:       z.enum(['pendiente', 'aprobada', 'rechazada']).optional(),
  prioridad:    z.enum(['normal', 'urgente']).optional(),
  obs:          z.string().nullable().optional(),
  obra_cod:     z.string().min(1).optional(),
  items:        z.array(UpdateItemSchema).optional(), // si se envía, reemplaza ítems pendientes
  remove_items: z.array(z.number().int().positive()).optional(), // IDs de ítems a eliminar
})

// Resolver ítem: comprar a proveedor
export const ComprarItemSchema = z.object({
  proveedor_id: z.number().int().positive(),
  precio_unit:  z.number().min(0),
  factura_id:   z.number().int().positive().nullable().optional(),
})

// Resolver ítem: despachar de depósito
export const DespacharItemSchema = z.object({
  precio_unit:        z.number().min(0),
  // Flag para forzar el despacho cuando no hay stock suficiente.
  // Requiere permiso extra `certificaciones.forzar_despacho` — lo valida
  // el handler del route. El service NO lee este campo del dto: el route
  // lo extrae, lo valida y lo pasa como argumento explícito a
  // `solicitudesService.despacharItem(..., forzarSinStock)`.
  forzar_sin_stock:   z.boolean().optional(),
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
