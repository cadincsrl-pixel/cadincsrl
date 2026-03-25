import { z } from 'zod'

export const TarifaSchema = z.object({
  id: z.number(),
  obra_cod: z.string(),
  cat_id: z.number(),
  vh: z.number(),
  desde: z.string(),
})

export const CreateTarifaSchema = z.object({
  obra_cod: z.string().min(1),
  cat_id: z.number(),
  vh: z.number().min(0),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export type Tarifa = z.infer<typeof TarifaSchema>
export type CreateTarifaDto = z.infer<typeof CreateTarifaSchema>