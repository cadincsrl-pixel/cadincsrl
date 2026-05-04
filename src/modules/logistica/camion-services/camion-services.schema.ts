import { z } from 'zod'

export const CreateServiceSchema = z.object({
  camion_id:        z.number().int().positive(),
  fecha:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  km_service:       z.number().min(0),
  km_proximo:       z.number().min(0),
  obs:              z.string().optional().nullable(),
  comprobante_path: z.string().optional().nullable(),
}).refine(d => d.km_proximo > d.km_service, {
  message: 'km_proximo debe ser mayor que km_service',
  path: ['km_proximo'],
})

export const UpdateServiceSchema = z.object({
  fecha:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  km_service:       z.number().min(0).optional(),
  km_proximo:       z.number().min(0).optional(),
  obs:              z.string().optional().nullable(),
  comprobante_path: z.string().optional().nullable(),
})

export const UploadComprobanteSchema = z.object({
  camion_id:    z.number().int().positive(),
  filename:     z.string().min(1).max(200),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  size_bytes:   z.number().int().positive().max(10 * 1024 * 1024),
})

export type CreateServiceDto      = z.infer<typeof CreateServiceSchema>
export type UpdateServiceDto      = z.infer<typeof UpdateServiceSchema>
export type UploadComprobanteDto  = z.infer<typeof UploadComprobanteSchema>
