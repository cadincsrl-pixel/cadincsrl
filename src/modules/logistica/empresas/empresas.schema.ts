import { z } from 'zod'

export const CreateEmpresaSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  cuit:   z.string().optional().default(''),
  tel:    z.string().optional().default(''),
  email:  z.string().optional().default(''),
  obs:    z.string().optional().default(''),
  estado: z.enum(['activa', 'inactiva']).default('activa'),
  // 'liquido_producto': la empresa emite la liquidación y marcamos qué remitos
  // pagó. 'facturacion': CADINC emite una factura por cada viaje.
  modalidad_cobro: z.enum(['liquido_producto', 'facturacion']).default('liquido_producto'),
})

// No usar .partial() sobre el create: arrastra los .default() y zod
// inyecta valores por defecto en updates parciales, pisando datos válidos.
export const UpdateEmpresaSchema = z.object({
  nombre: z.string().min(1).optional(),
  cuit:   z.string().optional(),
  tel:    z.string().optional(),
  email:  z.string().optional(),
  obs:    z.string().optional(),
  estado: z.enum(['activa', 'inactiva']).optional(),
  modalidad_cobro: z.enum(['liquido_producto', 'facturacion']).optional(),
})

export const CreateTarifaEmpresaSchema = z.object({
  empresa_id:    z.number(),
  cantera_id:    z.number(),
  // null/ausente = tarifa general de la cantera; con valor = tarifa
  // específica para descargas en ese depósito (gana sobre la general).
  deposito_id:   z.number().nullable().optional(),
  // null/ausente = vale para cualquier unidad; 'chasis'/'batea' = específica
  // según el camión del viaje (chasis paga distinto en algunas empresas).
  tipo_unidad:   z.enum(['batea', 'chasis']).nullable().optional(),
  // null/ausente = tarifa única/base. Con valor ("Tarifa 2", nombre del
  // cliente final, etc.) = variante para la misma ruta: el tramo elige cuál
  // aplica vía tramos.tarifa_variante (match exacto, sin fallback a la base).
  variante:      z.string().trim().min(1).max(60).nullable().optional(),
  valor_ton:     z.number().min(0),
  vigente_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  obs:           z.string().optional().default(''),
  // Un alta con vigencia retroactiva repriecia lo ya cobrado: se frena con 409
  // salvo que el usuario confirme. No se persiste.
  confirmar_pisar_historico: z.boolean().optional(),
})

// Update solo permite cambiar valor/fecha/obs. La identidad
// (empresa+cantera+depósito+variante) es la del registro y se mantiene; si se
// quiere cambiar el par, se elimina y se crea una nueva.
export const UpdateTarifaEmpresaSchema = z.object({
  valor_ton:     z.number().min(0).optional(),
  vigente_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obs:           z.string().optional(),
  // Acuse de recibo del aviso "con esta tarifa ya se emitieron facturas". No es
  // una columna: el service lo saca del patch antes de escribir. Ver
  // TARIFA_YA_FACTURADA en empresas.service.ts.
  confirmar_pisar_historico: z.boolean().optional(),
})

// Body (opcional) del DELETE de una tarifa. Sólo lleva la confirmación: borrar
// una tarifa ya facturada deja esas facturas en $0/ton, así que el backend
// frena con TARIFA_YA_FACTURADA salvo que venga el acuse de recibo.
export const DeleteTarifaEmpresaSchema = z.object({
  confirmar_pisar_historico: z.boolean().optional(),
})

export type CreateEmpresaDto       = z.infer<typeof CreateEmpresaSchema>
export type UpdateEmpresaDto       = z.infer<typeof UpdateEmpresaSchema>
export type CreateTarifaEmpresaDto = z.infer<typeof CreateTarifaEmpresaSchema>
export type UpdateTarifaEmpresaDto = z.infer<typeof UpdateTarifaEmpresaSchema>
export type DeleteTarifaEmpresaDto = z.infer<typeof DeleteTarifaEmpresaSchema>
