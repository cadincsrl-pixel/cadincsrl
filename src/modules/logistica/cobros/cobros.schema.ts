import { z } from 'zod'

export const CreateCobroSchema = z.object({
  empresa_id:        z.number().int().positive(),
  fecha_desde:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_hasta:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toneladas_totales: z.number().nonnegative(),
  total:             z.number().nonnegative(),
  obs:               z.string().optional().default(''),
  // Factura emitida por CADINC — obligatorios (validado en el service) cuando
  // la empresa tiene modalidad_cobro='facturacion'; ignorados para el resto.
  factura_nro:       z.string().max(50).optional(),
  factura_fecha:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tramo_ids:         z.array(z.number().int().positive()).optional().default([]),
}).refine(d => d.fecha_desde <= d.fecha_hasta, {
  message: 'fecha_desde debe ser <= fecha_hasta',
  path: ['fecha_hasta'],
})

export type CreateCobroDto = z.infer<typeof CreateCobroSchema>
