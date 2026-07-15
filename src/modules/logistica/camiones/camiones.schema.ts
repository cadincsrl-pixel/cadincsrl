import { z } from 'zod'

export const CreateCamionSchema = z.object({
  patente:     z.string().min(1, 'La patente es requerida'),
  modelo:      z.string().optional().default(''),
  anio:        z.number().optional(),
  estado:      z.enum(['activo', 'mantenimiento', 'inactivo']).default('activo'),
  // tractor = arrastra batea/semirremolque; chasis = caja fija. Discrimina
  // la tarifa por tipo de unidad en facturación.
  categoria:   z.enum(['tractor', 'chasis']).default('tractor'),
  obs:         z.string().optional().default(''),
  km_actuales: z.number().min(0).optional(),
})

// No usar .partial() sobre el create: arrastra los .default() y zod
// inyecta valores por defecto en updates parciales, pisando datos válidos.
export const UpdateCamionSchema = z.object({
  patente:     z.string().min(1).optional(),
  modelo:      z.string().optional(),
  anio:        z.number().optional(),
  estado:      z.enum(['activo', 'mantenimiento', 'inactivo']).optional(),
  categoria:   z.enum(['tractor', 'chasis']).optional(),
  obs:         z.string().optional(),
  km_actuales: z.number().min(0).optional(),
})

export type CreateCamionDto = z.infer<typeof CreateCamionSchema>
export type UpdateCamionDto = z.infer<typeof UpdateCamionSchema>