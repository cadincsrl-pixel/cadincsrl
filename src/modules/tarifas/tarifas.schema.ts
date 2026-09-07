import { z } from 'zod'
import { esViernes } from '../../lib/semanas.js'

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
  // Vigencia: viernes de la semana desde la que rige (§5.3).
  desde: z.iso.date('desde debe ser YYYY-MM-DD').refine(esViernes, 'desde tiene que ser un viernes').optional(),
  // true = el usuario ya confirmó que el cambio recalcula semanas cerradas.
  confirmar_historico: z.boolean().optional(),
})

export type Tarifa = z.infer<typeof TarifaSchema>
export type CreateTarifaDto = z.infer<typeof CreateTarifaSchema>