import { z } from 'zod'

// Filtros de listado: por proveedor y/o por obra. Default: todo lo que
// está pendiente de retiro (estado='en_proveedor').
export const ListStockSchema = z.object({
  proveedor_id: z.coerce.number().int().positive().optional(),
  obra_cod:     z.string().optional(),
  incluir_retirados: z.coerce.boolean().optional().default(false),
})

// Una línea del retiro: el item y cuánto se retira. Cantidad parcial OK.
const ItemRetiroSchema = z.object({
  item_id:   z.number().int().positive(),
  cantidad:  z.number().positive(),
})

// Crear un remito de retiro.
// `comprobante_path` opcional pero recomendado: ya subido al bucket via
// el endpoint de upload-comprobante. El service lo descarga, calcula
// sha256 y persiste el path + hash. Si viene null, el remito queda sin
// comprobante (solo aceptable si el usuario lo confirma; el frontend
// debería pedirle uno por defecto).
export const CrearRemitoRetiroSchema = z.object({
  proveedor_id:      z.number().int().positive(),
  obra_cod:          z.string().min(1),
  fecha:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  comprobante_path:  z.string().optional().nullable(),
  obs:               z.string().optional().nullable(),
  items:             z.array(ItemRetiroSchema).min(1),
})

// Esquema del endpoint que firma una URL de upload para el comprobante.
export const UploadComprobanteSchema = z.object({
  filename:     z.string().min(1).max(200),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  size_bytes:   z.number().int().positive().max(10 * 1024 * 1024),
})

export type ListStockDto          = z.infer<typeof ListStockSchema>
export type CrearRemitoRetiroDto  = z.infer<typeof CrearRemitoRetiroSchema>
export type UploadComprobanteDto  = z.infer<typeof UploadComprobanteSchema>
