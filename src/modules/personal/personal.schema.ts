import { z } from 'zod'

export const PersonalSchema = z.object({
  leg: z.string(),
  nom: z.string(),
  dni: z.string().nullable(),
  cat_id: z.number(),
  tel: z.string().nullable(),
  dir: z.string().nullable(),
  obs: z.string().nullable(),
})

export const CreatePersonalSchema = z.object({
  leg: z.string().min(1, 'El legajo es requerido'),
  nom: z.string().min(1, 'El nombre es requerido'),
  dni: z.string().optional().default(''),
  condicion: z.enum(['blanco', 'asegurado']).optional(),
  cat_id: z.number({ error: 'La categoría es requerida' }),
  tel: z.string().optional().default(''),
  dir: z.string().optional().default(''),
  obs: z.string().optional().default(''),
})

export const UpdatePersonalSchema = z.object({
  nom:             z.string().min(1).optional(),
  dni:             z.string().optional(),
  condicion:       z.enum(['blanco', 'asegurado']).nullable().optional(),
  cat_id:          z.number().optional(),
  tel:             z.string().optional(),
  dir:             z.string().optional(),
  obs:             z.string().optional(),
  talle_pantalon:  z.string().optional(),
  talle_botines:   z.string().optional(),
  talle_camisa:    z.string().optional(),
  activo_override: z.boolean().nullable().optional(),
})

export type Personal = z.infer<typeof PersonalSchema>
export type CreatePersonalDto = z.infer<typeof CreatePersonalSchema>
export type UpdatePersonalDto = z.infer<typeof UpdatePersonalSchema>