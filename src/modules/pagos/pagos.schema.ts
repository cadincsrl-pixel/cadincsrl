/**
 * Schemas zod del módulo Pagos (diseño v3 §5.1 + las 12 decisiones del 18/09).
 *
 * Lo que decide plata se valida ACÁ y en el service (no solo en el frontend).
 * Las listas cerradas (`CAMPOS_CONGELADOS`, `CAMPOS_QUE_DESAPRUEBAN`, formas
 * de pago, tipos de línea) son las mismas que el DDL: un test las compara.
 */
import { z } from 'zod'

// ── Listas cerradas (espejo del DDL) ────────────────────────────────────────

export const TIPOS_COMPROBANTE = ['A', 'B', 'C', 'recibo', 'ticket', 'otro'] as const
export const ESTADOS_FACTURA = ['pendiente', 'observada', 'aprobada', 'pagada_parcial', 'pagada', 'anulada'] as const
/**
 * Cómo se sugiere el vencimiento de las facturas de un proveedor (20260921g).
 *   dias           → fecha de la factura + plazo_pago_dias (lo de siempre; ABC S.A.).
 *   cierre_mensual → cuenta corriente: todo el mes cierra y vence junto (Silva).
 * El cálculo vive en el frontend (`vencimientoSugerido`), que es donde se
 * propone la fecha; acá sólo se valida y se guarda la configuración.
 */
export const VENCIMIENTO_MODOS = ['dias', 'cierre_mensual'] as const

export const FORMAS_PREVISTAS = ['efectivo', 'transferencia', 'tarjeta', 'cheque', 'echeq', 'debito_automatico', 'cta_cte', 'otro'] as const
/**
 * Forma REAL de una orden de pago que elige el contador. Sin `cta_cte` (quedar
 * en cuenta corriente es deuda, no pago) y, desde la decisión 7, sin
 * `aplicacion_anticipo` ni `nota_credito` como opción: la NC es una LÍNEA de
 * la OP, no una OP aparte. Una OP que solo aplica notas de crédito no mueve
 * plata y el backend le pone `forma_pago = 'nota_credito'` (CHECK
 * `pagos_ordenes_nc_chk`: es la única forma con `monto_pagado = 0`).
 */
export const FORMAS_PAGO_OP = ['efectivo', 'transferencia', 'cheque', 'echeq', 'tarjeta', 'debito_automatico', 'otro'] as const
/** Lo que puede tener guardado una OP (el CHECK de la tabla): las de entrada + `nota_credito`, que solo pone el backend. */
export const FORMAS_PAGO_OP_GUARDADAS = [...FORMAS_PAGO_OP, 'nota_credito'] as const
/** Comprobante de pago obligatorio por forma, solo si `monto_pagado > 0`. */
export const FORMAS_CON_COMPROBANTE_OBLIGATORIO = ['transferencia', 'echeq'] as const
export const FORMAS_CON_FECHA_COBRO = ['cheque', 'echeq'] as const
/** La RPC copia `cbu`/`alias_cbu` del padrón a la OP para estas formas. */
export const FORMAS_CON_CUENTA_DESTINO = ['transferencia', 'debito_automatico'] as const

export const TIPOS_LINEA = ['factura', 'a_cuenta', 'nota_credito'] as const
export const TIPOS_ADJ_FACTURA = ['factura', 'remito', 'orden_compra', 'otro'] as const
/** Sin `retencion` (decisión 6). `nota_credito` es el PDF de la NC de una línea (decisión 7). */
export const TIPOS_ADJ_ORDEN = ['comprobante_pago', 'nota_credito', 'otro'] as const

/** Con una línea de OP vigente, lo que mueve plata no se toca (409 FACTURA_CON_PAGOS { campos }). */
export const CAMPOS_CONGELADOS = ['proveedor_id', 'fecha', 'neto', 'iva', 'percepciones', 'otros', 'total'] as const
/** Lista cerrada de lo que devuelve una `aprobada` a `pendiente` (más las imputaciones y el CBU/alias del proveedor). */
export const CAMPOS_QUE_DESAPRUEBAN = [
  'proveedor_id', 'fecha', 'total', 'neto', 'iva', 'percepciones', 'otros', 'paga_cliente', 'vence_el', 'forma_pago_prevista',
] as const

export const TAB_FACTURA = ['facturas'] as const
export const TAB_PAGO = ['facturas', 'pagos'] as const
export const TAB_PROV_LECTURA = ['facturas', 'pagos', 'proveedores'] as const

export const MIME_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const
export const MAX_ADJUNTO_BYTES = 10 * 1024 * 1024
export const PREFIJO_COMPROBANTE_PENDIENTE = 'ordenes/pendientes/'

// ── Primitivas ──────────────────────────────────────────────────────────────

const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD')
const Monto = z.number().positive().multipleOf(0.01).max(999_999_999_999.99)
const MontoNoNeg = z.number().min(0).multipleOf(0.01).max(999_999_999_999.99)
const MontoConSigno = z.number().multipleOf(0.01).min(-999_999_999_999.99).max(999_999_999_999.99)
const Id = z.number().int().positive()
const BOOL_Q = z.enum(['1', '0', 'true', 'false']).optional()
export const esBoolQ = (v?: string) => v === '1' || v === 'true'

// ── Facturas ────────────────────────────────────────────────────────────────

export const ImputacionSchema = z.object({
  obra_cod: z.string().trim().min(1).max(40),
  monto:    Monto,
  obs:      z.string().trim().max(300).optional().default(''),
})
export type ImputacionDto = z.infer<typeof ImputacionSchema>

/** Adjunto ya subido a `ordenes/pendientes/<uuid>.<ext>` con la signed URL. */
export const AdjuntoPendienteSchema = z.object({
  tipo:           z.enum(TIPOS_ADJ_ORDEN).default('comprobante_pago'),
  storage_path:   z.string().min(1).max(500),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(MIME_PERMITIDOS),
})
export type AdjuntoPendienteDto = z.infer<typeof AdjuntoPendienteSchema>

/**
 * Un cheque o echeq. Va uno por fila: las preguntas que importan (qué cae esta
 * semana, cuánto hay en cartera, cuál rebotó) son por cheque, no por orden.
 * El número es obligatorio — decisión del dueño: al cargar el pago siempre se
 * sabe.
 */
export const ChequeSchema = z.object({
  numero:      z.string().trim().min(1).max(40),
  banco:       z.string().trim().max(80).optional().default(''),
  fecha_cobro: FechaISO,
  monto:       Monto,
  /** false = endosado de un tercero; ahí `librador` es obligatorio. */
  es_propio:   z.boolean().optional().default(true),
  librador:    z.string().trim().max(120).optional().default(''),
  obs:         z.string().trim().max(200).optional().default(''),
}).superRefine((c, ctx) => {
  if (!c.es_propio && !c.librador) {
    ctx.addIssue({ code: 'custom', path: ['librador'], message: 'CHEQUE_SIN_LIBRADOR' })
  }
})
export type ChequeDto = z.infer<typeof ChequeSchema>

/** La OP que nace con la factura cuando compras tilda «Ya está pagada». */
export const OrdenAlCargarSchema = z.object({
  fecha:        FechaISO,
  forma_pago:   z.enum(FORMAS_PAGO_OP),
  referencia:   z.string().trim().max(120).optional().default(''),
  fecha_cobro:  FechaISO.nullable().optional(),
  obs:          z.string().trim().max(1000).optional().default(''),
  comprobante:  AdjuntoPendienteSchema.nullable().optional(),
  // Un cheque es un cheque venga de donde venga: marcar una factura como ya
  // pagada con cheque también exige decir cuál.
  cheques:      z.array(ChequeSchema).max(50).optional().default([]),
})
export type OrdenAlCargarDto = z.infer<typeof OrdenAlCargarSchema>

/**
 * Cómo se piensa pagar con cheques / e-cheqs (20260923n): cuántos, la fecha
 * del primero y cada cuántos días los siguientes. No es plata: precarga el
 * Excel del Galicia y el modal de pago.
 */
export const PlanChequesSchema = z.object({
  cantidad:     z.number().int().min(1).max(24),
  primer_cobro: FechaISO,
  cada_dias:    z.number().int().min(1).max(365),
}).strict()

export const CreateFacturaSchema = z.object({
  proveedor_id:        Id,
  tipo_comprobante:    z.enum(TIPOS_COMPROBANTE),
  // OBLIGATORIO desde el 2026-09-21 (decisión del dueño). La pantalla lo pide
  // en dos campos —punto de venta y comprobante— y manda "0013-00402141".
  // Las 2 facturas que se cargaron sin número antes de la regla siguen como
  // están: la validación es de alta, no rompe lo ya guardado.
  numero:              z.string().trim().min(1).max(60),
  fecha:               FechaISO,
  vence_el:            FechaISO.nullable().optional(),
  neto:                MontoNoNeg.nullable().optional(),
  iva:                 MontoNoNeg.nullable().optional(),
  percepciones:        MontoNoNeg.nullable().optional(),
  otros:               MontoConSigno.nullable().optional(),
  total:               Monto,
  forma_pago_prevista: z.enum(FORMAS_PREVISTAS).default('transferencia'),
  descripcion:         z.string().trim().min(3).max(300),
  obs:                 z.string().trim().max(2000).optional().default(''),
  paga_cliente:        z.boolean().default(false),
  plan_cheques:        PlanChequesSchema.nullable().optional(),
  imputaciones:        z.array(ImputacionSchema).min(1).max(50),
  orden:               OrdenAlCargarSchema.nullable().optional(),
})
export type CreateFacturaDto = z.infer<typeof CreateFacturaSchema>

/**
 * PATCH estricto: sin `estado`, `aprobada_*`, `pagada_al_cargar`, `created_by`
 * ni nada que no esté listado. Una clave desconocida es 400, no se ignora.
 * `imputaciones` reemplaza el set; `motivo` es obligatorio si la factura ya
 * tiene pagos y se reimputa.
 */
export const UpdateFacturaSchema = z.object({
  proveedor_id:        Id.optional(),
  tipo_comprobante:    z.enum(TIPOS_COMPROBANTE).optional(),
  // Al editar no se puede BORRAR el número (ni null ni vacío), pero tampoco se
  // exige mandarlo: omitirlo significa «no lo toques», así que las 2 viejas sin
  // número se pueden seguir editando en otros campos.
  numero:              z.string().trim().min(1).max(60).optional(),
  fecha:               FechaISO.optional(),
  vence_el:            FechaISO.nullable().optional(),
  neto:                MontoNoNeg.nullable().optional(),
  iva:                 MontoNoNeg.nullable().optional(),
  percepciones:        MontoNoNeg.nullable().optional(),
  otros:               MontoConSigno.nullable().optional(),
  total:               Monto.optional(),
  forma_pago_prevista: z.enum(FORMAS_PREVISTAS).optional(),
  descripcion:         z.string().trim().min(3).max(300).optional(),
  obs:                 z.string().trim().max(2000).optional(),
  paga_cliente:        z.boolean().optional(),
  plan_cheques:        PlanChequesSchema.nullable().optional(),
  imputaciones:        z.array(ImputacionSchema).min(1).max(50).optional(),
  motivo:              z.string().trim().min(3).max(300).optional(),
}).strict()
export type UpdateFacturaDto = z.infer<typeof UpdateFacturaSchema>

export const MotivoSchema = z.object({
  motivo: z.string().trim().min(3).max(500),
})
export const CorregidaSchema = z.object({
  comentario: z.string().trim().max(500).optional().default(''),
})
export const AprobarLoteSchema = z.object({
  ids: z.array(Id).min(1).max(100),
})

export const FACTURAS_ORDEN = ['vencimiento', 'fecha', 'saldo'] as const
export const FACTURAS_VENCIMIENTO = ['vencidas', '7', '30', 'todas'] as const

export const ListFacturasQuerySchema = z.object({
  q:                z.string().max(200).optional(),
  proveedor_id:     z.coerce.number().int().positive().optional(),
  obra_cod:         z.string().max(40).optional(),
  centro_costo:     z.string().max(120).optional(),
  estado:           z.string().max(120).optional(),           // CSV whitelisteado contra ESTADOS_FACTURA
  tipo:             z.enum(TIPOS_COMPROBANTE).optional(),
  forma_pago:       z.enum(FORMAS_PREVISTAS).optional(),
  vencimiento:      z.enum(FACTURAS_VENCIMIENTO).optional(),
  desde:            FechaISO.optional(),
  hasta:            FechaISO.optional(),
  sin_adjunto:      BOOL_Q,
  sin_numero:       BOOL_Q,
  sin_revisar:      BOOL_Q,
  paga_cliente:     BOOL_Q,
  pagada_al_cargar: BOOL_Q,
  cuenta_cambiada:  BOOL_Q,
  es_interna:       BOOL_Q,
  anuladas:         BOOL_Q,
  archivadas:       BOOL_Q,
  orden:            z.enum(FACTURAS_ORDEN).default('vencimiento'),
  limit:            z.coerce.number().int().min(1).max(500).default(50),
  offset:           z.coerce.number().int().min(0).default(0),
})
export type ListFacturasQuery = z.infer<typeof ListFacturasQuerySchema>

export const FACTURAS_RESUMEN_GRUPOS = ['proveedor', 'centro_costo', 'obra', 'mes_emision', 'estado', 'vencimiento', 'forma_pago'] as const
export const FacturasResumenQuerySchema = ListFacturasQuerySchema.omit({ orden: true, limit: true, offset: true }).extend({
  grupo: z.enum(FACTURAS_RESUMEN_GRUPOS).default('estado'),
})
export type FacturasResumenQuery = z.infer<typeof FacturasResumenQuerySchema>

// ── Adjuntos ────────────────────────────────────────────────────────────────

export const UploadUrlFacturaSchema = z.object({
  tipo:           z.enum(TIPOS_ADJ_FACTURA),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(MIME_PERMITIDOS),
  size_bytes:     z.number().int().positive().max(MAX_ADJUNTO_BYTES),
})
export const RegistrarAdjFacturaSchema = z.object({
  tipo:           z.enum(TIPOS_ADJ_FACTURA),
  storage_path:   z.string().min(1).max(500),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(MIME_PERMITIDOS),
  obs:            z.string().trim().max(500).optional().default(''),
})
export const UploadUrlOrdenSchema = UploadUrlFacturaSchema.extend({ tipo: z.enum(TIPOS_ADJ_ORDEN) })
export const RegistrarAdjOrdenSchema = RegistrarAdjFacturaSchema.extend({ tipo: z.enum(TIPOS_ADJ_ORDEN) })
export type UploadUrlDto = z.infer<typeof UploadUrlFacturaSchema> | z.infer<typeof UploadUrlOrdenSchema>
export type RegistrarAdjDto = z.infer<typeof RegistrarAdjFacturaSchema> | z.infer<typeof RegistrarAdjOrdenSchema>

/** Comprobante ANTES de la fila de la OP: va a `ordenes/pendientes/`. */
export const UploadComprobantePendienteSchema = z.object({
  tipo:           z.enum(TIPOS_ADJ_ORDEN).default('comprobante_pago'),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(MIME_PERMITIDOS),
  size_bytes:     z.number().int().positive().max(MAX_ADJUNTO_BYTES),
})
export const BorrarPendienteSchema = z.object({
  storage_path: z.string().min(1).max(500),
})

// ── Órdenes de pago ─────────────────────────────────────────────────────────

/**
 * Línea de OP (decisión 7): `factura` (paga una factura aprobada), `a_cuenta`
 * (anticipo, sin factura) o `nota_credito` (acredita una factura aprobada:
 * baja el saldo sin que salga plata; lleva número y fecha de la NC).
 */
export const LineaOrdenSchema = z.object({
  tipo:       z.enum(TIPOS_LINEA).default('factura'),
  factura_id: Id.nullable().optional(),
  monto:      Monto,
  nc_numero:  z.string().trim().max(60).nullable().optional(),
  nc_fecha:   FechaISO.nullable().optional(),
}).superRefine((l, ctx) => {
  if (l.tipo === 'a_cuenta' && l.factura_id != null) {
    ctx.addIssue({ code: 'custom', path: ['factura_id'], message: 'Una línea a cuenta no lleva factura' })
  }
  if (l.tipo !== 'a_cuenta' && l.factura_id == null) {
    ctx.addIssue({ code: 'custom', path: ['factura_id'], message: 'La línea necesita factura_id' })
  }
  if (l.tipo !== 'nota_credito' && (l.nc_numero || l.nc_fecha)) {
    ctx.addIssue({ code: 'custom', path: ['nc_numero'], message: 'nc_numero/nc_fecha solo en líneas nota_credito' })
  }
  if (l.tipo === 'nota_credito' && (!l.nc_numero || !l.nc_fecha)) {
    ctx.addIssue({ code: 'custom', path: ['nc_numero'], message: 'NC_DATOS_REQUERIDOS' })
  }
})
export type LineaOrdenDto = z.infer<typeof LineaOrdenSchema>

export const CreateOrdenSchema = z.object({
  proveedor_id: Id,
  fecha:        FechaISO,
  fecha_cobro:  FechaISO.nullable().optional(),
  // Con plata es obligatoria; sin plata (solo notas de crédito) el service la
  // ignora y guarda 'nota_credito'.
  forma_pago:   z.enum(FORMAS_PAGO_OP).nullable().optional(),
  referencia:   z.string().trim().max(120).optional().default(''),
  obs:          z.string().trim().max(1000).optional().default(''),
  lineas:       z.array(LineaOrdenSchema).min(1).max(100),
  // Comprobante de pago y/o PDF de la NC, ya subidos a `ordenes/pendientes/`.
  adjuntos:     z.array(AdjuntoPendienteSchema).max(10).optional().default([]),
  cheques:      z.array(ChequeSchema).max(50).optional().default([]),
}).superRefine((o, ctx) => {
  const vistas = new Set<string>()
  o.lineas.forEach((l, i) => {
    if (l.factura_id == null) return
    const k = `${l.factura_id}|${l.tipo}`
    if (vistas.has(k)) ctx.addIssue({ code: 'custom', path: ['lineas', i, 'factura_id'], message: 'LINEA_DUPLICADA' })
    vistas.add(k)
  })
})
export type CreateOrdenDto = z.infer<typeof CreateOrdenSchema>

/**
 * A quién avisarle del pago. No es automático al emitir la OP por decisión del
 * dueño: de 9 proveedores, 1 tiene mail cargado, así que automático no saldría
 * casi nunca y el que emitió creería que el proveedor se enteró.
 *
 * `email_proveedor` es para el caso normal de hoy: el padrón no lo tiene y se
 * tipea al mandar. Con `guardar_email` queda en el padrón y no se vuelve a
 * pedir.
 */
export const AvisarPagoSchema = z.object({
  a_proveedor:     z.boolean().optional().default(false),
  a_contador:      z.boolean().optional().default(false),
  email_proveedor: z.string().trim().email().max(254).optional(),
  guardar_email:   z.boolean().optional().default(true),
}).superRefine((o, ctx) => {
  if (!o.a_proveedor && !o.a_contador) {
    ctx.addIssue({ code: 'custom', path: ['a_contador'], message: 'SIN_DESTINATARIOS' })
  }
})
export type AvisarPagoDto = z.infer<typeof AvisarPagoSchema>

export const UpdateOrdenSchema = z.object({
  referencia: z.string().trim().max(120).optional(),
  obs:        z.string().trim().max(1000).optional(),
}).strict()
export type UpdateOrdenDto = z.infer<typeof UpdateOrdenSchema>

/**
 * Devolución del proveedor (20260923g): anula la OP y la rehace con la NC
 * (y la plata que quedó, si es parcial). `devoluciones` = lo que devuelven
 * por factura; el PDF de la NC viene en `adjuntos` (ya subido a pendientes).
 */
export const DevolucionProveedorSchema = z.object({
  devoluciones: z.array(z.object({ factura_id: Id, monto: Monto })).min(1).max(100),
  nc_numero:    z.string().trim().min(1).max(40),
  nc_fecha:     FechaISO,
  motivo:       z.string().trim().max(500).optional().default(''),
  adjuntos:     z.array(AdjuntoPendienteSchema).min(1).max(5),
}).strict()
export type DevolucionProveedorDto = z.infer<typeof DevolucionProveedorSchema>

/** El contador marca la OP como registrada en Finnegans con su número (20260923c). */
export const RegistrarFinnegansSchema = z.object({
  numero_finnegans: z.string().trim().min(1).max(40),
}).strict()
export type RegistrarFinnegansDto = z.infer<typeof RegistrarFinnegansSchema>

export const ListOrdenesQuerySchema = z.object({
  q:                 z.string().max(200).optional(),
  proveedor_id:      z.coerce.number().int().positive().optional(),
  forma_pago:        z.enum(FORMAS_PAGO_OP_GUARDADAS).optional(),
  estado:            z.enum(['emitida', 'anulada']).optional(),
  desde:             FechaISO.optional(),
  hasta:             FechaISO.optional(),
  sin_comprobante:   BOOL_Q,
  en_cartera:        BOOL_Q,
  con_nota_credito:  BOOL_Q,
  /** Emitidas que el contador todavía no pasó a Finnegans (20260923c). */
  sin_registrar:     BOOL_Q,
  limit:             z.coerce.number().int().min(1).max(500).default(50),
  offset:            z.coerce.number().int().min(0).default(0),
})
export type ListOrdenesQuery = z.infer<typeof ListOrdenesQuerySchema>

export const ORDENES_RESUMEN_GRUPOS = ['mes_pago', 'proveedor', 'forma_pago', 'centro_costo', 'obra'] as const
export const OrdenesResumenQuerySchema = z.object({
  grupo:        z.enum(ORDENES_RESUMEN_GRUPOS).default('mes_pago'),
  eje:          z.enum(['op', 'cobro']).default('op'),
  desde:        FechaISO.optional(),
  hasta:        FechaISO.optional(),
  proveedor_id: z.coerce.number().int().positive().optional(),
  forma_pago:   z.enum(FORMAS_PAGO_OP_GUARDADAS).optional(),
})
export type OrdenesResumenQuery = z.infer<typeof OrdenesResumenQuerySchema>

// ── Proveedores (padrón propio) ─────────────────────────────────────────────

const Texto = (max: number) => z.string().trim().max(max)

export const CreateProveedorSchema = z.object({
  razon_social:    Texto(200).min(3),
  cuit:            Texto(20).nullable().optional(),
  alias_cbu:       Texto(40).nullable().optional(),
  cbu:             Texto(40).nullable().optional(),
  banco:           Texto(80).optional().default(''),
  plazo_pago_dias: z.number().int().min(0).max(365).optional().default(30),
  vencimiento_modo: z.enum(VENCIMIENTO_MODOS).optional().default('dias'),
  cierre_dia:       z.number().int().min(1).max(31).nullable().optional(),
  contacto:        Texto(120).optional().default(''),
  telefono:        Texto(40).optional().default(''),
  email:           Texto(120).optional().default(''),
  obs:             Texto(1000).optional().default(''),
})
export type CreateProveedorDto = z.infer<typeof CreateProveedorSchema>

/** Sin `activo` ni `baja_*`: eso va por /baja y /reactivar. */
export const UpdateProveedorSchema = z.object({
  razon_social:    Texto(200).min(3).optional(),
  cuit:            Texto(20).nullable().optional(),
  alias_cbu:       Texto(40).nullable().optional(),
  cbu:             Texto(40).nullable().optional(),
  banco:           Texto(80).optional(),
  plazo_pago_dias: z.number().int().min(0).max(365).optional(),
  vencimiento_modo: z.enum(VENCIMIENTO_MODOS).optional(),
  cierre_dia:       z.number().int().min(1).max(31).nullable().optional(),
  contacto:        Texto(120).optional(),
  telefono:        Texto(40).optional(),
  email:           Texto(120).optional(),
  obs:             Texto(1000).optional(),
}).strict()
export type UpdateProveedorDto = z.infer<typeof UpdateProveedorSchema>

/** La puerta del contador: solo datos de pago, ni razón social ni CUIT. */
export const DatosPagoSchema = UpdateProveedorSchema.omit({ razon_social: true, cuit: true, obs: true }).strict()
export type DatosPagoDto = z.infer<typeof DatosPagoSchema>

export const ListProveedoresQuerySchema = z.object({
  q:              z.string().max(200).optional(),
  inactivos:      BOOL_Q,
  sin_cuit:       BOOL_Q,
  sin_datos_pago: BOOL_Q,
  limit:          z.coerce.number().int().min(1).max(500).default(100),
  offset:         z.coerce.number().int().min(0).default(0),
})
export type ListProveedoresQuery = z.infer<typeof ListProveedoresQuerySchema>
