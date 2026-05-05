import { z } from 'zod'

export const GeocodeSchema = z.object({
  direccion: z.string().min(2).max(300),
})

export type GeocodeDto = z.infer<typeof GeocodeSchema>
