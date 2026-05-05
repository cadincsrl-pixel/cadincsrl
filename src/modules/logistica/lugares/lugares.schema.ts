import { z } from 'zod'

export const CreateLugarSchema = z.object({
  nombre:    z.string().min(1),
  localidad: z.string().optional().default(''),
  maps_url:  z.string().optional().default(''),
  obs:       z.string().optional().default(''),
  // Coordenadas opcionales — usadas para Distance Matrix de Google Maps.
  lat:       z.number().min(-90).max(90).nullable().optional(),
  lng:       z.number().min(-180).max(180).nullable().optional(),
})

export const UpdateLugarSchema = CreateLugarSchema.partial()

export const CreateRutaSchema = z.object({
  cantera_id:   z.number(),
  deposito_id:  z.number(),
  km_ida_vuelta: z.number().min(1),
  obs:          z.string().optional().default(''),
})

export type CreateLugarDto = z.infer<typeof CreateLugarSchema>
export type UpdateLugarDto = z.infer<typeof UpdateLugarSchema>
export type CreateRutaDto  = z.infer<typeof CreateRutaSchema>