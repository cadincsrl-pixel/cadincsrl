import { z } from 'zod'

// Tipos válidos para flota interna (autos/camionetas/utilitarios de CADINC).
// Distinto del enum de camiones (que solo tiene activo/mantenimiento/inactivo).
const TIPOS_VEHICULO = ['auto', 'camioneta', 'utilitario', 'pickup', 'moto', 'otro'] as const
const ESTADOS       = ['activo', 'taller', 'baja'] as const

export const CreateVehiculoSchema = z.object({
  patente:              z.string().min(1, 'La patente es requerida').max(20),
  tipo:                 z.enum(TIPOS_VEHICULO),
  marca:                z.string().max(80).optional().nullable(),
  modelo:               z.string().max(80).optional().nullable(),
  anio:                 z.number().int().optional().nullable(),
  color:                z.string().max(40).optional().nullable(),
  vin:                  z.string().max(40).optional().nullable(),
  titular:              z.string().max(120).optional().nullable(),
  km_actuales:          z.number().min(0).optional().default(0),
  estado:               z.enum(ESTADOS).optional().default('activo'),
  mobilquest_device_id: z.string().max(80).optional().nullable(),
  obs:                  z.string().max(500).optional().nullable(),
})

// NO usar .partial() sobre el create — arrastra los .default() y los
// inyecta en updates parciales pisando datos válidos. Repetimos el shape.
export const UpdateVehiculoSchema = z.object({
  patente:              z.string().min(1).max(20).optional(),
  tipo:                 z.enum(TIPOS_VEHICULO).optional(),
  marca:                z.string().max(80).nullable().optional(),
  modelo:               z.string().max(80).nullable().optional(),
  anio:                 z.number().int().nullable().optional(),
  color:                z.string().max(40).nullable().optional(),
  vin:                  z.string().max(40).nullable().optional(),
  titular:              z.string().max(120).nullable().optional(),
  km_actuales:          z.number().min(0).optional(),
  estado:               z.enum(ESTADOS).optional(),
  mobilquest_device_id: z.string().max(80).nullable().optional(),
  obs:                  z.string().max(500).nullable().optional(),
})

export type CreateVehiculoDto = z.infer<typeof CreateVehiculoSchema>
export type UpdateVehiculoDto = z.infer<typeof UpdateVehiculoSchema>
