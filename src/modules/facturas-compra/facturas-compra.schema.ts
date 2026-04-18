import { z } from 'zod'

export const CreateFacturaSchema = z.object({
  proveedor_id:   z.number().int().positive(),
  numero:         z.string().optional().default(''),
  fecha:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adjunto_url:    z.string().optional().default(''),
  adjunto_nombre: z.string().optional().default(''),
  total:          z.number().min(0).optional().default(0),
  obs:            z.string().optional().default(''),
})

export const UpdateFacturaSchema = CreateFacturaSchema.partial()

export type CreateFacturaDto = z.infer<typeof CreateFacturaSchema>
export type UpdateFacturaDto = z.infer<typeof UpdateFacturaSchema>
