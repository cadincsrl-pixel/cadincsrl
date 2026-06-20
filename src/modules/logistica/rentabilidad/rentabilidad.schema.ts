import { z } from 'zod'

// Parámetros compartidos: todos los valores que en el Excel viven en
// la hoja "Configuración". Numéricos sin restricción de >0 estricta
// porque algunos pueden ser 0 (residual del tractor en casos extremos).
export const ParametrosSchema = z.object({
  alicuota_iva:                z.number().min(0).max(1),
  tipo_cambio_usd_ars:         z.number().positive(),
  valor_tractor_usd:           z.number().min(0),
  valor_residual_tractor_usd:  z.number().min(0),
  vida_util_tractor_km:        z.number().positive(),
  valor_semirremolque_usd:     z.number().min(0),
  vida_util_batea_anios:       z.number().positive(),
  costo_service:               z.number().min(0),
  frecuencia_service_km:       z.number().positive(),
  costo_cubierta:              z.number().min(0),
  cubiertas_por_equipo:        z.number().int().positive(),
  vida_util_neumaticos_km:     z.number().positive(),
  cargas_sociales_mensual:     z.number().min(0),
  seguros_mensual:             z.number().min(0),
  patente_anual:               z.number().min(0),
  gomeria_mensual:             z.number().min(0),
  lavadero_mensual:            z.number().min(0),
  overhead_pct:                z.number().min(0).max(1),
}).refine(
  p => p.valor_residual_tractor_usd <= p.valor_tractor_usd,
  { message: 'El valor residual no puede superar el valor del tractor', path: ['valor_residual_tractor_usd'] },
)

const baseViaje = z.object({
  nombre:               z.string().min(1).max(120),
  km_ida:               z.number().min(0),
  km_vuelta:            z.number().min(0),
  toneladas:            z.number().min(0),
  dias_calendario:      z.number().min(0),
  viajes_por_mes:       z.number().min(0),
  tarifa_neta_por_ton:  z.number().min(0),
  precio_gasoil:        z.number().min(0),
  consumo_camion:       z.number().min(0),
  peajes_total:         z.number().min(0),
  chofer_por_km:        z.number().min(0),
  chofer_por_dia:       z.number().min(0),
  modalidad_pago:       z.enum(['km_jornal', 'pct_jornal']),
  pct_sobre_tarifa:     z.number().min(0).max(1),
  obs:                  z.string().optional().nullable(),
})

export const CreateViajeSchema = baseViaje
export const UpdateViajeSchema = baseViaje.partial()

export type ParametrosDto    = z.infer<typeof ParametrosSchema>
export type CreateViajeDto   = z.infer<typeof CreateViajeSchema>
export type UpdateViajeDto   = z.infer<typeof UpdateViajeSchema>
