import { z } from 'zod'

export const AsignacionSchema = z.object({
  obra_cod: z.string(),
  leg: z.string(),
  baja_desde: z.string().nullable(),
})

export const CreateAsignacionSchema = z.object({
  obra_cod: z.string().min(1),
  leg: z.string().min(1),
})

export const BajaAsignacionSchema = z.object({
  baja_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export type Asignacion = z.infer<typeof AsignacionSchema>
export type CreateAsignacionDto = z.infer<typeof CreateAsignacionSchema>
export type BajaAsignacionDto = z.infer<typeof BajaAsignacionSchema> 