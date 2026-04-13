import { z } from 'zod'

export const CreateTramoSchema = z.object({
  chofer_id:   z.number(),
  camion_id:   z.number(),
  fecha:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tipo:        z.enum(['carga', 'descarga']),
  cantera_id:  z.number().nullable().optional(),
  deposito_id: z.number().nullable().optional(),
  toneladas:   z.number().optional(),
  remito_num:  z.string().optional().default(''),
  obs:         z.string().optional().default(''),
})

export const UpdateTramoSchema = CreateTramoSchema.partial()

export type CreateTramoDto = z.infer<typeof CreateTramoSchema>
export type UpdateTramoDto = z.infer<typeof UpdateTramoSchema>
