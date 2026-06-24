import { z } from 'zod'

const MEDIOS = ['efectivo', 'transferencia', 'cheque', 'otro'] as const

// Cobro (pago) del cliente a cuenta de la obra. No imputa a ítems puntuales.
export const CrearCobroSchema = z.object({
  obra_cod: z.string().min(1),
  fecha:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto:    z.number().positive(),
  medio:    z.enum(MEDIOS).default('efectivo'),
  obs:      z.string().optional().nullable(),
})

// No usar .partial() del create: arrastra el .default() de `medio` y pisaría
// el valor existente en updates parciales.
export const EditarCobroSchema = z.object({
  fecha:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  monto:  z.number().positive().optional(),
  medio:  z.enum(MEDIOS).optional(),
  obs:    z.string().optional().nullable(),
})

export type CrearCobroDto  = z.infer<typeof CrearCobroSchema>
export type EditarCobroDto = z.infer<typeof EditarCobroSchema>
