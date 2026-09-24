/**
 * Schemas zod del módulo Facturación (contrato de la API, fase 1).
 *
 * Solo forma: las reglas de negocio (letra, obra, fecha, saldo de
 * la NC, totales) las valida la RPC `ventas_guardar_borrador`, que es la
 * fuente de verdad. Acá se rechaza lo que ni siquiera tiene sentido mandar.
 */
import { z } from 'zod'

export const esBoolQ = (v?: string) => v === '1' || v === 'true'

const texto = (max: number) => z.string().max(max)
const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD')

// ── Clientes ────────────────────────────────────────────────────────────────

export const ListClientesQuerySchema = z.object({
  q: z.string().max(200).optional(),
  incluir_inactivos: z.string().optional(),
})

const DocTipoSchema = z.coerce.number().int().refine((n) => [80, 86, 96, 99].includes(n), 'doc_tipo: 80, 86, 96 o 99')

export const CreateClienteSchema = z.object({
  razon_social: z.string().trim().min(2, 'razón social: al menos 2 letras').max(200),
  doc_tipo: DocTipoSchema.default(80),
  doc_nro: z.union([z.string(), z.number()]).transform((v) => String(v)),
  condicion_iva_id: z.coerce.number().int().min(1).max(16),
  domicilio: texto(300).optional().nullable(),
  provincia: texto(100).optional().nullable(),
  email: texto(200).optional().nullable(),
  obs: texto(2000).optional().nullable(),
  cuenta_fce_id: z.coerce.number().int().positive().optional().nullable(),
})
export type CreateClienteDto = z.infer<typeof CreateClienteSchema>

export const UpdateClienteSchema = z.object({
  razon_social: z.string().trim().min(2).max(200).optional(),
  doc_tipo: DocTipoSchema.optional(),
  doc_nro: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
  condicion_iva_id: z.coerce.number().int().min(1).max(16).optional(),
  domicilio: texto(300).optional().nullable(),
  provincia: texto(100).optional().nullable(),
  email: texto(200).optional().nullable(),
  obs: texto(2000).optional().nullable(),
  cuenta_fce_id: z.coerce.number().int().positive().optional().nullable(),
})
export type UpdateClienteDto = z.infer<typeof UpdateClienteSchema>

export const FceClienteQuerySchema = z.object({
  refrescar: z.string().optional(),
  fecha: fechaIso.optional(),
})

// ── Cuentas bancarias (FCE) ─────────────────────────────────────────────────

export const CuentaSchema = z.object({
  banco: z.string().trim().min(2, 'banco: al menos 2 letras').max(100),
  cbu: z.string().max(40),
  alias: texto(40).optional().nullable(),
  es_default: z.boolean().optional().default(false),
  obs: texto(1000).optional().nullable(),
})
export type CuentaDto = z.infer<typeof CuentaSchema>

export const UpdateCuentaSchema = z.object({
  banco: z.string().trim().min(2).max(100).optional(),
  cbu: z.string().max(40).optional(),
  alias: texto(40).optional().nullable(),
  es_default: z.boolean().optional(),
  obs: texto(1000).optional().nullable(),
})
export type UpdateCuentaDto = z.infer<typeof UpdateCuentaSchema>

export const ListCuentasQuerySchema = z.object({ incluir_inactivas: z.string().optional() })

export const ObrasClienteSchema = z.object({
  obra_cods: z.array(z.string().trim().min(1).max(100)).max(500),
})

// ── Facturas ────────────────────────────────────────────────────────────────

export const RenglonSchema = z.object({
  descripcion: z.string().trim().min(1, 'descripción vacía').max(4000),
  cantidad: z.coerce.number().positive().max(1e10).optional().default(1),
  unidad: texto(50).optional().nullable(),
  precio_unit: z.coerce.number().min(0).max(1e13),
  alicuota_id: z.coerce.number().int().refine((n) => [3, 4, 5, 6, 8, 9].includes(n), 'alícuota: 3, 4, 5, 6, 8 o 9').optional().default(5),
})

export const FacturaCabeceraSchema = z.object({
  // Opcional: si no viene, el backend lo deriva del cliente (y de la factura
  // asociada en una NC). Si viene, tiene que ser de esa letra.
  cbte_tipo: z.coerce.number().int().optional().nullable(),
  cliente_id: z.coerce.number().int().positive(),
  producto: z.enum(['AVANCE DE OBRA', 'TRANSPORTE']).optional().default('AVANCE DE OBRA'),
  // La obra ES el centro de costo (23/09): obligatoria en AVANCE DE OBRA (lo
  // valida la RPC: OBRA_REQUERIDA). `centro_costo` lo deriva la base; si un
  // cliente viejo lo manda, zod lo descarta.
  obra_cod: z.string().max(100).optional().nullable(),
  fecha_cbte: fechaIso.optional().nullable(),
  provincia_origen: texto(100).optional().nullable(),
  provincia_destino: texto(100).optional().nullable(),
  condicion_pago: texto(100).optional().nullable(),
  remitos: texto(1000).optional().nullable(),
  observaciones: texto(4000).optional().nullable(),
  obs_interna: texto(4000).optional().nullable(),
  asociada_id: z.coerce.number().int().positive().optional().nullable(),
  // FCE MiPyME (fase 6). Solo cuentan en la 201 (cuenta, vencimiento,
  // transmisión, referencia) y en la 203 (anulación); en otro tipo se ignoran.
  fce_cuenta_id: z.coerce.number().int().positive().optional().nullable(),
  fch_vto_pago: fechaIso.optional().nullable(),
  fce_transmision: z.enum(['SCA', 'ADC']).optional().nullable(),
  fce_referencia: texto(50).optional().nullable(),
  nc_anulacion: z.enum(['S', 'N']).optional().nullable(),
})

export const GuardarFacturaSchema = z.object({
  factura: FacturaCabeceraSchema,
  renglones: z.array(RenglonSchema).min(1, 'al menos un renglón').max(200),
  forzar: z.boolean().optional().default(false),
})
export type GuardarFacturaDto = z.infer<typeof GuardarFacturaSchema>

const idsCsv = z.string().regex(/^[\w ,-]*$/).optional()

export const ListFacturasQuerySchema = z.object({
  estado: idsCsv,
  cbte_tipo: z.string().regex(/^[\d,]*$/).optional(),
  cliente_id: z.coerce.number().int().positive().optional(),
  obra_cod: z.string().max(100).optional(),
  producto: z.enum(['AVANCE DE OBRA', 'TRANSPORTE']).optional(),
  desde: fechaIso.optional(),
  hasta: fechaIso.optional(),
  finnegans: z.enum(['pendiente', 'registrada']).optional(),
  q: z.string().max(200).optional(),
  ambiente: z.enum(['homo', 'prod', 'todos']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(50),
})
export type ListFacturasQuery = z.infer<typeof ListFacturasQuerySchema>

export const ResumenQuerySchema = z.object({
  desde: fechaIso.optional(),
  hasta: fechaIso.optional(),
  ambiente: z.enum(['homo', 'prod', 'todos']).optional(),
})
export type ResumenQuery = z.infer<typeof ResumenQuerySchema>

export const EmitirSchema = z.object({ forzar: z.boolean().optional().default(false) })
export const MotivoSchema = z.object({ motivo: z.string().max(1000).optional().nullable() })
export const RegistrarFinnegansSchema = z.object({
  numero_finnegans: z.string().trim().min(1, 'número de Finnegans vacío').max(100),
})
