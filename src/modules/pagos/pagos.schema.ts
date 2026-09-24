/**
 * Schemas zod del módulo Pagos (diseño v3 §5.1 + las 12 decisiones del 18/09).
 *
 * Lo que decide plata se valida ACÁ y en el service (no solo en el frontend).
 * Las listas cerradas (`CAMPOS_CONGELADOS`, `CAMPOS_QUE_DESAPRUEBAN`, formas
 * de pago, tipos de línea) son las mismas que el DDL: un test las compara.
 */
import { z } from 'zod'
import { ALICUOTA_IDS, CBTE_TIPOS_ARCA, TIPOS_TRIBUTO, esCbteNotaCredito } from './lectura/arca.js'

// ── Listas cerradas (espejo del DDL) ────────────────────────────────────────

export const TIPOS_COMPROBANTE = ['A', 'B', 'C', 'recibo', 'ticket', 'otro'] as const
/**
 * Qué es el comprobante (20260925a). Una nota de crédito de proveedor es un
 * comprobante más de `pagos_facturas`, con su desglose, su reparto por obra y
 * a qué facturas acredita (`pagos_nc_aplicaciones`). Baja la deuda cuando se
 * APRUEBA; mientras tanto lo que declara aplicar queda reservado.
 */
export const CLASES = ['factura', 'nota_credito'] as const
/** Letras con que ARCA emite una NC (CHECK `pagos_facturas_nc_chk`). */
export const TIPOS_COMPROBANTE_NC = ['A', 'B', 'C'] as const
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
 * en cuenta corriente es deuda, no pago), sin `aplicacion_anticipo` y sin
 * `nota_credito`: desde el 2026-09-25 la NC es un comprobante propio y una OP
 * siempre mueve plata.
 */
export const FORMAS_PAGO_OP = ['efectivo', 'transferencia', 'cheque', 'echeq', 'tarjeta', 'debito_automatico', 'otro'] as const
/** Lo que puede tener guardado una OP (el CHECK de la tabla): las de entrada + `nota_credito`, histórica (hoy 0 filas). */
export const FORMAS_PAGO_OP_GUARDADAS = [...FORMAS_PAGO_OP, 'nota_credito'] as const
/** Comprobante de pago obligatorio por forma, solo si `monto_pagado > 0`. */
export const FORMAS_CON_COMPROBANTE_OBLIGATORIO = ['transferencia', 'echeq'] as const
export const FORMAS_CON_FECHA_COBRO = ['cheque', 'echeq'] as const
/** La RPC copia `cbu`/`alias_cbu` del padrón a la OP para estas formas. */
export const FORMAS_CON_CUENTA_DESTINO = ['transferencia', 'debito_automatico'] as const

/** Tipos de línea que pueden estar GUARDADOS (lectura). `nota_credito` es histórico: 0 filas y CHECK `pagos_orden_lineas_sin_nc_chk`. */
export const TIPOS_LINEA = ['factura', 'a_cuenta', 'nota_credito'] as const
/** Lo que se acepta al registrar una OP (20260925a): la NC ya no es una línea. */
export const TIPOS_LINEA_ENTRADA = ['factura', 'a_cuenta'] as const
export const TIPOS_ADJ_FACTURA = ['factura', 'remito', 'orden_compra', 'otro'] as const
/** Sin `retencion` (decisión 6). `nota_credito` queda por los adjuntos viejos; la NC nueva lleva su PDF como adjunto de la NC. */
export const TIPOS_ADJ_ORDEN = ['comprobante_pago', 'nota_credito', 'otro', 'recibo_proveedor', 'cheque'] as const

/** Con una línea de OP vigente, lo que mueve plata no se toca (409 FACTURA_CON_PAGOS { campos }). */
export const CAMPOS_CONGELADOS = ['proveedor_id', 'fecha', 'neto', 'iva', 'percepciones', 'otros', 'no_gravado', 'exento', 'total'] as const
/** Lista cerrada de lo que devuelve una `aprobada` a `pendiente` (más las imputaciones y el CBU/alias del proveedor). */
export const CAMPOS_QUE_DESAPRUEBAN = [
  'proveedor_id', 'fecha', 'total', 'neto', 'iva', 'percepciones', 'otros', 'no_gravado', 'exento', 'paga_cliente', 'vence_el', 'forma_pago_prevista',
] as const

export const TAB_FACTURA = ['facturas'] as const
export const TAB_PAGO = ['facturas', 'pagos'] as const
export const TAB_PROV_LECTURA = ['facturas', 'pagos', 'proveedores'] as const

export const MIME_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const
export const MAX_ADJUNTO_BYTES = 10 * 1024 * 1024
export const PREFIJO_COMPROBANTE_PENDIENTE = 'ordenes/pendientes/'
/** La factura «archivo primero» se sube acá antes de existir (20260924u). */
export const PREFIJO_LECTURA = 'facturas/lecturas/'

// ── Primitivas ──────────────────────────────────────────────────────────────

const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD')
const Monto = z.number().positive().multipleOf(0.01).max(999_999_999_999.99)
const MontoNoNeg = z.number().min(0).multipleOf(0.01).max(999_999_999_999.99)
const MontoConSigno = z.number().multipleOf(0.01).min(-999_999_999_999.99).max(999_999_999_999.99)
const Id = z.number().int().positive()
/**
 * Concepto de la factura (20260925i–n): UNO por comprobante, de la lista
 * `pagos_conceptos` que ajusta el contador. Obligatorio en el alta (la base
 * lo exige recién con `20260925n`; el schema se adelanta). El mensaje es el
 * código, para que el modal lo muestre bajo el Select.
 */
const ConceptoId = z.number({ error: 'CONCEPTO_REQUERIDO' }).int('CONCEPTO_INVALIDO').positive('CONCEPTO_INVALIDO')
const BOOL_Q = z.enum(['1', '0', 'true', 'false']).optional()
export const esBoolQ = (v?: string) => v === '1' || v === 'true'

/**
 * Período IVA (20260927a): el mes en que el comprobante se informa en el
 * Libro IVA compras y la posición. Acepta 'YYYY-MM' o 'YYYY-MM-01' y
 * devuelve siempre el día 1. Nunca anterior al mes de la fecha (lo valida el
 * service con la fecha, y la base con un CHECK y su trigger).
 */
export const PeriodoIva = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/, 'PERIODO_IVA_INVALIDO')
  .transform((s) => (s.length === 7 ? `${s}-01` : s))

/** Cómo entró la factura (20260927b). */
export const ORIGENES_CARGA = ['manual', 'arca_recibidos'] as const

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
  /**
   * La foto del cheque (20260925p): el path PENDIENTE que devolvió
   * `POST /cheques/leer` (`ordenes/pendientes/<uuid>.<ext>`). Al emitir la OP
   * se adjunta como tipo `cheque` con obs «Cheque N° X». No va a la RPC como
   * campo del cheque.
   */
  foto_path:   z.string().min(1).max(500).nullable().optional(),
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
  /** De qué cuenta propia (tesoreria_cuentas) salió la plata. Opcional (20260926g). */
  cuenta_origen_id: Id.nullable().optional(),
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

/**
 * El desglose como lo pide ARCA (20260924u). `iva_detalle` = una fila por
 * alícuota (códigos ARCA 3/4/5/6/8/9); `tributos` = percepciones e
 * impuestos. Mandarlos reemplaza el detalle guardado; omitirlos no lo toca.
 * Con detalle, la base DERIVA neto, iva, percepciones y otros.
 */
export const IvaDetalleSchema = z.object({
  alicuota_id: z.number().int().refine((n) => (ALICUOTA_IDS as readonly number[]).includes(n), 'ALICUOTA_INVALIDA'),
  base_imp:    MontoNoNeg,
  importe:     MontoNoNeg,
})
export type IvaDetalleDto = z.infer<typeof IvaDetalleSchema>
export const TributoSchema = z.object({
  tipo:         z.enum(TIPOS_TRIBUTO),
  jurisdiccion: z.string().trim().max(80).nullable().optional(),
  descripcion:  z.string().trim().max(200).optional().default(''),
  alicuota:     z.number().min(0).max(100).nullable().optional(),
  base_imp:     MontoNoNeg.nullable().optional(),
  importe:      Monto,
})
export type TributoDto = z.infer<typeof TributoSchema>
const IvaDetalleLista = z.array(IvaDetalleSchema).max(6).superRefine((xs, ctx) => {
  const vistas = new Set<number>()
  xs.forEach((x, i) => {
    if (vistas.has(x.alicuota_id)) ctx.addIssue({ code: 'custom', path: [i, 'alicuota_id'], message: 'ALICUOTA_REPETIDA' })
    vistas.add(x.alicuota_id)
  })
})
const TributosLista = z.array(TributoSchema).max(30)
const CamposArca = {
  no_gravado:     MontoNoNeg.nullable().optional(),
  exento:         MontoNoNeg.nullable().optional(),
  cae:            z.string().trim().regex(/^\d{14}$/, 'CAE_INVALIDO').nullable().optional(),
  cae_vto:        FechaISO.nullable().optional(),
  cbte_tipo_arca: z.number().int().refine((n) => (CBTE_TIPOS_ARCA as readonly number[]).includes(n), 'CBTE_TIPO_INVALIDO').nullable().optional(),
  iva_detalle:    IvaDetalleLista.nullable().optional(),
  tributos:       TributosLista.nullable().optional(),
}

/** A qué factura acredita una NC y cuánto (`pagos_nc_aplicaciones`). */
export const AplicacionNcSchema = z.object({
  factura_id: Id,
  monto:      Monto,
}).strict()
export type AplicacionNcDto = z.infer<typeof AplicacionNcSchema>
const AplicaALista = z.array(AplicacionNcSchema).max(50).superRefine((xs, ctx) => {
  const vistas = new Set<number>()
  xs.forEach((x, i) => {
    if (vistas.has(x.factura_id)) ctx.addIssue({ code: 'custom', path: [i, 'factura_id'], message: 'NC_APLICACION_INVALIDA' })
    vistas.add(x.factura_id)
  })
})
const centavos = (n: number) => Math.round(n * 100)
export const sumaAplicaA = (xs: readonly { monto: number }[] | null | undefined) =>
  (xs ?? []).reduce((s, x) => s + centavos(x.monto), 0) / 100

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
  /** Qué se compró, clasificado (combustible, materiales…). `descripcion` sigue siendo el detalle. */
  concepto_id:         ConceptoId,
  obs:                 z.string().trim().max(2000).optional().default(''),
  paga_cliente:        z.boolean().default(false),
  plan_cheques:        PlanChequesSchema.nullable().optional(),
  imputaciones:        z.array(ImputacionSchema).min(1).max(50),
  orden:               OrdenAlCargarSchema.nullable().optional(),
  ...CamposArca,
  /** La lectura del comprobante (POST /facturas/leer): el archivo se adjunta solo. */
  lectura_id:          Id.nullable().optional(),
  /** 'factura' o 'nota_credito' (20260925a). */
  clase:               z.enum(CLASES).default('factura'),
  /** Sólo NC: a qué facturas acredita. Sin esto (o vacío), queda como crédito a favor. */
  aplica_a:            AplicaALista.nullable().optional(),
  /** Mes en que se informa en el Libro IVA. Ausente o null: lo sugiere la base (mes de la fecha, o el primer abierto). */
  periodo_iva:         PeriodoIva.nullable().optional(),
}).superRefine((f, ctx) => {
  const err = (path: string, message = 'NC_TIPO_INVALIDO') => ctx.addIssue({ code: 'custom', path: [path], message })
  if (f.clase === 'nota_credito') {
    // Lo mismo que el CHECK `pagos_facturas_nc_chk`, adelantado al campo.
    if (!(TIPOS_COMPROBANTE_NC as readonly string[]).includes(f.tipo_comprobante)) err('tipo_comprobante')
    if (f.cbte_tipo_arca != null && !esCbteNotaCredito(f.cbte_tipo_arca)) err('cbte_tipo_arca')
    if (f.orden) err('orden', 'NC_NO_SE_PAGA')
    if (f.vence_el) err('vence_el')
    if (f.plan_cheques) err('plan_cheques')
    if (f.paga_cliente) err('paga_cliente')
    if (f.aplica_a?.length && centavos(sumaAplicaA(f.aplica_a)) > centavos(f.total)) err('aplica_a', 'NC_SUPERA_TOTAL')
  } else {
    if (f.cbte_tipo_arca != null && esCbteNotaCredito(f.cbte_tipo_arca)) err('cbte_tipo_arca')
    if (f.aplica_a?.length) err('aplica_a')
  }
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
  /**
   * Editable SIEMPRE, también en pagadas y aprobadas: es clasificación, no
   * plata (no está en CAMPOS_CONGELADOS ni en CAMPOS_QUE_DESAPRUEBAN). No
   * admite null: una factura con concepto no se puede dejar sin.
   */
  concepto_id:         ConceptoId.optional(),
  obs:                 z.string().trim().max(2000).optional(),
  paga_cliente:        z.boolean().optional(),
  plan_cheques:        PlanChequesSchema.nullable().optional(),
  imputaciones:        z.array(ImputacionSchema).min(1).max(50).optional(),
  motivo:              z.string().trim().min(3).max(300).optional(),
  ...CamposArca,
  /**
   * Sólo NC pendiente u observada: reemplaza a qué facturas acredita (vacío =
   * crédito a favor). Aprobada, se agrega con POST /facturas/:id/aplicar-nc.
   * `clase` no se edita (no está en el schema: .strict la rebota).
   */
  aplica_a:            AplicaALista.optional(),
  /**
   * Período IVA (20260927a). Editable siempre, también pagada o aprobada: es
   * clasificación fiscal (como `concepto_id`), no desaprueba. Sin null.
   */
  periodo_iva:         PeriodoIva.optional(),
}).strict()
export type UpdateFacturaDto = z.infer<typeof UpdateFacturaSchema>

/**
 * Completar el desglose de una factura ya cargada, aunque esté pagada
 * (20260924v). `iva_detalle` y `tributos` obligatorios (pueden ir vacíos):
 * es un reemplazo, no un parche. `neto` sólo vale sin alícuotas (B/C).
 * `forzar` (sólo admin) deja cargar percepciones cuando hoy son 0 y la
 * factura ya tiene reparto por obra: cambia lo imputado.
 */
export const CompletarDesgloseSchema = z.object({
  iva_detalle:    IvaDetalleLista,
  tributos:       TributosLista,
  no_gravado:     MontoNoNeg.nullable().optional(),
  exento:         MontoNoNeg.nullable().optional(),
  neto:           MontoNoNeg.nullable().optional(),
  cae:            z.string().trim().regex(/^\d{14}$/, 'CAE_INVALIDO').nullable().optional(),
  cae_vto:        FechaISO.nullable().optional(),
  cbte_tipo_arca: z.number().int().refine((n) => (CBTE_TIPOS_ARCA as readonly number[]).includes(n), 'CBTE_TIPO_INVALIDO').nullable().optional(),
  forzar:         z.boolean().optional(),
}).strict()
export type CompletarDesgloseDto = z.infer<typeof CompletarDesgloseSchema>

/** Leer el adjunto 'factura' ya guardado (el último, o el que se indique). */
export const LeerAdjuntoSchema = z.object({
  adjunto_id: z.number().int().positive().nullable().optional(),
  qr_texto:   z.string().max(4000).nullable().optional(),
}).strict()
export type LeerAdjuntoDto = z.infer<typeof LeerAdjuntoSchema>

export const MotivoSchema = z.object({
  motivo: z.string().trim().min(3).max(500),
})
export const CorregidaSchema = z.object({
  comentario: z.string().trim().max(500).optional().default(''),
})
export const AprobarLoteSchema = z.object({
  ids: z.array(Id).min(1).max(100),
})
/** Aplicar crédito de una NC aprobada a facturas del mismo proveedor (`pagos_aplicar_nc`: solo agrega). */
export const AplicarNcSchema = z.object({
  aplica_a: AplicaALista.min(1),
}).strict()
export type AplicarNcDto = z.infer<typeof AplicarNcSchema>

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
  /** Sin IVA discriminado (neto o IVA vacíos) o marcadas a revisar: lo que le falta al Libro IVA (20260924v). */
  sin_desglose:     BOOL_Q,
  paga_cliente:     BOOL_Q,
  pagada_al_cargar: BOOL_Q,
  cuenta_cambiada:  BOOL_Q,
  es_interna:       BOOL_Q,
  anuladas:         BOOL_Q,
  archivadas:       BOOL_Q,
  /** Factura o nota de crédito (20260925a). Sin filtro vienen las dos. */
  clase:            z.enum(CLASES).optional(),
  /** NC aprobadas con crédito sin aplicar (`nc_disponible > 0`). */
  con_credito:      BOOL_Q,
  /** Concepto de la factura (20260925i). */
  concepto_id:      z.coerce.number().int().positive().optional(),
  /** Período IVA 'YYYY-MM' (20260927a) y las informadas en otro mes que el de su fecha. */
  periodo_iva:      z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'PERIODO_IVA_INVALIDO').optional(),
  periodo_iva_distinto: BOOL_Q,
  /** Importadas de ARCA sin concepto ni reparto (20260927b). Filtra solo si viene. */
  sin_imputar:      BOOL_Q,
  /**
   * Importadas de meses ya pagados (20260928): el pago se reconstruye con los
   * extractos. No son deuda. Filtra solo si viene (la bandeja manda `0`).
   */
  pago_a_reconstruir: BOOL_Q,
  tributos_a_revisar: BOOL_Q,
  origen_carga:     z.enum(ORIGENES_CARGA).optional(),
  importacion_id:   z.coerce.number().int().positive().optional(),
  orden:            z.enum(FACTURAS_ORDEN).default('vencimiento'),
  limit:            z.coerce.number().int().min(1).max(500).default(50),
  offset:           z.coerce.number().int().min(0).default(0),
})
export type ListFacturasQuery = z.infer<typeof ListFacturasQuerySchema>

/** `concepto` (20260925m): grupo = concepto_id como texto; sin concepto → 'sin_concepto'. */
export const FACTURAS_RESUMEN_GRUPOS = ['proveedor', 'centro_costo', 'obra', 'mes_emision', 'estado', 'vencimiento', 'forma_pago', 'concepto'] as const
// Los filtros que `pagos_resumen` no respeta se sacan del schema para que
// nadie crea que el resumen los aplica (se ignorarían en silencio).
// `concepto_id` y `sin_imputar` sí los filtra desde 20260927k, y
// `pago_a_reconstruir` desde 20260928: los chips de la bandeja tienen que
// contar lo mismo que la lista.
export const FacturasResumenQuerySchema = ListFacturasQuerySchema.omit({
  orden: true, limit: true, offset: true,
  periodo_iva: true, periodo_iva_distinto: true, tributos_a_revisar: true, origen_carga: true, importacion_id: true,
}).extend({
  grupo: z.enum(FACTURAS_RESUMEN_GRUPOS).default('estado'),
})
export type FacturasResumenQuery = z.infer<typeof FacturasResumenQuerySchema>

/** GET /facturas/periodo-iva-sugerido?fecha=YYYY-MM-DD (20260927a). */
export const PeriodoIvaSugeridoQuerySchema = z.object({ fecha: FechaISO })

// ── Importador de «Mis Comprobantes Recibidos» de ARCA (20260927b/c) ────────

/**
 * Una fila ya normalizada (la arma `arca-recibidos.ts` o el navegador). Los
 * importes pueden venir con signo (algunas exportaciones traen las NC en
 * negativo): la base toma el valor absoluto y el signo lo da el tipo.
 * `alicuotas` = null en el formato clásico (sin columnas por alícuota).
 */
export const FilaRecibidaSchema = z.object({
  fecha:               FechaISO,
  cbte_tipo:           z.number().int().min(1).max(999),
  pto_vta:             z.number().int().min(0).max(99999),
  numero:              z.number().int().min(1).max(99999999),
  numero_hasta:        z.number().int().nullable().optional(),
  cod_autorizacion:    z.string().max(20).nullable().optional(),
  emisor_doc_tipo:     z.union([z.number().int(), z.string().max(20)]),
  emisor_doc_nro:      z.string().max(20),
  emisor_razon_social: z.string().max(200).default(''),
  moneda:              z.string().max(5).default('PES'),
  tipo_cambio:         z.number().positive().default(1),
  neto_gravado:        z.number().default(0),
  no_gravado:          z.number().default(0),
  exento:              z.number().default(0),
  otros_tributos:      z.number().default(0),
  iva:                 z.number().default(0),
  total:               z.number(),
  alicuotas:           z.array(z.object({
    alicuota_id: z.number().int().refine((n) => (ALICUOTA_IDS as readonly number[]).includes(n), 'ALICUOTA_INVALIDA'),
    base_imp:    z.number(),
    importe:     z.number(),
  })).max(6).nullable().optional(),
}).strict()
export type FilaRecibidaDto = z.infer<typeof FilaRecibidaSchema>

/**
 * `filas` es el contrato de la spec (filas ya normalizadas). Además, para no
 * duplicar el parser, el backend acepta el archivo crudo: `csv` (texto tal
 * cual lo baja ARCA, con `;` o `,`) o `matriz` (la hoja del Excel como
 * `sheet_to_json({ header: 1, raw: true })`). Exactamente uno de los tres.
 */
export const ImportarRecibidosSchema = z.object({
  filas:       z.array(FilaRecibidaSchema).min(1).max(2000).optional(),
  csv:         z.string().max(5_000_000).optional(),
  matriz:      z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(2100).optional(),
  archivo:     z.string().max(255).default(''),
  hash_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  confirmar:   z.boolean().default(false),
  /**
   * Compras de meses ya pagados (reconstrucción, 20260928): entran con
   * `pago_a_reconstruir` y no cuentan como deuda, ni se aprueban, ni avisan.
   */
  historica:   z.boolean().default(false),
}).strict().superRefine((b, ctx) => {
  const n = [b.filas !== undefined, b.csv !== undefined, b.matriz !== undefined].filter(Boolean).length
  if (n !== 1) ctx.addIssue({ code: 'custom', path: ['filas'], message: 'SIN_FILAS' })
})
export type ImportarRecibidosDto = z.infer<typeof ImportarRecibidosSchema>

/** Imputar una importada: concepto + reparto por obra (Σ = total − percepciones). */
export const ImputarFacturaSchema = z.object({
  concepto_id:  ConceptoId,
  imputaciones: z.array(ImputacionSchema).min(1).max(50),
  descripcion:  z.string().trim().min(3).max(300).optional(),
}).strict()
export type ImputarFacturaDto = z.infer<typeof ImputarFacturaSchema>

/** Imputar en lote: un concepto y UNA obra (100 % a esa obra). */
export const ImputarLoteSchema = z.object({
  ids:         z.array(Id).min(1).max(200),
  concepto_id: ConceptoId,
  obra_cod:    z.string().trim().min(1).max(40),
}).strict()
export type ImputarLoteDto = z.infer<typeof ImputarLoteSchema>

/**
 * Pagadas en lote con tarjeta de crédito o billetera (20260927h): compras de
 * vendedores distintos (Mercado Libre) ya pagadas en el momento. Una OP por
 * factura. `forma_pago` 'otro' = saldo de billetera. Sin `fecha`, cada una se
 * paga en la fecha de su factura.
 */
export const MarcarPagadasSchema = z.object({
  factura_ids:      z.array(Id).min(1).max(200),
  cuenta_origen_id: Id,
  forma_pago:       z.enum(['tarjeta', 'otro']),
  fecha:            FechaISO.optional(),
}).strict()
export type MarcarPagadasDto = z.infer<typeof MarcarPagadasSchema>

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

/** «Archivo primero»: la factura antes de existir va a `facturas/lecturas/` (20260924u). */
export const UploadUrlLecturaSchema = z.object({
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(MIME_PERMITIDOS),
  size_bytes:     z.number().int().positive().max(MAX_ADJUNTO_BYTES),
})
export const LeerFacturaSchema = z.object({
  storage_path:   z.string().min(1).max(500),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(MIME_PERMITIDOS),
  /** El texto del QR de ARCA, si el navegador lo encontró. */
  qr_texto:       z.string().max(4000).nullable().optional(),
})
export type LeerFacturaDto = z.infer<typeof LeerFacturaSchema>

/**
 * Leer la foto de un cheque (20260925p). El archivo se sube antes con
 * `POST /ordenes/upload-comprobante` (tipo `cheque`) a `ordenes/pendientes/`.
 */
export const LeerChequeSchema = z.object({
  storage_path:   z.string().min(1).max(500),
  nombre_archivo: z.string().trim().min(1).max(255).optional(),
  mime_type:      z.enum(MIME_PERMITIDOS),
})
export type LeerChequeDto = z.infer<typeof LeerChequeSchema>

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
 * Línea de OP: `factura` (paga una factura aprobada) o `a_cuenta` (anticipo,
 * sin factura). Desde el 2026-09-25 la nota de crédito NO es una línea: es un
 * comprobante propio que se aplica a la factura (`pagos_nc_aplicaciones`). La
 * RPC igual rechaza `nota_credito` con 400 NC_ES_COMPROBANTE.
 */
export const LineaOrdenSchema = z.object({
  tipo:       z.enum(TIPOS_LINEA_ENTRADA).default('factura'),
  factura_id: Id.nullable().optional(),
  monto:      Monto,
}).superRefine((l, ctx) => {
  if (l.tipo === 'a_cuenta' && l.factura_id != null) {
    ctx.addIssue({ code: 'custom', path: ['factura_id'], message: 'Una línea a cuenta no lleva factura' })
  }
  if (l.tipo !== 'a_cuenta' && l.factura_id == null) {
    ctx.addIssue({ code: 'custom', path: ['factura_id'], message: 'La línea necesita factura_id' })
  }
})
export type LineaOrdenDto = z.infer<typeof LineaOrdenSchema>

export const CreateOrdenSchema = z.object({
  proveedor_id: Id,
  fecha:        FechaISO,
  fecha_cobro:  FechaISO.nullable().optional(),
  // Obligatoria: una OP siempre mueve plata (la NC ya no es una línea). Se deja
  // nullable para que el error salga en el campo (FORMA_PAGO_REQUERIDA).
  forma_pago:   z.enum(FORMAS_PAGO_OP).nullable().optional(),
  referencia:   z.string().trim().max(120).optional().default(''),
  obs:          z.string().trim().max(1000).optional().default(''),
  lineas:       z.array(LineaOrdenSchema).min(1).max(100),
  // Comprobante de pago (u otro), ya subidos a `ordenes/pendientes/`.
  adjuntos:     z.array(AdjuntoPendienteSchema).max(10).optional().default([]),
  cheques:      z.array(ChequeSchema).max(50).optional().default([]),
  /** De qué cuenta propia (tesoreria_cuentas) salió la plata. Opcional (20260926g). */
  cuenta_origen_id: Id.nullable().optional(),
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
  /** Legacy (una sola dirección). Si viene `emails_proveedor`, se ignora. */
  email_proveedor: z.string().trim().email().max(254).optional(),
  /**
   * Las direcciones del proveedor para ESTE envío (20260925e: varios
   * contactos). Sin esto van los contactos con `recibe_avisos`. Cada una
   * recibe su propio mail y queda registrada aparte.
   */
  emails_proveedor: z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(10).optional(),
  /** Las direcciones nuevas quedan como contacto del proveedor («recibe avisos»). */
  guardar_email:   z.boolean().optional().default(true),
}).superRefine((o, ctx) => {
  if (!o.a_proveedor && !o.a_contador) {
    ctx.addIssue({ code: 'custom', path: ['a_contador'], message: 'SIN_DESTINATARIOS' })
  }
})
export type AvisarPagoDto = z.infer<typeof AvisarPagoSchema>

// ── Contactos del proveedor (20260925e/f) ───────────────────────────────────
// La lista entera: la RPC `pagos_guardar_contactos` actualiza los que traen
// id, agrega los nuevos y borra los que no vienen. Mismo formato que los
// contactos de clientes en Ventas (cada módulo con su copia: son independientes).
export const ROLES_CONTACTO = ['administracion', 'vendedor', 'compras', 'pagos', 'otro'] as const
const textoOpc = (max: number) => z.string().trim().max(max).optional().nullable()
export const ContactoProveedorSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  nombre: textoOpc(120),
  rol: z.enum(ROLES_CONTACTO).default('administracion'),
  email: z.string().trim().toLowerCase().max(200)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'email con forma inválida')
    .optional().nullable(),
  telefono: textoOpc(60),
  recibe_avisos: z.boolean().default(true),
  obs: textoOpc(500),
}).refine((c) => !!(c.nombre?.trim() || c.email?.trim() || c.telefono?.trim()), {
  message: 'el contacto necesita al menos nombre, email o teléfono', path: ['nombre'],
})
export const ContactosProveedorSchema = z.object({ contactos: z.array(ContactoProveedorSchema).max(30) })
  .superRefine((d, ctx) => {
    const vistos = new Set<string>()
    d.contactos.forEach((c, i) => {
      const e = c.email?.trim()
      if (!e) return
      if (vistos.has(e)) ctx.addIssue({ code: 'custom', path: ['contactos', i, 'email'], message: `el email ${e} está repetido` })
      vistos.add(e)
    })
  })
export type ContactoProveedorDto = z.infer<typeof ContactoProveedorSchema>

export const UpdateOrdenSchema = z.object({
  referencia: z.string().trim().max(120).optional(),
  obs:        z.string().trim().max(1000).optional(),
  /** Corregible aunque la OP esté emitida (no la congela `fn_pagos_orden_congelada`). */
  cuenta_origen_id: Id.nullable().optional(),
}).strict()
export type UpdateOrdenDto = z.infer<typeof UpdateOrdenSchema>

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
  /** Emitidas sin recibo del proveedor (`v_pagos_ordenes.tiene_recibo`, 20260925q). */
  sin_recibo:        BOOL_Q,
  en_cartera:        BOOL_Q,
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

/**
 * Datos fiscales cargables a mano (20260925o); los mismos que trae
 * «Buscar en ARCA». Nada obligatorio: hay proveedores sin CUIT o del
 * exterior. `condicion_iva_id` = ids de ARCA (los valida el service contra
 * `CONDICIONES_IVA`; la base, 1..16).
 */
const DatosFiscales = {
  domicilio:        Texto(300).nullable().optional(),
  provincia:        Texto(80).nullable().optional(),
  condicion_iva_id: z.number().int().min(1).max(16).nullable().optional(),
}

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
  ...DatosFiscales,
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
  ...DatosFiscales,
}).strict()
export type UpdateProveedorDto = z.infer<typeof UpdateProveedorSchema>

/** La puerta del contador: solo datos de pago, ni razón social ni CUIT. */
export const DatosPagoSchema = UpdateProveedorSchema.omit({
  razon_social: true, cuit: true, obs: true, domicilio: true, provincia: true, condicion_iva_id: true,
}).strict()
export type DatosPagoDto = z.infer<typeof DatosPagoSchema>

// ── Conceptos de compra (20260925i) ─────────────────────────────────────────

/** `nombre_norm` lo arma un trigger: no se manda. Sin DELETE: se da de baja con `activo=false`. */
export const CreateConceptoSchema = z.object({
  nombre: Texto(80).min(2),
  orden:  z.number().int().min(0).max(32767).nullable().optional(),
}).strict()
export type CreateConceptoDto = z.infer<typeof CreateConceptoSchema>

export const UpdateConceptoSchema = z.object({
  nombre: Texto(80).min(2).optional(),
  orden:  z.number().int().min(0).max(32767).nullable().optional(),
  activo: z.boolean().optional(),
}).strict().refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'SIN_CAMBIOS' })
export type UpdateConceptoDto = z.infer<typeof UpdateConceptoSchema>

export const ListConceptosQuerySchema = z.object({
  incluir_inactivos: BOOL_Q,
})
export type ListConceptosQuery = z.infer<typeof ListConceptosQuerySchema>

export const ListProveedoresQuerySchema = z.object({
  q:              z.string().max(200).optional(),
  inactivos:      BOOL_Q,
  sin_cuit:       BOOL_Q,
  sin_datos_pago: BOOL_Q,
  limit:          z.coerce.number().int().min(1).max(500).default(100),
  offset:         z.coerce.number().int().min(0).default(0),
})
export type ListProveedoresQuery = z.infer<typeof ListProveedoresQuerySchema>
