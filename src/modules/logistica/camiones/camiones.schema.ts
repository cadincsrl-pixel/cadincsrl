import { z } from 'zod'

export const CreateCamionSchema = z.object({
  patente: z.string().min(1, 'La patente es requerida'),
  modelo:  z.string().optional().default(''),
  anio:    z.number().optional(),
  estado:  z.enum(['activo', 'mantenimiento', 'inactivo']).default('activo'),
  obs:     z.string().optional().default(''),
})

export const UpdateCamionSchema = CreateCamionSchema.partial()

export type CreateCamionDto = z.infer<typeof CreateCamionSchema>
export type UpdateCamionDto = z.infer<typeof UpdateCamionSchema>