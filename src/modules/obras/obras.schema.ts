import { z } from 'zod'

export const ObraSchema = z.object({
  cod: z.string(),
  nom: z.string(),
  cc: z.string().nullable(),
  dir: z.string().nullable(),
  resp: z.string().nullable(),
  obs: z.string().nullable(),
  archivada: z.boolean().default(false),
  fecha_archivo: z.string().nullable(),
})

export const CreateObraSchema = z.object({
  cod: z.string().min(1, 'El código es requerido'),
  nom: z.string().min(1, 'El nombre es requerido'),
  cc: z.string().optional().default(''),
  dir: z.string().optional().default(''),
  resp: z.string().optional().default(''),
  obs: z.string().optional().default(''),
})

export const UpdateObraSchema = z.object({
  nom: z.string().min(1).optional(),
  cc: z.string().optional(),
  dir: z.string().optional(),
  resp: z.string().optional(),
  obs: z.string().optional(),
})

export type Obra = z.infer<typeof ObraSchema>
export type CreateObraDto = z.infer<typeof CreateObraSchema>
export type UpdateObraDto = z.infer<typeof UpdateObraSchema>