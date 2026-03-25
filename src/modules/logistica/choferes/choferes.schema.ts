import { z } from 'zod'

export const CreateChoferSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  dni:    z.string().optional().default(''),
  tel:    z.string().optional().default(''),
  licencia: z.string().optional().default(''),
  estado: z.enum(['activo', 'descanso', 'inactivo']).default('activo'),
  obs:    z.string().optional().default(''),
})

export const UpdateChoferSchema = CreateChoferSchema.partial()

export type CreateChoferDto = z.infer<typeof CreateChoferSchema>
export type UpdateChoferDto = z.infer<typeof UpdateChoferSchema>