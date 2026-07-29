import { z } from 'zod'

export const CreateCubiertasSchema = z.object({
  camion_id: z.number().int().positive(),
  fecha:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  km_camion: z.number().min(0),
  cantidad:  z.number().int().positive(),
  obs:       z.string().optional().nullable(),
})

export const UpdateCubiertasSchema = z.object({
  fecha:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  km_camion: z.number().min(0).optional(),
  cantidad:  z.number().int().positive().optional(),
  obs:       z.string().optional().nullable(),
})

export type CreateCubiertasDto = z.infer<typeof CreateCubiertasSchema>
export type UpdateCubiertasDto = z.infer<typeof UpdateCubiertasSchema>
