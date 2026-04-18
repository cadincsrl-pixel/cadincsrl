import { z } from 'zod'

const ItemSchema = z.object({
  descripcion: z.string().min(1),
  cantidad:    z.number().min(0).default(1),
  unidad:      z.string().default('unid'),
  obs:         z.string().nullable().optional().default(null),
})

export const CreateSolicitudSchema = z.object({
  obra_cod:  z.string().min(1),
  prioridad: z.enum(['normal', 'urgente']).default('normal'),
  obs:       z.string().nullable().optional().default(null),
  items:     z.array(ItemSchema).min(1),
})

export const UpdateSolicitudSchema = z.object({
  estado:       z.enum(['pendiente', 'aprobada', 'rechazada', 'enviada', 'recibida']).optional(),
  prioridad:    z.enum(['normal', 'urgente']).optional(),
  obs:          z.string().nullable().optional(),
  fecha_envio:  z.string().nullable().optional(),
})

export type CreateSolicitudDto = z.infer<typeof CreateSolicitudSchema>
export type UpdateSolicitudDto = z.infer<typeof UpdateSolicitudSchema>
