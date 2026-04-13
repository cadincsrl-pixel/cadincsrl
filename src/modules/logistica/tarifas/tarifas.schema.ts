import { z } from 'zod'

export const UpsertTarifaCanteraSchema = z.object({
  cantera_id: z.number(),
  valor_ton:  z.number().min(0),
  obs:        z.string().optional().default(''),
})

export type UpsertTarifaCanteraDto = z.infer<typeof UpsertTarifaCanteraSchema>
