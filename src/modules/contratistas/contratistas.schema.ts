import { z } from 'zod'

export const ContratistasSchema = z.object({
  id: z.number(),
  nom: z.string(),
  especialidad: z.string().nullable(),
  tel: z.string().nullable(),
  obs: z.string().nullable(),
  razon_social: z.string().nullable(),
  cuit: z.string().nullable(),
  cuil: z.string().nullable(),
  dni: z.string().nullable(),
})

export const CreateContratistaSchema = z.object({
  nom:          z.string().min(1, 'El nombre es requerido'),
  especialidad: z.string().nullable().optional(),
  tel:          z.string().nullable().optional(),
  obs:          z.string().nullable().optional(),
  razon_social: z.string().nullable().optional(),
  cuit:         z.string().nullable().optional(),
  cuil:         z.string().nullable().optional(),
  dni:          z.string().nullable().optional(),
})

export const UpdateContratistaSchema = z.object({
  nom:          z.string().min(1).optional(),
  especialidad: z.string().nullable().optional(),
  tel:          z.string().nullable().optional(),
  obs:          z.string().nullable().optional(),
  razon_social: z.string().nullable().optional(),
  cuit:         z.string().nullable().optional(),
  cuil:         z.string().nullable().optional(),
  dni:          z.string().nullable().optional(),
})

// ── DNI adjunto (bucket privado contratista-docs) ──
// Flujo de 2 pasos (igual que vehiculo-docs / seguro-poliza).
export const DniUploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

export const DniRegistrarSchema = z.object({
  storage_path:   z.string().min(1),
  nombre_archivo: z.string().min(1),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

export const AsigContratistaSchema = z.object({
  obra_cod: z.string().min(1),
  contrat_id: z.number(),
})

export const CertificacionSchema = z.object({
  obra_cod: z.string().min(1),
  contrat_id: z.number(),
  sem_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto: z.number().min(0),
  desc: z.string().optional().default(''),
  estado: z.enum(['pendiente', 'cerrado']).optional().default('pendiente'),
})

export type Contratista = z.infer<typeof ContratistasSchema>
export type CreateContratistaDto = z.infer<typeof CreateContratistaSchema>
export type UpdateContratistaDto = z.infer<typeof UpdateContratistaSchema>
export type DniUploadUrlDto = z.infer<typeof DniUploadUrlSchema>
export type DniRegistrarDto = z.infer<typeof DniRegistrarSchema>
export type AsigContratistaDto = z.infer<typeof AsigContratistaSchema>
export type CertificacionDto = z.infer<typeof CertificacionSchema>