import { z } from 'zod'

// ── Rubros ──
export const CreateRubroSchema = z.object({
  nombre: z.string().min(1),
  icono:  z.string().optional().default(''),
  orden:  z.number().int().optional().default(0),
})
export const UpdateRubroSchema = CreateRubroSchema.partial()

// ── Materiales ──
export const CreateMaterialSchema = z.object({
  rubro_id:      z.number().int().positive(),
  nombre:        z.string().min(1),
  unidad:        z.string().default('unid'),
  stock_minimo:  z.number().min(0).default(0),
  precio_ref:    z.number().min(0).default(0),
  proveedor_id:  z.number().int().positive().nullable().optional().default(null),
  obs:           z.string().optional().default(''),
})
export const UpdateMaterialSchema = CreateMaterialSchema.partial()

// ── Movimientos ──
//
// Para entradas y salidas: `cantidad` SIEMPRE positiva, la dirección la marca
// `tipo`. Para ajustes: `cantidad` es delta firmado (negativo = faltante,
// positivo = sobrante/ingreso sin compra), y debe venir `sub_motivo`.
// Los ajustes nacen en estado 'pendiente' y NO afectan stock hasta aprobación.
export const SUB_MOTIVOS_AJUSTE = [
  'faltante_fisico',
  'dano_rotura',
  'error_carga',
  'merma_normal',
  'ingreso_sin_compra',
  'otro',
] as const

export const CreateMovimientoSchema = z.object({
  material_id:       z.number().int().positive(),
  tipo:              z.enum(['entrada', 'salida', 'ajuste']),
  cantidad:          z.number().refine(n => n !== 0, { message: 'cantidad no puede ser 0' }),
  motivo:            z.enum(['compra', 'despacho_obra', 'devolucion', 'ajuste_inventario']),
  sub_motivo:        z.enum(SUB_MOTIVOS_AJUSTE).optional().nullable(),
  obra_cod:          z.string().optional().nullable().default(null),
  solicitud_item_id: z.number().int().optional().nullable().default(null),
  obs:               z.string().optional().default(''),
  fecha:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  comprobante_storage_path: z.string().optional().nullable(),
  comprobante_hash:         z.string().optional().nullable(),
}).superRefine((data, ctx) => {
  if (data.tipo === 'ajuste') {
    if (!data.sub_motivo) {
      ctx.addIssue({ code: 'custom', path: ['sub_motivo'], message: 'sub_motivo es obligatorio para ajustes' })
    }
    if (!data.obs || data.obs.trim().length < 3) {
      ctx.addIssue({ code: 'custom', path: ['obs'], message: 'obs es obligatoria (mínimo 3 caracteres) para ajustes' })
    }
  } else if (data.cantidad <= 0) {
    ctx.addIssue({ code: 'custom', path: ['cantidad'], message: 'cantidad debe ser positiva para entrada/salida' })
  }
})

// Schema para aprobar/rechazar un ajuste pendiente.
export const AprobarAjusteSchema = z.object({
  // vacío — solo necesita el id en la URL y el user del JWT
})
export const RechazarAjusteSchema = z.object({
  rechazo_motivo: z.string().min(3),
})

// Schema para pedir URL de subida del comprobante.
export const ComprobanteUploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1).max(255),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

export type CreateRubroDto      = z.infer<typeof CreateRubroSchema>
export type UpdateRubroDto      = z.infer<typeof UpdateRubroSchema>
export type CreateMaterialDto   = z.infer<typeof CreateMaterialSchema>
export type UpdateMaterialDto   = z.infer<typeof UpdateMaterialSchema>
export type CreateMovimientoDto = z.infer<typeof CreateMovimientoSchema>
export type RechazarAjusteDto   = z.infer<typeof RechazarAjusteSchema>
