import { z } from 'zod'

export const ContratistasSchema = z.object({
  id: z.number(),
  nom: z.string(),
  especialidad: z.string().nullable(),
  tel: z.string().nullable(),
  obs: z.string().nullable(),
})

export const CreateContratistaSchema = z.object({
  nom: z.string().min(1, 'El nombre es requerido'),
  especialidad: z.string().optional().default(''),
  tel: z.string().optional().default(''),
  obs: z.string().optional().default(''),
})

export const UpdateContratistaSchema = z.object({
  nom: z.string().min(1).optional(),
  especialidad: z.string().optional(),
  tel: z.string().optional(),
  obs: z.string().optional(),
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
export type AsigContratistaDto = z.infer<typeof AsigContratistaSchema>
export type CertificacionDto = z.infer<typeof CertificacionSchema>