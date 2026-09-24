import { z } from 'zod'

// Categorías de ropa (camisa, pantalón, casco, etc.) y entregas al personal.
// Es un tab de tarja (CLAUDE.md §4) → permisos vía 'tarja.*'.

export const CreateCategoriaSchema = z.object({
  nombre:            z.string().min(1).max(80),
  icono:             z.string().max(8).optional(),
  meses_vencimiento: z.number().int().nonnegative().optional(),
})

export const UpdateCategoriaSchema = z.object({
  meses_vencimiento: z.number().int().nonnegative(),
})

// Talle y cantidad de cada prenda (20260923o). Opcionales para que un front
// viejo siga andando: sin ellos queda 1 unidad y sin talle, como antes.
const talle    = z.string().trim().max(12).optional()
const cantidad = z.number().int().min(1).max(20).optional()

export const CreateEntregaSchema = z.object({
  leg:           z.string().min(1),
  categoria_id:  z.number().int().positive(),
  fecha_entrega: z.iso.date('fecha_entrega debe ser YYYY-MM-DD'),
  obs:           z.string().max(500).nullable().optional(),
  cantidad,
  talle,
})

export const ItemEntregaSchema = z.object({
  categoria_id: z.number().int().positive(),
  cantidad,
  talle,
})

// Varias prendas al mismo trabajador en un solo request: se insertan juntas
// (un INSERT = todo o nada). Antes el front mandaba N POST y un reintento
// duplicaba las que sí habían entrado.
// `items` trae talle y cantidad; `categoria_ids` queda por compatibilidad.
export const CreateEntregasLoteSchema = z.object({
  leg:           z.string().min(1),
  categoria_ids: z.array(z.number().int().positive()).min(1).max(50).optional(),
  items:         z.array(ItemEntregaSchema).min(1).max(50).optional(),
  fecha_entrega: z.iso.date('fecha_entrega debe ser YYYY-MM-DD'),
  obs:           z.string().max(500).nullable().optional(),
}).refine(d => (d.items?.length ?? 0) > 0 || (d.categoria_ids?.length ?? 0) > 0, {
  message: 'Elegí al menos una prenda', path: ['items'],
})

// «Entrega por obra»: varios trabajadores, cada uno con sus prendas, en un
// solo INSERT. Misma fecha y observación para toda la tanda.
export const CreateEntregasTandaSchema = z.object({
  fecha_entrega: z.iso.date('fecha_entrega debe ser YYYY-MM-DD'),
  obs:           z.string().max(500).nullable().optional(),
  entregas:      z.array(z.object({
    leg:   z.string().min(1),
    items: z.array(ItemEntregaSchema).min(1).max(50),
  })).min(1).max(200),
})

export type CreateCategoriaDto = z.infer<typeof CreateCategoriaSchema>
export type UpdateCategoriaDto = z.infer<typeof UpdateCategoriaSchema>
export type CreateEntregaDto   = z.infer<typeof CreateEntregaSchema>
export type CreateEntregasLoteDto = z.infer<typeof CreateEntregasLoteSchema>
export type CreateEntregasTandaDto = z.infer<typeof CreateEntregasTandaSchema>
export type ItemEntregaDto = z.infer<typeof ItemEntregaSchema>
