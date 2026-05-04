import { z } from 'zod'

export const CreateLiquidacionSchema = z.object({
  chofer_id:            z.number(),
  fecha_desde:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_hasta:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dias_trabajados:      z.number().min(0),
  basico_dia:           z.number().min(0),
  km_totales:           z.number().min(0).optional().default(0),
  precio_km:            z.number().min(0).optional().default(0),
  subtotal_basico:      z.number(),
  subtotal_km:          z.number().optional().default(0),
  // Desglose nuevo (opcional para back-compat). Si se envían, se persisten
  // en las columnas dedicadas para auditar la tarifa diferencial cargado/vacío.
  subtotal_km_cargado:  z.number().optional().nullable(),
  subtotal_km_vacio:    z.number().optional().nullable(),
  total_adelantos:      z.number(),
  total_reintegros:     z.number().min(0).optional().default(0),
  total_neto:           z.number(),
  obs:                  z.string().optional().default(''),
  tramo_ids:            z.array(z.number()).optional().default([]),
  adelanto_ids:         z.array(z.number()).optional().default([]),
  gasto_ids:            z.array(z.number()).optional().default([]),
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
  chofer_id:         z.number(),
  fecha:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto:             z.number().min(0),
  descripcion:       z.string().optional().default(''),
  comprobante_path:  z.string().optional().nullable(),
})

export const UpdateAdelantoSchema = z.object({
  fecha:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  monto:             z.number().min(0).optional(),
  descripcion:       z.string().optional(),
  comprobante_path:  z.string().optional().nullable(),
})

export const UploadComprobanteAdelantoSchema = z.object({
  filename:     z.string().min(1).max(200),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  size_bytes:   z.number().int().positive().max(10 * 1024 * 1024),  // 10 MB
})

export type CreateLiquidacionDto = z.infer<typeof CreateLiquidacionSchema>
export type UpdateLiquidacionDto = z.infer<typeof UpdateLiquidacionSchema>
export type CreateAdelantoDto    = z.infer<typeof CreateAdelantoSchema>
export type UpdateAdelantoDto    = z.infer<typeof UpdateAdelantoSchema>
