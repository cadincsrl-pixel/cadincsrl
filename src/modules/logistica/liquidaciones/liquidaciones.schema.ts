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

export const CreateAdelantoSchema = z.object({
  chofer_id:    z.number(),
  fecha:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto:        z.number().min(0),
  descripcion:  z.string().optional().default(''),
})

export type CreateLiquidacionDto = z.infer<typeof CreateLiquidacionSchema>
export type CreateAdelantoDto    = z.infer<typeof CreateAdelantoSchema>
