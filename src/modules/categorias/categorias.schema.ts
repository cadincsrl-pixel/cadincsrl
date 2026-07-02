import { z } from 'zod'

export const CategoriaSchema = z.object({
  id: z.number(),
  nom: z.string(),
  vh: z.number(),
})

export const CreateCategoriaSchema = z.object({
  nom: z.string().min(1, 'El nombre es requerido'),
  vh: z.number().min(0, 'El valor hora no puede ser negativo'),
})

export const UpdateCategoriaSchema = z.object({
  nom: z.string().min(1).optional(),
  vh: z.number().min(0).optional(),
  // Vigencia de la nueva versión de precio (YYYY-MM-DD, viernes de semana).
  // Solo aplica si viene `vh`; sin `desde`, el service usa hoy.
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export type Categoria = z.infer<typeof CategoriaSchema>
export type CreateCategoriaDto = z.infer<typeof CreateCategoriaSchema>
export type UpdateCategoriaDto = z.infer<typeof UpdateCategoriaSchema>