import { z } from 'zod'

export const CreateProveedorSchema = z.object({
  nombre: z.string().min(1),
  cuit:   z.string().optional().default(''),
  tel:    z.string().optional().default(''),
  email:  z.string().optional().default(''),
  obs:    z.string().optional().default(''),
})

export const UpdateProveedorSchema = CreateProveedorSchema.partial()

export type CreateProveedorDto = z.infer<typeof CreateProveedorSchema>
export type UpdateProveedorDto = z.infer<typeof UpdateProveedorSchema>
