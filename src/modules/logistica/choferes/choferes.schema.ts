import { z } from 'zod'

export const CreateChoferSchema = z.object({
  nombre:    z.string().min(1, 'El nombre es requerido'),
  cuil:      z.string().optional().default(''),
  tel:       z.string().optional().default(''),
  licencia:  z.string().optional().default(''),
  estado:    z.enum(['activo', 'descanso', 'inactivo']).default('activo'),
  camion_id: z.number().nullable().optional(),
  batea_id:  z.number().nullable().optional(),
  basico_dia:        z.number().optional().default(0),
  precio_km_cargado: z.number().optional().default(0),
  precio_km_vacio:   z.number().optional().default(0),
  obs:               z.string().optional().default(''),
})

// Update: NO usar .partial() sobre el create porque arrastra los .default('')
// y zod inyecta valores vacíos cuando el cliente manda un PATCH parcial,
// pisando datos válidos en la DB (bug que vació cuiles/tel/licencia/obs).
export const UpdateChoferSchema = z.object({
  nombre:    z.string().min(1).optional(),
  cuil:      z.string().optional(),
  tel:       z.string().optional(),
  licencia:  z.string().optional(),
  estado:    z.enum(['activo', 'descanso', 'inactivo']).optional(),
  camion_id: z.number().nullable().optional(),
  batea_id:  z.number().nullable().optional(),
  basico_dia:        z.number().optional(),
  precio_km_cargado: z.number().optional(),
  precio_km_vacio:   z.number().optional(),
  obs:               z.string().optional(),
})

export type CreateChoferDto = z.infer<typeof CreateChoferSchema>
export type UpdateChoferDto = z.infer<typeof UpdateChoferSchema>