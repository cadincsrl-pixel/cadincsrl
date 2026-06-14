import { z } from 'zod'

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// Email opcional: el front puede mandar null o '' (campo vacío). Solo se
// valida el formato si hay texto. Acepta null/'' tal cual y los deja pasar.
const EMAIL_OPCIONAL = z
  .string()
  .nullable()
  .optional()
  .refine(
    (v) => v == null || v === '' || z.string().email().safeParse(v).success,
    { message: 'Email inválido' },
  )

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
  email:     EMAIL_OPCIONAL,
  direccion: z.string().nullable().optional(),
  obs:       z.string().nullable().optional(),
})

export const UpdateClienteSchema = z.object({
  nombre:    z.string().min(1).optional(),
  cuit:      z.string().nullable().optional(),
  tel:       z.string().nullable().optional(),
  email:     EMAIL_OPCIONAL,
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

// ── Lista de precios global por material ──────────────────────
export const CreatePrecioGlobalSchema = z.object({
  material_id:   z.number(),
  precio:        z.number().min(0),
  vigente_desde: FECHA,
  obs:           z.string().nullable().optional(),
})

export const UpdatePrecioGlobalSchema = z.object({
  precio:        z.number().min(0).optional(),
  vigente_desde: FECHA.optional(),
  obs:           z.string().nullable().optional(),
})

// ── Movimientos (venta / acopio / ajuste) ─────────────────────
// origen 'obra' = retiro de escombro: sale de la obra del cliente
// hacia el depósito (no toca stock).
const HORA = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/)

export const CreateMovimientoSchema = z.object({
  tipo:        z.enum(['venta', 'acopio', 'ajuste']),
  fecha:       FECHA,
  hora:        HORA.nullable().optional(),
  material_id: z.number(),
  cantidad:    z.number(),
  origen:      z.enum(['cantera', 'deposito', 'obra']).nullable().optional(),
  cantera_id:  z.number().nullable().optional(),
  cliente_id:  z.number().nullable().optional(),
  precio_unit: z.number().min(0).nullable().optional(),
  importe:     z.number().min(0).nullable().optional(),
  precio_especial:   z.boolean().optional().default(false),
  entrega_direccion: z.string().nullable().optional(),
  municipio_id:      z.number().nullable().optional(),
  unidad_id:   z.number().nullable().optional(),
  // Lo que cobró la cantera por este retiro (deuda con el proveedor)
  costo_unit:  z.number().min(0).nullable().optional(),
  costo_total: z.number().min(0).nullable().optional(),
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
  // cantera_id solo tiene sentido cuando el material sale de una cantera.
  // Si el origen NO es 'cantera' (depósito u obra), cantera_id DEBE ser null:
  // de lo contrario el costo_total cargaría la cta cte de una cantera con un
  // retiro que en realidad salió del depósito → deuda inflada al proveedor.
  if (v.origen != null && v.origen !== 'cantera' && v.cantera_id != null) {
    ctx.addIssue({ code: 'custom', path: ['cantera_id'], message: 'cantera_id solo aplica cuando el origen es cantera' })
  }
  // Si origen === 'cantera' en una venta, lo esperable es que venga cantera_id
  // (para imputar el retiro a la cta cte del proveedor). NO se hace obligatorio
  // a propósito: a veces se carga la venta antes de saber la cantera exacta y
  // el costo se completa después. Queda como expectativa documentada, no hard.
})

export const UpdateMovimientoSchema = z.object({
  fecha:       FECHA.optional(),
  hora:        HORA.nullable().optional(),
  material_id: z.number().optional(),
  cantidad:    z.number().optional(),
  origen:      z.enum(['cantera', 'deposito', 'obra']).nullable().optional(),
  cantera_id:  z.number().nullable().optional(),
  cliente_id:  z.number().nullable().optional(),
  precio_unit: z.number().min(0).nullable().optional(),
  importe:     z.number().min(0).nullable().optional(),
  precio_especial:   z.boolean().optional(),
  entrega_direccion: z.string().nullable().optional(),
  municipio_id:      z.number().nullable().optional(),
  unidad_id:   z.number().nullable().optional(),
  costo_unit:  z.number().min(0).nullable().optional(),
  costo_total: z.number().min(0).nullable().optional(),
  flete_obs:   z.string().nullable().optional(),
  remito:      z.string().nullable().optional(),
  obs:         z.string().nullable().optional(),
}).superRefine((v, ctx) => {
  // El create valida con superRefine; el update no validaba nada. Replicamos
  // lo que es chequeable sin el `tipo` (el update no permite cambiar el tipo,
  // así que no viene en el body). La validación de cantidad por tipo
  // (venta/acopio > 0, ajuste libre) se hace en el service, que sí conoce el
  // tipo de la fila actual.
  //
  // Consistencia origen/cantera_id: si el body fija origen != 'cantera' y a la
  // vez manda cantera_id no-null, se rechaza (no inflar la cta cte de una
  // cantera con un retiro que no salió de ella). Solo aplica cuando ambos
  // vienen en el patch — un update parcial que toca solo uno no se valida acá.
  if (v.origen != null && v.origen !== 'cantera' && v.cantera_id != null) {
    ctx.addIssue({ code: 'custom', path: ['cantera_id'], message: 'cantera_id solo aplica cuando el origen es cantera' })
  }
})

export const ListMovimientosQuerySchema = z.object({
  tipo:        z.enum(['venta', 'acopio', 'ajuste']).optional(),
  cliente_id:  z.coerce.number().optional(),
  material_id: z.coerce.number().optional(),
  fecha_desde: FECHA.optional(),
  fecha_hasta: FECHA.optional(),
})

// ── Canteras propias del negocio de áridos ────────────────────
export const CreateCanteraSchema = z.object({
  nombre:    z.string().min(1, 'El nombre es requerido'),
  direccion: z.string().nullable().optional(),
  localidad: z.string().nullable().optional(),
  obs:       z.string().nullable().optional(),
})

export const UpdateCanteraSchema = z.object({
  nombre:    z.string().min(1).optional(),
  direccion: z.string().nullable().optional(),
  localidad: z.string().nullable().optional(),
  obs:       z.string().nullable().optional(),
  activo:    z.boolean().optional(),
})

// ── Unidades (camión + chofer del negocio de áridos, con GPS) ──
// id_vehiculo_gps se elige del catálogo Mobile Quest en el form (más
// confiable que matchear por patente).
export const CreateUnidadSchema = z.object({
  nombre:  z.string().min(1, 'El nombre es requerido'),
  patente: z.string().min(1, 'La patente es requerida'),
  chofer:  z.string().nullable().optional(),
  id_vehiculo_gps: z.string().nullable().optional(),
  obs:     z.string().nullable().optional(),
})

export const UpdateUnidadSchema = z.object({
  nombre:  z.string().min(1).optional(),
  patente: z.string().min(1).optional(),
  chofer:  z.string().nullable().optional(),
  id_vehiculo_gps: z.string().nullable().optional(),
  obs:     z.string().nullable().optional(),
  activo:  z.boolean().optional(),
})

export const EtaQuerySchema = z.object({
  direccion: z.string().min(3, 'Falta la dirección de destino'),
})

// ── Municipios (zonas de entrega con recargo %) ───────────────
export const CreateMunicipioSchema = z.object({
  nombre:      z.string().min(1, 'El nombre es requerido'),
  // .max(100): un recargo > 100% es casi seguro un error de tipeo
  // (ej. escribir 1500 en vez de 15). Si alguna vez hay un caso real,
  // se sube el techo, pero hoy protege contra inflar precios por error.
  recargo_pct: z.number().min(0).max(100).default(0),
  obs:         z.string().nullable().optional(),
})

export const UpdateMunicipioSchema = z.object({
  nombre:      z.string().min(1).optional(),
  recargo_pct: z.number().min(0).max(100).optional(),
  obs:         z.string().nullable().optional(),
})

// ── Lista de precios de la cantera (concepto × zona, por viaje) ──
// Los conceptos son los del proveedor ("Viaje de Arena fina", "Viaje
// Mixto…") y los precios pueden variar por zona de entrega.
export const CreateCostoCanteraSchema = z.object({
  cantera_id:    z.number(),
  concepto:      z.string().min(1, 'El concepto es requerido'),
  zona:          z.string().nullable().optional(),
  material_id:   z.number().nullable().optional(),
  costo:         z.number().min(0),
  unidad:        z.enum(['m3', 'viaje', 'hora']).default('m3'),
  vigente_desde: FECHA,
  obs:           z.string().nullable().optional(),
})

export const UpdateCostoCanteraSchema = z.object({
  concepto:      z.string().min(1).optional(),
  zona:          z.string().nullable().optional(),
  costo:         z.number().min(0).optional(),
  unidad:        z.enum(['m3', 'viaje', 'hora']).optional(),
  vigente_desde: FECHA.optional(),
  obs:           z.string().nullable().optional(),
})

// ── Pagos a canteras (cta cte proveedor: retirado − pagado) ────
export const CreatePagoCanteraSchema = z.object({
  cantera_id: z.number(),
  fecha:      FECHA,
  monto:      z.number().positive('El monto debe ser mayor a 0'),
  medio:      z.enum(['efectivo', 'transferencia', 'cheque', 'otro']).default('transferencia'),
  obs:        z.string().nullable().optional(),
})

export const PagosCanteraQuerySchema = z.object({
  cantera_id: z.coerce.number().optional(),
})

// ── Cobros ────────────────────────────────────────────────────
// venta_ids: ventas/remitos que este cobro cancela (opcional — sin
// selección es un pago a cuenta clásico).
export const CreateCobroSchema = z.object({
  cliente_id: z.number(),
  fecha:      FECHA,
  monto:      z.number().positive('El monto debe ser mayor a 0'),
  medio:      z.enum(['efectivo', 'transferencia', 'cheque', 'otro']).default('transferencia'),
  obs:        z.string().nullable().optional(),
  venta_ids:  z.array(z.number()).optional().default([]),
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
export type CreateMunicipioDto    = z.infer<typeof CreateMunicipioSchema>
export type UpdateMunicipioDto    = z.infer<typeof UpdateMunicipioSchema>
export type CreateCostoCanteraDto = z.infer<typeof CreateCostoCanteraSchema>
export type UpdateCostoCanteraDto = z.infer<typeof UpdateCostoCanteraSchema>
export type CreateCanteraDto      = z.infer<typeof CreateCanteraSchema>
export type UpdateCanteraDto      = z.infer<typeof UpdateCanteraSchema>
export type CreateUnidadDto       = z.infer<typeof CreateUnidadSchema>
export type UpdateUnidadDto       = z.infer<typeof UpdateUnidadSchema>
export type CreatePrecioGlobalDto = z.infer<typeof CreatePrecioGlobalSchema>
export type UpdatePrecioGlobalDto = z.infer<typeof UpdatePrecioGlobalSchema>
export type CreatePagoCanteraDto  = z.infer<typeof CreatePagoCanteraSchema>
export type PagosCanteraQuery     = z.infer<typeof PagosCanteraQuerySchema>
