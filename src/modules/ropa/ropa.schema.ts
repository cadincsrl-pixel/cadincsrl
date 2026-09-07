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

export const CreateEntregaSchema = z.object({
  leg:           z.string().min(1),
  categoria_id:  z.number().int().positive(),
  fecha_entrega: z.iso.date('fecha_entrega debe ser YYYY-MM-DD'),
  obs:           z.string().max(500).nullable().optional(),
})

// Varias prendas al mismo trabajador en un solo request: se insertan juntas
// (un INSERT = todo o nada). Antes el front mandaba N POST y un reintento
// duplicaba las que sí habían entrado.
export const CreateEntregasLoteSchema = z.object({
  leg:           z.string().min(1),
  categoria_ids: z.array(z.number().int().positive()).min(1).max(50),
  fecha_entrega: z.iso.date('fecha_entrega debe ser YYYY-MM-DD'),
  obs:           z.string().max(500).nullable().optional(),
})

export type CreateCategoriaDto = z.infer<typeof CreateCategoriaSchema>
export type UpdateCategoriaDto = z.infer<typeof UpdateCategoriaSchema>
export type CreateEntregaDto   = z.infer<typeof CreateEntregaSchema>
export type CreateEntregasLoteDto = z.infer<typeof CreateEntregasLoteSchema>
