import { z } from 'zod'

const MEDIOS = ['efectivo', 'transferencia', 'cheque', 'otro'] as const

// Cobro (pago) del cliente a cuenta de la obra. Puede imputar items del MCC
// (patrón simple, como alquiler/áridos: cada item se paga ENTERO por UN cobro;
// item_ids vacío = pago a cuenta sin imputar).
export const CrearCobroSchema = z.object({
  obra_cod: z.string().min(1),
  fecha:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto:    z.number().positive(),
  medio:    z.enum(MEDIOS).default('efectivo'),
  obs:      z.string().optional().nullable(),
  // Filas de materiales_a_cuenta_cliente que este pago cubre.
  item_ids: z.array(z.number().int().positive()).max(500).optional().default([]),
  // Path del comprobante ya subido al bucket con la signed URL (2 pasos).
  comprobante_path: z.string().optional().nullable(),
})

export const UploadComprobanteCobroSchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
})

// No usar .partial() del create: arrastra el .default() de `medio` y pisaría
// el valor existente en updates parciales.
export const EditarCobroSchema = z.object({
  fecha:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  monto:  z.number().positive().optional(),
  medio:  z.enum(MEDIOS).optional(),
  obs:    z.string().optional().nullable(),
})

export type CrearCobroDto  = z.infer<typeof CrearCobroSchema>
export type EditarCobroDto = z.infer<typeof EditarCobroSchema>

// ── Cuenta corriente (20260904ap) ───────────────────────────────────────
// Filtros del listado y del resumen. `estado` viene como lista separada por
// coma; los booleanos llegan como '1'/'true'.
const BOOL_Q = z.enum(['1', '0', 'true', 'false']).optional()
const FECHA_Q = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const CUENTA_ESTADOS = ['a_cobrar', 'cobrado', 'pago_directo', 'gasto_cadinc'] as const
export type CuentaEstado = typeof CUENTA_ESTADOS[number]

export const CuentaCorrienteQuerySchema = z.object({
  obra_cod:     z.string().min(1).optional(),
  estado:       z.string().max(80).optional(),
  tipo:         z.enum(['material', 'epp']).optional(),
  sin_precio:   BOOL_Q,
  proveedor_id: z.coerce.number().int().positive().optional(),
  origen:       z.enum(['proveedor', 'deposito']).optional(),
  desde:        FECHA_Q.optional(),
  hasta:        FECHA_Q.optional(),
  q:            z.string().max(200).optional(),
  archivadas:   BOOL_Q,
  grupo:        z.enum(['obra', 'mes', 'proveedor']).default('obra'),
  // Hasta 1000 (cap de PostgREST): el export Excel baja de a 1000.
  limit:        z.coerce.number().int().min(1).max(1000).default(50),
  offset:       z.coerce.number().int().min(0).default(0),
})
export type CuentaCorrienteQuery = z.infer<typeof CuentaCorrienteQuerySchema>
