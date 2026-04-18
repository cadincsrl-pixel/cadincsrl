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
  obs:           z.string().optional().default(''),
})
export const UpdateMaterialSchema = CreateMaterialSchema.partial()

// ── Movimientos ──
export const CreateMovimientoSchema = z.object({
  material_id:       z.number().int().positive(),
  tipo:              z.enum(['entrada', 'salida', 'ajuste']),
  cantidad:          z.number().positive(),
  motivo:            z.enum(['compra', 'despacho_obra', 'devolucion', 'ajuste_inventario']),
  obra_cod:          z.string().optional().nullable().default(null),
  solicitud_item_id: z.number().int().optional().nullable().default(null),
  obs:               z.string().optional().default(''),
  fecha:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export type CreateRubroDto      = z.infer<typeof CreateRubroSchema>
export type UpdateRubroDto      = z.infer<typeof UpdateRubroSchema>
export type CreateMaterialDto   = z.infer<typeof CreateMaterialSchema>
export type UpdateMaterialDto   = z.infer<typeof UpdateMaterialSchema>
export type CreateMovimientoDto = z.infer<typeof CreateMovimientoSchema>
