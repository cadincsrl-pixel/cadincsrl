import { z } from 'zod'

const TipoEnum   = z.enum(['volcadora','plana','tanque','gondola','otro'])
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

export const UpdateBateaSchema = CreateBateaSchema.partial()

export type CreateBateaDto = z.infer<typeof CreateBateaSchema>
export type UpdateBateaDto = z.infer<typeof UpdateBateaSchema>
