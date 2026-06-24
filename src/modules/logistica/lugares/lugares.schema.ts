import { z } from 'zod'

export const CreateLugarSchema = z.object({
  nombre:    z.string().min(1),
  localidad: z.string().optional().default(''),
  maps_url:  z.string().optional().default(''),
  obs:       z.string().optional().default(''),
  // Coordenadas opcionales — usadas para Distance Matrix de Google Maps.
  lat:       z.number().min(-90).max(90).nullable().optional(),
  lng:       z.number().min(-180).max(180).nullable().optional(),
  // Lugar operativo (mantenimiento/relevos/parking): no facturable, no puede
  // ser origen/destino de un tramo cargado.
  operativo: z.boolean().optional().default(false),
})

// No usar .partial() sobre el create: arrastra los .default() y zod
// inyecta valores por defecto en updates parciales, pisando datos válidos.
export const UpdateLugarSchema = z.object({
  nombre:    z.string().min(1).optional(),
  localidad: z.string().optional(),
  maps_url:  z.string().optional(),
  obs:       z.string().optional(),
  lat:       z.number().min(-90).max(90).nullable().optional(),
  lng:       z.number().min(-180).max(180).nullable().optional(),
  operativo: z.boolean().optional(),
})

export const CreateRutaSchema = z.object({
  cantera_id:   z.number(),
  deposito_id:  z.number(),
  km_ida_vuelta: z.number().min(1),
  obs:          z.string().optional().default(''),
})

// Update solo permite cambiar km y observaciones — el par cantera/depósito
// es la identidad de la ruta y no debería cambiar (si querés otro par,
// borrás esta y creás una nueva).
export const UpdateRutaSchema = z.object({
  km_ida_vuelta: z.number().min(1).optional(),
  obs:           z.string().optional(),
})

// Lugar operativo (no facturable): se gestiona como UN concepto y por detrás
// crea/mantiene el par cantera+depósito (ambos operativo). Ver migración
// 20260624c_lugares_operativos.sql.
export const CrearLugarOperativoSchema = z.object({
  nombre:    z.string().min(1),
  localidad: z.string().optional().default(''),
  maps_url:  z.string().optional().default(''),
  lat:       z.number().min(-90).max(90).nullable().optional(),
  lng:       z.number().min(-180).max(180).nullable().optional(),
  obs:       z.string().optional().nullable(),
})
export const UpdateLugarOperativoSchema = z.object({
  nombre:    z.string().min(1).optional(),
  localidad: z.string().optional(),
  maps_url:  z.string().optional(),
  lat:       z.number().min(-90).max(90).nullable().optional(),
  lng:       z.number().min(-180).max(180).nullable().optional(),
  obs:       z.string().optional().nullable(),
})

export type CreateLugarDto = z.infer<typeof CreateLugarSchema>
export type UpdateLugarDto = z.infer<typeof UpdateLugarSchema>
export type CreateRutaDto  = z.infer<typeof CreateRutaSchema>
export type UpdateRutaDto  = z.infer<typeof UpdateRutaSchema>
export type CrearLugarOperativoDto  = z.infer<typeof CrearLugarOperativoSchema>
export type UpdateLugarOperativoDto = z.infer<typeof UpdateLugarOperativoSchema>