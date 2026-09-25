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
  /** Días para el vencimiento de cobro de sus facturas (vence_el = fecha + plazo). */
  plazo_pago_dias: z.coerce.number().int().min(0).max(365).optional(),
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
  plazo_pago_dias: z.coerce.number().int().min(0).max(365).optional(),
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

// ── Contactos del cliente (20260925e/f) ─────────────────────────────────────
// La lista entera: la RPC `ventas_guardar_contactos` actualiza los que traen
// id, agrega los nuevos y borra los que no vienen. Mismo formato que los
// contactos de proveedores en Compras.
export const ROLES_CONTACTO = ['administracion', 'vendedor', 'compras', 'pagos', 'otro'] as const
export const ContactoSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  nombre: texto(120).optional().nullable(),
  rol: z.enum(ROLES_CONTACTO).default('administracion'),
  email: z.string().trim().toLowerCase().max(200)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'email con forma inválida')
    .optional().nullable(),
  telefono: texto(60).optional().nullable(),
  recibe_avisos: z.boolean().default(true),
  obs: texto(500).optional().nullable(),
}).refine((c) => !!(c.nombre?.trim() || c.email?.trim() || c.telefono?.trim()), {
  message: 'el contacto necesita al menos nombre, email o teléfono', path: ['nombre'],
})
export const ContactosSchema = z.object({ contactos: z.array(ContactoSchema).max(30) })
  .superRefine((d, ctx) => {
    const vistos = new Set<string>()
    d.contactos.forEach((c, i) => {
      const e = c.email?.trim()
      if (!e) return
      if (vistos.has(e)) ctx.addIssue({ code: 'custom', path: ['contactos', i, 'email'], message: `el email ${e} está repetido` })
      vistos.add(e)
    })
  })
export type ContactoDto = z.infer<typeof ContactoSchema>

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
  // Catálogo de productos (20260929b). `producto_id` manda; si no viene, la RPC
  // busca por el nombre (frontend viejo) y, sin ninguno, usa AVANCE DE OBRA.
  // Sin default acá: la RPC tiene el suyo.
  producto: z.string().trim().min(1).max(100).optional(),
  producto_id: z.coerce.number().int().positive().optional().nullable(),
  // Período de servicio (FchServDesde/Hasta). Opcional salvo que el producto
  // lo pida (PERIODO_REQUERIDO); con concepto 1 la RPC lo anula.
  fch_serv_desde: fechaIso.optional().nullable(),
  fch_serv_hasta: fechaIso.optional().nullable(),
  // Punto de venta (20260929d). Opcional: sin él, el backend usa el que ya
  // tenía el borrador, el por defecto de Ventas › Configuración o ARCA_PTO_VTA.
  // Si viene, tiene que estar activo (409 PTO_VTA_NO_HABILITADO).
  pto_vta: z.coerce.number().int().min(1).max(99998).optional().nullable(),
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
  producto: z.string().max(100).optional(),
  producto_id: z.coerce.number().int().positive().optional(),
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

// ── Productos de venta (20260929b) ─────────────────────────────────────────
// Solo forma: duplicados, último activo y concepto 1 sin período los valida la RPC.
const conceptoArca = z.coerce.number().int().refine((n) => n === 1 || n === 2 || n === 3, 'concepto ARCA: 1, 2 o 3')
export const ProductoCreateSchema = z.object({
  nombre: z.string().trim().min(2, 'nombre muy corto').max(100),
  descripcion: z.string().trim().max(500).optional(),
  concepto_arca: conceptoArca,
  pide_obra: z.boolean().optional().default(false),
  pide_periodo: z.boolean().optional().default(false),
  orden: z.coerce.number().int().min(0).max(9999).optional(),
}).strict()
export type ProductoCreateDto = z.infer<typeof ProductoCreateSchema>

export const ProductoUpdateSchema = z.object({
  nombre: z.string().trim().min(2, 'nombre muy corto').max(100).optional(),
  descripcion: z.string().trim().max(500).optional(),
  concepto_arca: conceptoArca.optional(),
  pide_obra: z.boolean().optional(),
  pide_periodo: z.boolean().optional(),
  activo: z.boolean().optional(),
  orden: z.coerce.number().int().min(0).max(9999).optional(),
}).strict().refine((d) => Object.keys(d).length > 0, 'nada para cambiar')
export type ProductoUpdateDto = z.infer<typeof ProductoUpdateSchema>

export const ListProductosQuerySchema = z.object({ incluir_inactivos: z.string().optional() })

// ── Puntos de venta (20260929d) ────────────────────────────────────────────
// El ambiente lo pone el backend (el del proceso). Duplicados, «por defecto»
// y número no editable los valida la RPC.
const nombrePv = z.string().trim().max(60)
const productoIds = z.array(z.coerce.number().int().positive()).max(50)
export const PuntoVentaCreateSchema = z.object({
  numero: z.coerce.number().int().min(1, 'número de 1 a 99998').max(99998, 'número de 1 a 99998'),
  nombre: nombrePv.optional(),
  por_defecto: z.boolean().optional(),
  producto_ids: productoIds.optional(),
  /** Guardar aunque ARCA no haya podido confirmarlo (PV_NO_VERIFICADO). */
  forzar: z.boolean().optional().default(false),
}).strict()
export type PuntoVentaCreateDto = z.infer<typeof PuntoVentaCreateSchema>

export const PuntoVentaUpdateSchema = z.object({
  nombre: nombrePv.optional(),
  activo: z.boolean().optional(),
  por_defecto: z.boolean().optional(),
  producto_ids: productoIds.optional(),
}).strict().refine((d) => Object.keys(d).length > 0, 'nada para cambiar')
export type PuntoVentaUpdateDto = z.infer<typeof PuntoVentaUpdateSchema>

export const ListPuntosVentaQuerySchema = z.object({ ambiente: z.enum(['homo', 'prod']).optional() })

// ── Montos de ARCA con vigencia (20260929e) ────────────────────────────────
// No se editan: un valor nuevo es una fila nueva. Duplicado, retroactivo y
// «ya vigente» los valida la RPC.
const claveParametro = z.enum(['monto_minimo_fce', 'tope_cf_identificacion'])
export const ParametroCreateSchema = z.object({
  clave: claveParametro,
  valor: z.coerce.number().positive('tiene que ser mayor que cero').max(999_999_999_999.99, 'demasiado grande')
    .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'hasta dos decimales'),
  vigente_desde: fechaIso,
  fuente: z.string().trim().max(120).optional(),
  obs: z.string().trim().max(500).optional(),
  /** Guardar aunque haya facturas autorizadas desde esa fecha (PARAMETRO_RETROACTIVO). */
  forzar: z.boolean().optional().default(false),
}).strict()
export type ParametroCreateDto = z.infer<typeof ParametroCreateSchema>

export const ListParametrosQuerySchema = z.object({ clave: claveParametro.optional() })
export const ParametrosVigentesQuerySchema = z.object({ fecha: fechaIso.optional() })

export const EmitirSchema = z.object({ forzar: z.boolean().optional().default(false) })
export const MotivoSchema = z.object({ motivo: z.string().max(1000).optional().nullable() })
export const RegistrarFinnegansSchema = z.object({
  numero_finnegans: z.string().trim().min(1, 'número de Finnegans vacío').max(100),
})

// ═══════════════════════ Cobranzas, saldos iniciales y deudores ═══════════════
// Contrato «Ventas — Cobranzas y estado de deudores (v1)» + base 20260924k…n.
// Solo forma: las reglas (saldos, mismo cliente, cheques, totales) las valida
// la RPC bajo FOR UPDATE, que es la fuente de verdad.

/** 'prod' por defecto; 'homo' para probar con facturas de homologación. */
export const AmbienteCobranzaSchema = z.enum(['prod', 'homo'])
export type AmbienteCobranza = z.infer<typeof AmbienteCobranzaSchema>
export const AmbienteQuerySchema = z.object({ ambiente: AmbienteCobranzaSchema.optional() })

const importe = z.coerce.number().positive('importe > 0').max(1e13)
const idPos = z.coerce.number().int().positive()
const textoOpc = (max: number) => z.string().max(max).optional().nullable()

export const MedioCobroSchema = z.object({
  forma: z.enum(['transferencia', 'cheque', 'echeq', 'efectivo', 'otro']),
  importe,
  cuenta_bancaria_id: idPos.optional().nullable(),
  cheque_numero: textoOpc(50),
  cheque_banco: textoOpc(100),
  cheque_librador: textoOpc(200),
  cheque_fecha_cobro: fechaIso.optional().nullable(),
  obs: textoOpc(1000),
})

export const TIPOS_RETENCION = ['iibb', 'tem', 'suss', 'ganancias', 'iva', 'otra'] as const
export const RetencionCobroSchema = z.object({
  tipo: z.enum(TIPOS_RETENCION),
  importe,
  jurisdiccion: textoOpc(100),
  certificado_numero: textoOpc(100),
  fecha: fechaIso.optional().nullable(),
  obs: textoOpc(1000),
  /** Certificado subido antes con POST /cobros/retenciones/upload-url (retenciones/pendientes/…). */
  adjunto_path: z.string().max(300).optional().nullable(),
  adjunto_nombre: textoOpc(255),
  adjunto_mime: textoOpc(100),
})
export type RetencionCobroDto = z.infer<typeof RetencionCobroSchema>

/** Destino de una imputación: exactamente uno de factura_id (ERP) o externo_id. */
export const ItemImputacionSchema = z.object({
  factura_id: idPos.optional().nullable(),
  externo_id: idPos.optional().nullable(),
  importe,
}).refine((i) => (i.factura_id != null) !== (i.externo_id != null), { message: 'factura_id o externo_id (uno solo)', path: ['factura_id'] })
export type ItemImputacionDto = z.infer<typeof ItemImputacionSchema>

/** Documentación del cliente en el cobro (20260924q): comprobante de pago, orden de pago del cliente u otro. */
export const TIPOS_ADJUNTO_COBRO = ['comprobante_pago', 'orden_pago', 'otro'] as const
export const AdjuntoCobroSchema = z.object({
  tipo: z.enum(TIPOS_ADJUNTO_COBRO),
  /** Subido antes con POST /cobros/adjuntos/upload-url (cobros/pendientes/…). */
  storage_path: z.string().min(1).max(300),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime: textoOpc(100),
  obs: textoOpc(1000),
})
export type AdjuntoCobroDto = z.infer<typeof AdjuntoCobroSchema>

export const RegistrarCobroSchema = z.object({
  cobro: z.object({
    fecha: fechaIso.optional().nullable(),
    cliente_id: idPos,
    obs: textoOpc(2000),
    ambiente: AmbienteCobranzaSchema.optional(),
  }),
  medios: z.array(MedioCobroSchema).max(50).optional().default([]),
  retenciones: z.array(RetencionCobroSchema).max(50).optional().default([]),
  imputaciones: z.array(ItemImputacionSchema).max(500).optional().default([]),
  adjuntos: z.array(AdjuntoCobroSchema).max(20).optional().default([]),
})
export type RegistrarCobroDto = z.infer<typeof RegistrarCobroSchema>

export const ImputarSchema = z.object({
  items: z.array(ItemImputacionSchema).min(1, 'al menos una imputación').max(500),
  fecha: fechaIso.optional().nullable(),
})
export type ImputarDto = z.infer<typeof ImputarSchema>

export const CompensarSchema = z.object({
  nc: z.object({
    factura_id: idPos.optional().nullable(),
    externo_id: idPos.optional().nullable(),
  }).refine((n) => (n.factura_id != null) !== (n.externo_id != null), { message: 'nc.factura_id o nc.externo_id (uno solo)', path: ['factura_id'] }),
  items: z.array(ItemImputacionSchema).min(1, 'al menos una imputación').max(500),
  fecha: fechaIso.optional().nullable(),
})
export type CompensarDto = z.infer<typeof CompensarSchema>

export const AnularCobroSchema = z.object({ motivo: z.string().trim().min(1, 'motivo vacío').max(1000) })
export const AnularImputacionSchema = z.object({ motivo: z.string().max(1000).optional().nullable() })

export const ListCobrosQuerySchema = z.object({
  cliente_id: idPos.optional(),
  desde: fechaIso.optional(),
  hasta: fechaIso.optional(),
  estado: z.enum(['vigente', 'anulado']).optional(),
  con_a_cuenta: z.string().optional(),
  q: z.string().max(200).optional(),
  ambiente: AmbienteCobranzaSchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(50),
})
export type ListCobrosQuery = z.infer<typeof ListCobrosQuerySchema>

export const ListImputacionesQuerySchema = z.object({
  cobro_id: idPos.optional(),
  factura_id: idPos.optional(),
  externo_id: idPos.optional(),
  nc_factura_id: idPos.optional(),
  nc_externo_id: idPos.optional(),
  incluir_anuladas: z.string().optional(),
})
export type ListImputacionesQuery = z.infer<typeof ListImputacionesQuerySchema>

export const UploadRetencionSchema = z.object({
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type: z.string().max(100),
  size_bytes: z.coerce.number().int().positive(),
})
export type UploadRetencionDto = z.infer<typeof UploadRetencionSchema>

export const AdjuntoRetencionSchema = z.object({
  adjunto_path: z.string().min(1).max(300),
  adjunto_nombre: textoOpc(255),
  adjunto_mime: textoOpc(100),
})
export type AdjuntoRetencionDto = z.infer<typeof AdjuntoRetencionSchema>

export const PendientesQuerySchema = z.object({
  ambiente: AmbienteCobranzaSchema.optional(),
  al: fechaIso.optional(),
})

export const DeudoresQuerySchema = z.object({
  al: fechaIso.optional(),
  ambiente: AmbienteCobranzaSchema.optional(),
  q: z.string().max(200).optional(),
})
export type DeudoresQuery = z.infer<typeof DeudoresQuerySchema>

export const EstadoCuentaQuerySchema = z.object({
  desde: fechaIso.optional(),
  hasta: fechaIso.optional(),
  ambiente: AmbienteCobranzaSchema.optional(),
})
export type EstadoCuentaQuery = z.infer<typeof EstadoCuentaQuerySchema>

export const VencimientoSchema = z.object({
  /** null = volver al automático (fecha + plazo del cliente; FCE: fch_vto_pago). */
  vence_el: fechaIso.nullable(),
})

// ── Saldos iniciales (comprobantes externos) ────────────────────────────────

export const CBTE_TIPOS_EXTERNOS = [1, 2, 3, 6, 7, 8, 60, 61, 201, 202, 203] as const
const CbteTipoExternoSchema = z.coerce.number().int()
  .refine((n) => (CBTE_TIPOS_EXTERNOS as readonly number[]).includes(n), 'cbte_tipo: 1, 2, 3, 6, 7, 8, 60, 61, 201, 202 o 203')
const monto0 = z.coerce.number().min(0).max(1e13)

const ExternoBase = {
  cliente_id: idPos,
  /** Código de ARCA. Alternativa: tipo (FC/ND/NC) + letra (A/B). */
  cbte_tipo: CbteTipoExternoSchema.optional().nullable(),
  tipo: z.enum(['FC', 'ND', 'NC']).optional().nullable(),
  letra: z.enum(['A', 'B']).optional().nullable(),
  pto_vta: z.coerce.number().int().min(0).max(99999),
  numero: z.coerce.number().int().min(1).max(99999999),
  fecha: fechaIso,
  vence_el: fechaIso.optional().nullable(),
  neto: monto0.optional().nullable(),
  no_gravado: monto0.optional().nullable(),
  exento: monto0.optional().nullable(),
  iva: monto0.optional().nullable(),
  total: z.coerce.number().positive('total > 0').max(1e13),
  /** Deuda (FC/ND) o crédito sin usar (NC) a la fecha de corte. Default = total. */
  saldo_inicial: monto0.optional().nullable(),
  saldo_a_revisar: z.boolean().optional(),
  saldo_motivo: textoOpc(1000),
  origen: z.enum(['finnegans', 'portal', 'otro']).optional(),
  obs: textoOpc(2000),
}

export const CreateExternoSchema = z.object(ExternoBase)
  .refine((e) => e.cbte_tipo != null || (e.tipo != null && e.letra != null), { message: 'cbte_tipo, o tipo y letra', path: ['cbte_tipo'] })
export type CreateExternoDto = z.infer<typeof CreateExternoSchema>

export const UpdateExternoSchema = z.object({
  cliente_id: idPos.optional(),
  cbte_tipo: CbteTipoExternoSchema.optional(),
  pto_vta: z.coerce.number().int().min(0).max(99999).optional(),
  numero: z.coerce.number().int().min(1).max(99999999).optional(),
  fecha: fechaIso.optional(),
  vence_el: fechaIso.optional(),
  neto: monto0.optional(),
  no_gravado: monto0.optional(),
  exento: monto0.optional(),
  iva: monto0.optional(),
  total: z.coerce.number().positive().max(1e13).optional(),
  saldo_inicial: monto0.optional(),
  saldo_motivo: textoOpc(1000),
  origen: z.enum(['finnegans', 'portal', 'otro']).optional(),
  obs: textoOpc(2000),
})
export type UpdateExternoDto = z.infer<typeof UpdateExternoSchema>

/**
 * Lo que liquidó el comisionista (Casilda) en una CVLP 060/061, después de su
 * comisión (20260927d). El asiento de la CVLP va por el neto liquidado
 * (contador 24/09). null = borrarlo.
 */
export const LiquidoExternoSchema = z.object({
  // El signo y el tope contra el total los valida el service (400 LIQUIDO_INVALIDO).
  liquido: z.number().max(999_999_999_999.99).nullable(),
}).strict()
export type LiquidoExternoDto = z.infer<typeof LiquidoExternoSchema>

export const ListExternosQuerySchema = z.object({
  cliente_id: idPos.optional(),
  cbte_tipo: z.string().regex(/^[\d,]*$/).optional(),
  tipo: z.enum(['FC', 'ND', 'NC']).optional(),
  a_revisar: z.string().optional(),
  con_saldo: z.string().optional(),
  origen: z.enum(['finnegans', 'portal', 'otro']).optional(),
  desde: fechaIso.optional(),
  hasta: fechaIso.optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).optional().default(100),
})
export type ListExternosQuery = z.infer<typeof ListExternosQuerySchema>

const celda = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const ImportarExternosSchema = z.object({
  /** Filas ya parseadas: claves de la RPC (cbte_tipo, pto_vta, numero…) o los encabezados del Excel de ARCA. */
  filas: z.array(z.record(z.string(), celda)).max(2000).optional(),
  /** Alternativa: CSV con encabezado (coma, punto y coma o tab). */
  csv: z.string().max(5_000_000).optional(),
  confirmar: z.boolean().optional().default(false),
  origen: z.enum(['finnegans', 'portal', 'otro']).optional().default('portal'),
}).refine((b) => (b.filas?.length ?? 0) > 0 || (b.csv ?? '').trim().length > 0, { message: 'filas o csv', path: ['filas'] })
export type ImportarExternosDto = z.infer<typeof ImportarExternosSchema>

export const MarcarExternosSchema = z.object({
  ids: z.array(idPos).min(1, 'al menos un comprobante').max(2000),
  accion: z.enum(['cobrada', 'impaga', 'revisar']),
  motivo: textoOpc(1000),
  fecha: fechaIso.optional().nullable(),
})
export type MarcarExternosDto = z.infer<typeof MarcarExternosSchema>

// ── Libro IVA Digital de Ventas (RG 4597) ───────────────────────────────────
export const LidVentasQuerySchema = z.object({
  periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'período AAAA-MM'),
  incluir_cvlp: z.enum(['0', '1', 'true', 'false']).optional(),
})
export const LidVentasDescargarQuerySchema = LidVentasQuerySchema.extend({
  archivo: z.enum(['cbte', 'alicuotas']),
})

// ── Libro IVA Digital de Compras (RG 4597) ──────────────────────────────────
export const LidComprasQuerySchema = z.object({
  periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'período AAAA-MM'),
})
export const LidComprasDescargarQuerySchema = LidComprasQuerySchema.extend({
  archivo: z.enum(['cbte', 'alicuotas']),
})
