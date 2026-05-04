import { z } from 'zod'

// Sync manual de UN camión específico.
export const SyncCamionParamSchema = z.object({
  camion_id: z.coerce.number().int().positive(),
})

// Asignar manualmente un id_vehiculo_gps a un camión (cuando no matchea por
// patente automáticamente, o queremos forzar el mapeo).
export const SetIdVehiculoGpsSchema = z.object({
  id_vehiculo_gps: z.string().min(1).nullable(),
})

export type SetIdVehiculoGpsDto = z.infer<typeof SetIdVehiculoGpsSchema>

// Query params del log.
export const LogQuerySchema = z.object({
  camion_id: z.coerce.number().int().positive().optional(),
  estado:    z.enum(['ok', 'error', 'no_match', 'sin_cambio']).optional(),
  limit:     z.coerce.number().int().positive().max(500).default(100),
})

export type LogQuery = z.infer<typeof LogQuerySchema>
