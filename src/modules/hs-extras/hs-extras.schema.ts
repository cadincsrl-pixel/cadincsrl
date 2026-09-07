import { z } from 'zod'
import { esViernes } from '../../lib/semanas.js'

// sem_key = viernes de la semana (§5.3). Un lunes creaba una "semana fantasma"
// que no cuadraba con ninguna tarja.
const SemKeySchema = z.iso.date('sem_key debe ser YYYY-MM-DD').refine(esViernes, 'sem_key tiene que ser el viernes de la semana')

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
  sem_key: SemKeySchema,
  hs: z.number().min(0),  // sin tope duro; el front avisa al cargar valores altos
})

export const UpsertHsExtrasLoteSchema = z.object({
  obra_cod: z.string().min(1),
  items: z.array(z.object({
    leg: z.string().min(1),
    sem_key: SemKeySchema,
    hs: z.number().min(0),  // sin tope duro; el front avisa al cargar valores altos
  })),
})

export type HsExtra = z.infer<typeof HsExtraSchema>
export type UpsertHsExtraDto = z.infer<typeof UpsertHsExtraSchema>
export type UpsertHsExtrasLoteDto = z.infer<typeof UpsertHsExtrasLoteSchema>
