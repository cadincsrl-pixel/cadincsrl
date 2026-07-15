import { z } from 'zod'

// Tipo de remolque (vocabulario real de la flota; unificado 2026-07-15).
const TipoEnum   = z.enum(['batea','acoplado','semirremolque','sider','tanque_cisterna','otro'])
const EstadoEnum = z.enum(['activo','mantenimiento','inactivo'])

export const CreateBateaSchema = z.object({
  patente:      z.string().min(1),
  tipo:         TipoEnum.optional(),
  marca:        z.string().optional().nullable(),
  modelo:       z.string().optional().nullable(),
  anio:         z.number().int().optional().nullable(),
  capacidad_m3: z.number().optional().nullable(),
  capacidad_tn: z.number().optional().nullable(),
  titular:      z.string().optional().nullable(),
  estado:       EstadoEnum.default('activo'),
  obs:          z.string().optional().nullable(),
})

// No usar .partial() sobre el create: arrastra el .default('activo') del
// estado y zod lo inyecta en updates parciales, pisando datos válidos.
export const UpdateBateaSchema = z.object({
  patente:      z.string().min(1).optional(),
  tipo:         TipoEnum.optional(),
  marca:        z.string().optional().nullable(),
  modelo:       z.string().optional().nullable(),
  anio:         z.number().int().optional().nullable(),
  capacidad_m3: z.number().optional().nullable(),
  capacidad_tn: z.number().optional().nullable(),
  titular:      z.string().optional().nullable(),
  estado:       EstadoEnum.optional(),
  obs:          z.string().optional().nullable(),
})

export type CreateBateaDto = z.infer<typeof CreateBateaSchema>
export type UpdateBateaDto = z.infer<typeof UpdateBateaSchema>
