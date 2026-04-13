import { z } from 'zod'

export const CreateEmpresaSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  cuit:   z.string().optional().default(''),
  tel:    z.string().optional().default(''),
  email:  z.string().optional().default(''),
  obs:    z.string().optional().default(''),
  estado: z.enum(['activa', 'inactiva']).default('activa'),
})

export const UpdateEmpresaSchema = CreateEmpresaSchema.partial()

export const UpsertTarifaEmpresaSchema = z.object({
  empresa_id: z.number(),
  cantera_id: z.number(),
  valor_ton:  z.number().min(0),
  obs:        z.string().optional().default(''),
})

export type CreateEmpresaDto        = z.infer<typeof CreateEmpresaSchema>
export type UpdateEmpresaDto        = z.infer<typeof UpdateEmpresaSchema>
export type UpsertTarifaEmpresaDto  = z.infer<typeof UpsertTarifaEmpresaSchema>
