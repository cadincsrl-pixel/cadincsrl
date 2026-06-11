import { z } from 'zod'

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// ── Materiales ────────────────────────────────────────────────
export const CreateMaterialSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  unidad: z.enum(['m3', 'viaje']).default('m3'),
})

export const UpdateMaterialSchema = z.object({
  nombre: z.string().min(1).optional(),
  unidad: z.enum(['m3', 'viaje']).optional(),
  activo: z.boolean().optional(),
})

// ── Clientes ──────────────────────────────────────────────────
export const CreateClienteSchema = z.object({
  nombre:    z.string().min(1, 'El nombre es requerido'),
  cuit:      z.string().nullable().optional(),
  tel:       z.string().nullable().optional(),
  email:     z.string().nullable().optional(),
  direccion: z.string().nullable().optional(),
  obs:       z.string().nullable().optional(),
})

export const UpdateClienteSchema = z.object({
  nombre:    z.string().min(1).optional(),
  cuit:      z.string().nullable().optional(),
  tel:       z.string().nullable().optional(),
  email:     z.string().nullable().optional(),
  direccion: z.string().nullable().optional(),
  obs:       z.string().nullable().optional(),
})

// ── Precios por cliente × material (historial por vigente_desde) ──
export const CreatePrecioSchema = z.object({
  cliente_id:    z.number(),
  material_id:   z.number(),
  precio:        z.number().min(0),
  vigente_desde: FECHA,
  obs:           z.string().nullable().optional(),
})

// La identidad (cliente+material) no se edita; si cambió, eliminar y crear.
export const UpdatePrecioSchema = z.object({
  precio:        z.number().min(0).optional(),
  vigente_desde: FECHA.optional(),
  obs:           z.string().nullable().optional(),
})

// ── Movimientos (venta / acopio / ajuste) ─────────────────────
export const CreateMovimientoSchema = z.object({
  tipo:        z.enum(['venta', 'acopio', 'ajuste']),
  fecha:       FECHA,
  material_id: z.number(),
  cantidad:    z.number(),
  origen:      z.enum(['cantera', 'deposito']).nullable().optional(),
  cantera_id:  z.number().nullable().optional(),
  cliente_id:  z.number().nullable().optional(),
  precio_unit: z.number().min(0).nullable().optional(),
  importe:     z.number().min(0).nullable().optional(),
  chofer_id:   z.number().nullable().optional(),
  camion_id:   z.number().nullable().optional(),
  flete_obs:   z.string().nullable().optional(),
  remito:      z.string().nullable().optional(),
  obs:         z.string().nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.tipo === 'venta') {
    if (v.cliente_id == null) ctx.addIssue({ code: 'custom', message: 'La venta requiere cliente' })
    if (v.origen == null)     ctx.addIssue({ code: 'custom', message: 'La venta requiere origen (cantera o depósito)' })
    if (v.cantidad <= 0)      ctx.addIssue({ code: 'custom', message: 'La cantidad debe ser mayor a 0' })
  }
  if (v.tipo === 'acopio' && v.cantidad <= 0) {
    ctx.addIssue({ code: 'custom', message: 'El acopio debe tener cantidad mayor a 0' })
  }
})

export const UpdateMovimientoSchema = z.object({
  fecha:       FECHA.optional(),
  material_id: z.number().optional(),
  cantidad:    z.number().optional(),
  origen:      z.enum(['cantera', 'deposito']).nullable().optional(),
  cantera_id:  z.number().nullable().optional(),
  cliente_id:  z.number().nullable().optional(),
  precio_unit: z.number().min(0).nullable().optional(),
  importe:     z.number().min(0).nullable().optional(),
  chofer_id:   z.number().nullable().optional(),
  camion_id:   z.number().nullable().optional(),
  flete_obs:   z.string().nullable().optional(),
  remito:      z.string().nullable().optional(),
  obs:         z.string().nullable().optional(),
})

export const ListMovimientosQuerySchema = z.object({
  tipo:        z.enum(['venta', 'acopio', 'ajuste']).optional(),
  cliente_id:  z.coerce.number().optional(),
  material_id: z.coerce.number().optional(),
  fecha_desde: FECHA.optional(),
  fecha_hasta: FECHA.optional(),
})

// ── Cobros ────────────────────────────────────────────────────
export const CreateCobroSchema = z.object({
  cliente_id: z.number(),
  fecha:      FECHA,
  monto:      z.number().positive('El monto debe ser mayor a 0'),
  medio:      z.enum(['efectivo', 'transferencia', 'cheque', 'otro']).default('transferencia'),
  obs:        z.string().nullable().optional(),
})

export const UpdateCobroSchema = z.object({
  fecha: FECHA.optional(),
  monto: z.number().positive().optional(),
  medio: z.enum(['efectivo', 'transferencia', 'cheque', 'otro']).optional(),
  obs:   z.string().nullable().optional(),
})

export const CobrosQuerySchema = z.object({
  cliente_id: z.coerce.number().optional(),
})

export type CreateMaterialDto    = z.infer<typeof CreateMaterialSchema>
export type UpdateMaterialDto    = z.infer<typeof UpdateMaterialSchema>
export type CreateClienteDto     = z.infer<typeof CreateClienteSchema>
export type UpdateClienteDto     = z.infer<typeof UpdateClienteSchema>
export type CreatePrecioDto      = z.infer<typeof CreatePrecioSchema>
export type UpdatePrecioDto      = z.infer<typeof UpdatePrecioSchema>
export type CreateMovimientoDto  = z.infer<typeof CreateMovimientoSchema>
export type UpdateMovimientoDto  = z.infer<typeof UpdateMovimientoSchema>
export type ListMovimientosQuery = z.infer<typeof ListMovimientosQuerySchema>
export type CreateCobroDto       = z.infer<typeof CreateCobroSchema>
export type UpdateCobroDto       = z.infer<typeof UpdateCobroSchema>
export type CobrosQuery          = z.infer<typeof CobrosQuerySchema>
