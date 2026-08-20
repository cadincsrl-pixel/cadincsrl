import { z } from 'zod'

export const ListStockClienteSchema = z.object({
  obra_cod:         z.string().optional(),
  incluir_agotados: z.coerce.boolean().optional().default(false),
})

// Entrega del cliente: alta de material (find-or-create por obra+descripción)
// más movimiento de entrada.
export const EntradaStockClienteSchema = z.object({
  obra_cod:    z.string().min(1),
  descripcion: z.string().trim().min(1),
  unidad:      z.string().trim().min(1).default('unid'),
  cantidad:    z.number().positive(),
  fecha:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obs:         z.string().optional().default(''),
})

// Salida manual (consumo sin solicitud, ajuste o devolución al cliente).
export const SalidaStockClienteSchema = z.object({
  item_id:  z.number().int().positive(),
  cantidad: z.number().positive(),
  motivo:   z.enum(['consumo_obra', 'ajuste', 'devolucion']).default('consumo_obra'),
  fecha:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obs:      z.string().optional().default(''),
})

export type ListStockClienteDto    = z.infer<typeof ListStockClienteSchema>
export type EntradaStockClienteDto = z.infer<typeof EntradaStockClienteSchema>
export type SalidaStockClienteDto  = z.infer<typeof SalidaStockClienteSchema>
