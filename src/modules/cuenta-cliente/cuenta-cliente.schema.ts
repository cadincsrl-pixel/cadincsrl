import { z } from 'zod'

const MEDIOS = ['efectivo', 'transferencia', 'cheque', 'otro'] as const

// Cobro (pago) del cliente a cuenta de la obra. Puede imputar items del MCC
// (patrón simple, como alquiler/áridos: cada item se paga ENTERO por UN cobro;
// item_ids vacío = pago a cuenta sin imputar).
export const CrearCobroSchema = z.object({
  obra_cod: z.string().min(1),
  fecha:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto:    z.number().positive(),
  medio:    z.enum(MEDIOS).default('efectivo'),
  obs:      z.string().optional().nullable(),
  // Filas de materiales_a_cuenta_cliente que este pago cubre.
  item_ids: z.array(z.number().int().positive()).max(500).optional().default([]),
  // Path del comprobante ya subido al bucket con la signed URL (2 pasos).
  comprobante_path: z.string().optional().nullable(),
})

export const UploadComprobanteCobroSchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
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
