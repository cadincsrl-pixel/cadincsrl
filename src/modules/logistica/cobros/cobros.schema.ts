import { z } from 'zod'

export const CreateCobroSchema = z.object({
  empresa_id:        z.number(),
  fecha_desde:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_hasta:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toneladas_totales: z.number(),
  total:             z.number(),
  obs:               z.string().optional().default(''),
  tramo_ids:         z.array(z.number()).optional().default([]),
})

export type CreateCobroDto = z.infer<typeof CreateCobroSchema>
