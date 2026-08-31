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
  horas: z.number().min(0),
})

export const UpsertHorasLoteSchema = z.object({
  obra_cod: z.string().min(1),
  horas: z.array(z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    leg: z.string().min(1),
    horas: z.number().min(0),
  })),
  // true = el lote son PLACEHOLDERS (0hs para poblar la semana): inserta solo
  // filas nuevas y NUNCA pisa una existente (ignoreDuplicates). Cierra la
  // carrera copia-de-semana vs. carga de celda: sin esto, un 0 del lote podía
  // sobreescribir horas reales tipeadas entre el GET y el PUT de la copia.
  solo_nuevas: z.boolean().optional(),
})

export type Hora = z.infer<typeof HoraSchema>
export type UpsertHoraDto = z.infer<typeof UpsertHoraSchema>
export type UpsertHorasLoteDto = z.infer<typeof UpsertHorasLoteSchema>