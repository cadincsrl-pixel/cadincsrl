import { z } from 'zod'

export const GeocodeSchema = z.object({
  direccion: z.string().min(2).max(300),
})

export type GeocodeDto = z.infer<typeof GeocodeSchema>

export const ResolverMapsUrlSchema = z.object({
  url: z.string().min(10).max(2000),
})

export type ResolverMapsUrlDto = z.infer<typeof ResolverMapsUrlSchema>
