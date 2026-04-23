import { z } from 'zod'

// ── Enums compartidos ────────────────────────────────────────────
export const MetodoPagoEnum     = z.enum(['efectivo', 'transferencia', 'tarjeta', 'cheque', 'cta_cte', 'otro'])
export const PagadoPorEnum      = z.enum(['empresa', 'chofer'])
export const EstadoGastoEnum    = z.enum(['pendiente', 'aprobado', 'rechazado', 'pagado'])
export const AplicaAEnum        = z.enum(['camion', 'chofer', 'ambos'])
export const TipoCombustibleEnum = z.enum(['gasoil', 'nafta', 'nafta_super', 'adblue'])

const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD')

// ── Metadata anidada de carga de combustible ─────────────────────
// Se incluye en el body de POST /gastos cuando categoria.codigo = 'combustible'.
// La validación cruzada (categoria ↔ presencia de carga) vive en el service.
export const CargaCombustibleMetaSchema = z.object({
  litros:           z.number().positive().multipleOf(0.001).max(9999.999),
  odometro_km:      z.number().int().min(0).max(9_999_999).nullable().optional(),
  tipo_combustible: TipoCombustibleEnum.default('gasoil'),
  tanque_lleno:     z.boolean().default(true),
  obs:              z.string().max(500).optional().default(''),
})

export type CargaCombustibleMetaDto = z.infer<typeof CargaCombustibleMetaSchema>

// ── Crear gasto ──────────────────────────────────────────────────
export const CreateGastoSchema = z.object({
  camion_id:       z.number().int().positive().nullable().optional(),
  chofer_id:       z.number().int().positive().nullable().optional(),
  tramo_id:        z.number().int().positive().nullable().optional(),
  lugar_id:        z.number().int().positive().nullable().optional(),
  categoria_id:    z.number().int().positive(),
  fecha:           FechaISO,
  monto:           z.number().positive().multipleOf(0.01),
  descripcion:     z.string().max(500).optional().default(''),
  proveedor:       z.string().max(200).nullable().optional(),
  metodo_pago:     MetodoPagoEnum.default('efectivo'),
  pagado_por:      PagadoPorEnum.default('empresa'),
  comprobante_path: z.string().max(500).nullable().optional(),  // path en bucket (si hubo upload previo)
  comprobante_nro: z.string().max(100).optional().default(''),
  obs:             z.string().max(1000).optional().default(''),
  // Metadata de combustible (solo cuando categoria.codigo='combustible').
  // La validación cruzada vive en el service (requiere SELECT al catálogo).
  carga_combustible: CargaCombustibleMetaSchema.optional(),
}).refine(
  d => d.camion_id != null || d.chofer_id != null || d.tramo_id != null || d.lugar_id != null,
  { message: 'Debe especificar al menos camion_id, chofer_id, tramo_id o lugar_id', path: ['camion_id'] },
)

// ── Update gasto ─────────────────────────────────────────────────
// Inmutabilidad enforced en el service: en `aprobado` no se pueden
// cambiar campos financieros (monto/pagado_por/chofer_id/camion_id/
// categoria_id/comprobante). Si `liquidacion_id != null`, nada es
// editable.
export const UpdateGastoSchema = z.object({
  camion_id:       z.number().int().positive().nullable().optional(),
  chofer_id:       z.number().int().positive().nullable().optional(),
  tramo_id:        z.number().int().positive().nullable().optional(),
  lugar_id:        z.number().int().positive().nullable().optional(),
  categoria_id:    z.number().int().positive().optional(),
  fecha:           FechaISO.optional(),
  monto:           z.number().positive().multipleOf(0.01).optional(),
  descripcion:     z.string().max(500).optional(),
  proveedor:       z.string().max(200).nullable().optional(),
  metodo_pago:     MetodoPagoEnum.optional(),
  pagado_por:      PagadoPorEnum.optional(),
  comprobante_path: z.string().max(500).nullable().optional(),
  comprobante_nro: z.string().max(100).optional(),
  obs:             z.string().max(1000).optional(),
})

// ── Rechazar ─────────────────────────────────────────────────────
export const RechazarGastoSchema = z.object({
  motivo_rechazo: z.string().min(3).max(500),
})

// ── Marcar pagado ────────────────────────────────────────────────
export const MarcarPagadoSchema = z.object({
  fecha_pago:  FechaISO.optional(),          // default: hoy
  metodo_pago: MetodoPagoEnum.optional(),    // sobrescribe el del gasto si viene
})

// ── Listado con filtros + paginación ─────────────────────────────
export const ListGastosQuerySchema = z.object({
  camion_id:      z.coerce.number().int().positive().optional(),
  chofer_id:      z.coerce.number().int().positive().optional(),
  tramo_id:       z.coerce.number().int().positive().optional(),
  lugar_id:       z.coerce.number().int().positive().optional(),
  categoria_id:   z.coerce.number().int().positive().optional(),
  estado:         EstadoGastoEnum.optional(),
  pagado_por:     PagadoPorEnum.optional(),
  metodo_pago:    MetodoPagoEnum.optional(),
  desde:          FechaISO.optional(),
  hasta:          FechaISO.optional(),
  liquidado:      z.coerce.boolean().optional(),
  q:              z.string().max(200).optional(),
  limit:          z.coerce.number().int().min(1).max(500).default(100),
  offset:         z.coerce.number().int().min(0).default(0),
})

// ── Rango de fechas para reportes ────────────────────────────────
export const ReporteRangoQuerySchema = z.object({
  desde: FechaISO,
  hasta: FechaISO,
}).refine(d => d.desde <= d.hasta, {
  message: 'desde debe ser <= hasta',
  path:    ['desde'],
})

// ── Upload de comprobante ────────────────────────────────────────
export const UploadComprobanteSchema = z.object({
  filename:     z.string().min(1).max(200),
  content_type: z.string().regex(
    /^(image\/(jpeg|png|webp)|application\/pdf)$/,
    'Solo image/jpeg, image/png, image/webp o application/pdf',
  ),
  size_bytes:   z.number().int().positive().max(10 * 1024 * 1024, 'Tamaño máximo 10 MB'),
})

// ── Categorías (CRUD para admin) ─────────────────────────────────
export const CreateCategoriaSchema = z.object({
  codigo:   z.string().regex(/^[a-z0-9_]{2,30}$/, 'Solo minúsculas, números y _, 2-30 caracteres'),
  nombre:   z.string().min(2).max(100),
  aplica_a: AplicaAEnum.default('ambos'),
  activo:   z.boolean().default(true),
  orden:    z.number().int().min(0).default(0),
})

export const UpdateCategoriaSchema = z.object({
  nombre:   z.string().min(2).max(100).optional(),
  aplica_a: AplicaAEnum.optional(),
  activo:   z.boolean().optional(),
  orden:    z.number().int().min(0).optional(),
})

// ── Tipos inferidos ──────────────────────────────────────────────
export type CreateGastoDto        = z.infer<typeof CreateGastoSchema>
export type UpdateGastoDto        = z.infer<typeof UpdateGastoSchema>
export type RechazarGastoDto      = z.infer<typeof RechazarGastoSchema>
export type MarcarPagadoDto       = z.infer<typeof MarcarPagadoSchema>
export type ListGastosQuery       = z.infer<typeof ListGastosQuerySchema>
export type ReporteRangoQuery     = z.infer<typeof ReporteRangoQuerySchema>
export type UploadComprobanteDto  = z.infer<typeof UploadComprobanteSchema>
export type CreateCategoriaDto    = z.infer<typeof CreateCategoriaSchema>
export type UpdateCategoriaDto    = z.infer<typeof UpdateCategoriaSchema>
