import { z } from 'zod'

const TipoEnum   = z.enum(['volcadora','plana','tanque','gondola','otro'])
const EstadoEnum = z.enum(['activo','mantenimiento','inactivo'])
// Categoría de remolque (aparte de `tipo`, que describe la forma).
const CategoriaEnum = z.enum(['batea','acoplado','semirremolque'])

export const CreateBateaSchema = z.object({
  patente:      z.string().min(1),
  tipo:         TipoEnum.optional(),
  categoria:    CategoriaEnum.default('batea'),
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
  categoria:    CategoriaEnum.optional(),
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
