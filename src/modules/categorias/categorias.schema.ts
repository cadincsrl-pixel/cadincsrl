import { z } from 'zod'
import { esViernes } from '../../lib/semanas.js'

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
  desde: z.iso.date('desde debe ser YYYY-MM-DD').refine(esViernes, 'desde tiene que ser un viernes').optional(),
  // true = el usuario ya confirmó que el precio recalcula semanas cerradas.
  confirmar_historico: z.boolean().optional(),
})

export type Categoria = z.infer<typeof CategoriaSchema>
export type CreateCategoriaDto = z.infer<typeof CreateCategoriaSchema>
export type UpdateCategoriaDto = z.infer<typeof UpdateCategoriaSchema>