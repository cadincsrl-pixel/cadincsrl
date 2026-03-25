import { z } from 'zod'

export const HoraSchema = z.object({
  id: z.number(),
  obra_cod: z.string(),
  fecha: z.string(),
  leg: z.string(),
  horas: z.number(),
})

export const UpsertHoraSchema = z.object({
  obra_cod: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido, usar YYYY-MM-DD'),
  leg: z.string().min(1),
  horas: z.number().min(0).max(24),
})

export const UpsertHorasLoteSchema = z.object({
  obra_cod: z.string().min(1),
  horas: z.array(z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    leg: z.string().min(1),
    horas: z.number().min(0).max(24),
  })),
})

export type Hora = z.infer<typeof HoraSchema>
export type UpsertHoraDto = z.infer<typeof UpsertHoraSchema>
export type UpsertHorasLoteDto = z.infer<typeof UpsertHorasLoteSchema>