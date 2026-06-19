import { z } from 'zod'

export const HsExtraSchema = z.object({
  id: z.number(),
  obra_cod: z.string(),
  leg: z.string(),
  sem_key: z.string(),
  hs: z.number(),
})

export const UpsertHsExtraSchema = z.object({
  obra_cod: z.string().min(1),
  leg: z.string().min(1),
  sem_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sem_key debe ser YYYY-MM-DD (viernes)'),
  hs: z.number().min(0),  // sin tope duro; el front avisa al cargar valores altos
})

export const UpsertHsExtrasLoteSchema = z.object({
  obra_cod: z.string().min(1),
  items: z.array(z.object({
    leg: z.string().min(1),
    sem_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sem_key debe ser YYYY-MM-DD (viernes)'),
    hs: z.number().min(0),  // sin tope duro; el front avisa al cargar valores altos
  })),
})

export type HsExtra = z.infer<typeof HsExtraSchema>
export type UpsertHsExtraDto = z.infer<typeof UpsertHsExtraSchema>
export type UpsertHsExtrasLoteDto = z.infer<typeof UpsertHsExtrasLoteSchema>
