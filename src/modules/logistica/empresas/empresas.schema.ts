import { z } from 'zod'

export const CreateEmpresaSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  cuit:   z.string().optional().default(''),
  tel:    z.string().optional().default(''),
  email:  z.string().optional().default(''),
  obs:    z.string().optional().default(''),
  estado: z.enum(['activa', 'inactiva']).default('activa'),
})

// No usar .partial() sobre el create: arrastra los .default() y zod
// inyecta valores por defecto en updates parciales, pisando datos válidos.
export const UpdateEmpresaSchema = z.object({
  nombre: z.string().min(1).optional(),
  cuit:   z.string().optional(),
  tel:    z.string().optional(),
  email:  z.string().optional(),
  obs:    z.string().optional(),
  estado: z.enum(['activa', 'inactiva']).optional(),
})

export const CreateTarifaEmpresaSchema = z.object({
  empresa_id:    z.number(),
  cantera_id:    z.number(),
  valor_ton:     z.number().min(0),
  vigente_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  obs:           z.string().optional().default(''),
})

// Update solo permite cambiar valor/fecha/obs. La identidad
// (empresa+cantera) es la del registro y se mantiene; si se quiere cambiar
// el par, se elimina y se crea una nueva.
export const UpdateTarifaEmpresaSchema = z.object({
  valor_ton:     z.number().min(0).optional(),
  vigente_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obs:           z.string().optional(),
})

export type CreateEmpresaDto       = z.infer<typeof CreateEmpresaSchema>
export type UpdateEmpresaDto       = z.infer<typeof UpdateEmpresaSchema>
export type CreateTarifaEmpresaDto = z.infer<typeof CreateTarifaEmpresaSchema>
export type UpdateTarifaEmpresaDto = z.infer<typeof UpdateTarifaEmpresaSchema>
