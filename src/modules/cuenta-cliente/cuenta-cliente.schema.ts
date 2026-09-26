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
  // Cobro contra un certificado (20260911j): se imputan TODOS sus renglones
  // sin cobrar (item_ids se ignora) y el monto se reparte en materiales (la
  // suma de esos renglones) y mano de obra (lo que diga aca).
  certificado_id:     z.number().int().positive().optional().nullable(),
  monto_mano_de_obra: z.number().min(0).optional().default(0),
})

// ── Certificados al cliente (20260911h) ─────────────────────────────────
export const EmitirCertificadoSchema = z.object({
  obra_cod:     z.string().min(1),
  fecha_corte:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mano_de_obra: z.number().min(0).optional().default(0),
  obs:          z.string().max(500).optional().nullable(),
  // Que renglones entran (ids de materiales_a_cuenta_cliente). Sin lista =
  // todos los elegibles hasta el corte. Con lista, la RPC exige que cada uno
  // sea elegible o rechaza la emision entera (ITEM_NO_CERTIFICABLE).
  item_ids:     z.array(z.number().int().positive()).min(1).max(1000).optional(),
})
export const AnularCertificadoSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
})
export type EmitirCertificadoDto = z.infer<typeof EmitirCertificadoSchema>

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

/** Imputar lo pagado de una obra: congela lo cubierto, primero lo viejo. */
export const ImputarPagadoSchema = z.object({
  obra_cod: z.string().min(1),
})

/**
 * Marcar renglones como CONSUMIBLE PROPIO de CADINC (20260914aa).
 *
 * Lo que pone CADINC para ejecutar la tarea y no se le cobra al cliente: discos
 * de corte, maderas de encofrado. Sólo en obras de presupuesto cerrado; la RPC
 * rechaza las de administración y las llave en mano.
 *
 * El tope de 500 es el mismo criterio que usa el resto del módulo para una
 * tanda: la pantalla marca de a una página (50) o un filtro entero, y un lote
 * mayor que eso es casi siempre un error de quien llama, no una intención.
 */
export const MarcarConsumibleSchema = z.object({
  obra_cod: z.string().min(1),
  item_ids: z.array(z.number().int().positive()).min(1).max(500),
  marcar:   z.boolean(),
  // Texto corto del estilo "discos de corte". Sólo se guarda al marcar.
  motivo:   z.string().trim().max(120).optional(),
})
export type MarcarConsumibleDto = z.infer<typeof MarcarConsumibleSchema>

/**
 * EPP que se le cobra al cliente (20261002a). Por defecto un EPP es gasto de
 * CADINC; esto lo marca (o lo vuelve atrás) renglón por renglón, desde Cargar
 * precios. Mismo tope que el consumible.
 */
export const MarcarEppACargoSchema = z.object({
  obra_cod: z.string().min(1),
  item_ids: z.array(z.number().int().positive()).min(1).max(500),
  marcar:   z.boolean(),
})
export type MarcarEppACargoDto = z.infer<typeof MarcarEppACargoSchema>
