import { z } from 'zod'

export const CreateMovimientoSchema = z.object({
  fecha:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  centro_costo: z.string().optional(),
  proveedor:    z.string().optional(),
  concepto:     z.string().min(1),
  detalle:      z.string().optional(),
  tipo:         z.enum(['ingreso', 'egreso']),
  monto:        z.number().positive(),
  es_ajuste:    z.boolean().optional().default(false),
})

export const UpdateMovimientoSchema = z.object({
  fecha:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  centro_costo: z.string().optional(),
  proveedor:    z.string().optional(),
  concepto:     z.string().min(1).optional(),
  detalle:      z.string().optional(),
  tipo:         z.enum(['ingreso', 'egreso']).optional(),
  monto:        z.number().positive().optional(),
})

export const CreateConceptoSchema = z.object({
  nombre: z.string().min(1),
  tipo:   z.enum(['ingreso', 'egreso', 'ambos']).default('ambos'),
})

export const ToggleActivoSchema = z.object({
  activo: z.boolean(),
})

export const CreateCentroSchema = z.object({
  nombre: z.string().min(1),
})

export type CreateMovimientoDto = z.infer<typeof CreateMovimientoSchema>
export type UpdateMovimientoDto = z.infer<typeof UpdateMovimientoSchema>
