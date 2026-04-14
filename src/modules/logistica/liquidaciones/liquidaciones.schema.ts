import { z } from 'zod'

export const CreateLiquidacionSchema = z.object({
  chofer_id:       z.number(),
  fecha_desde:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_hasta:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dias_trabajados: z.number().min(0),
  basico_dia:      z.number().min(0),
  subtotal_basico: z.number(),
  total_adelantos: z.number(),
  total_neto:      z.number(),
  obs:             z.string().optional().default(''),
  tramo_ids:       z.array(z.number()).optional().default([]),
  adelanto_ids:    z.array(z.number()).optional().default([]),
})

export const UpdateLiquidacionSchema = z.object({
  fecha_desde:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fecha_hasta:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  basico_dia:      z.number().min(0).optional(),
  dias_trabajados: z.number().min(0).optional(),
  subtotal_basico: z.number().optional(),
  total_adelantos: z.number().optional(),
  total_neto:      z.number().optional(),
  obs:             z.string().optional(),
})

export const CreateAdelantoSchema = z.object({
  chofer_id:    z.number(),
  fecha:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto:        z.number().min(0),
  descripcion:  z.string().optional().default(''),
})

export const UpdateAdelantoSchema = z.object({
  fecha:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  monto:       z.number().min(0).optional(),
  descripcion: z.string().optional(),
})

export type CreateLiquidacionDto = z.infer<typeof CreateLiquidacionSchema>
export type UpdateLiquidacionDto = z.infer<typeof UpdateLiquidacionSchema>
export type CreateAdelantoDto    = z.infer<typeof CreateAdelantoSchema>
export type UpdateAdelantoDto    = z.infer<typeof UpdateAdelantoSchema>
