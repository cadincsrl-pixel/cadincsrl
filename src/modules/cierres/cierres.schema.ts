import { z } from 'zod'
import { esViernes } from '../../lib/semanas.js'

export const CierreSchema = z.object({
  id: z.number(),
  obra_cod: z.string(),
  sem_key: z.string(),
  estado: z.enum(['pendiente', 'cerrado']),
  cerrado_en: z.string().nullable(),
})

export const CreateCierreSchema = z.object({
  obra_cod: z.string().min(1),
  sem_key: z.iso.date('sem_key debe ser YYYY-MM-DD').refine(esViernes, 'sem_key tiene que ser el viernes de la semana'),
  // Opcional: estado inicial. Por default se crea como 'pendiente'. Pasar
  // 'cerrado' permite cerrar en un solo request (útil cuando el user acciona
  // "cerrar ahora" sobre una semana que todavía no tiene row).
  estado: z.enum(['pendiente', 'cerrado']).optional(),
})

export const UpdateCierreSchema = z.object({
  estado: z.enum(['pendiente', 'cerrado']),
})

export type Cierre = z.infer<typeof CierreSchema>
export type CreateCierreDto = z.infer<typeof CreateCierreSchema>
export type UpdateCierreDto = z.infer<typeof UpdateCierreSchema>