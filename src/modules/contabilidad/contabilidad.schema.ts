/**
 * Schemas zod del módulo Contabilidad (contrato de la API, fase 1).
 *
 * Forma y lo que se puede decidir sin la base: la partida doble de un asiento
 * confirmado se chequea acá (así el 422 sale con el detalle limpio antes de
 * tocar nada) y la RPC `cont_guardar_asiento` la vuelve a chequear, igual que
 * el trigger diferido. Las reglas que dependen del plan de cuentas (cuenta
 * imputable, auxiliar, período abierto) las valida la base.
 *
 * Los mensajes que son un CÓDIGO (`LINEA_IMPORTE_INVALIDO`,
 * `ASIENTO_DESBALANCEADO`…) salen como ese error, con su status; el resto
 * como 400 DATOS_INVALIDOS { campo, mensaje }.
 */
import { z } from 'zod'

export const esBoolQ = (v?: string) => v === '1' || v === 'true'

export const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'fecha inexistente')
export const Id = z.number().int().positive()
const IdQ = z.coerce.number().int().positive()
const BoolQ = z.enum(['0', '1', 'true', 'false']).optional()
/** numeric(14,2): hasta 999.999.999.999,99. */
const Importe = z.number().min(0).max(999_999_999_999.99)

/**
 * `resultado` (pieza 5, plan de Finnegans): SOLO títulos. Es la 4000000
 * «RESULTADO DEL PERIODO», madre de ingresos (4100000) y de gastos (4200000);
 * sus hijas pueden ser resultado, ingreso o egreso. Imputable → 400
 * RESULTADO_SOLO_TITULO (acá y en la base).
 */
export const RUBROS = ['activo', 'pasivo', 'pn', 'ingreso', 'egreso', 'resultado'] as const
export const AUXILIARES = ['none', 'cliente', 'proveedor', 'tesoreria'] as const
export const CODIGO_RE = /^[1-9](\.[0-9]{1,3}){0,5}$/

const Motivo = z.string().trim().min(3, 'MOTIVO_REQUERIDO').max(500)
export const MotivoSchema = z.object({ motivo: Motivo })

// ── Períodos ────────────────────────────────────────────────────────────────

export const PeriodosQuerySchema = z.object({ ejercicio_id: IdQ.optional() })

// ── Plan de cuentas ─────────────────────────────────────────────────────────

export const CuentaSchema = z.object({
  codigo:    z.string().trim().regex(CODIGO_RE, 'CODIGO_INVALIDO'),
  nombre:    z.string().trim().min(2, 'NOMBRE_INVALIDO').max(120),
  rubro:     z.enum(RUBROS).optional(),
  imputable: z.boolean(),
  auxiliar:  z.enum(AUXILIARES).default('none'),
  obs:       z.string().max(500).optional().default(''),
}).superRefine((c, ctx) => {
  if (c.rubro === 'resultado' && c.imputable) ctx.addIssue({ code: 'custom', path: ['rubro'], message: 'RESULTADO_SOLO_TITULO' })
})
export type CuentaDto = z.infer<typeof CuentaSchema>

/** PATCH: sin defaults, para que lo que no viene no pise lo guardado. */
export const UpdateCuentaSchema = z.object({
  codigo:    z.string().trim().regex(CODIGO_RE, 'CODIGO_INVALIDO').optional(),
  nombre:    z.string().trim().min(2, 'NOMBRE_INVALIDO').max(120).optional(),
  rubro:     z.enum(RUBROS).optional(),
  imputable: z.boolean().optional(),
  auxiliar:  z.enum(AUXILIARES).optional(),
  obs:       z.string().max(500).optional(),
}).superRefine((c, ctx) => {
  // Solo si vienen los dos; si no, lo decide la base contra lo guardado.
  if (c.rubro === 'resultado' && c.imputable === true) ctx.addIssue({ code: 'custom', path: ['rubro'], message: 'RESULTADO_SOLO_TITULO' })
})
export type UpdateCuentaDto = z.infer<typeof UpdateCuentaSchema>

export const ListCuentasQuerySchema = z.object({
  incluir_inactivas: BoolQ,
  solo_imputables:   BoolQ,
  q:                 z.string().max(200).optional(),
})

type Celda = string | number | boolean | null
export const ImportarPlanSchema = z.object({
  filas:     z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(2000, 'DEMASIADAS_FILAS').optional(),
  csv:       z.string().max(2_000_000).optional(),
  confirmar: z.boolean().optional().default(false),
}).refine((b) => (b.filas && b.filas.length > 0) || (b.csv != null && b.csv.trim() !== ''), { message: 'SIN_FILAS', path: ['filas'] })
export type ImportarPlanDto = z.infer<typeof ImportarPlanSchema> & { filas?: Record<string, Celda>[] }

// ── Asientos ────────────────────────────────────────────────────────────────

/** De pesos a centavos enteros: la comparación de la partida doble es exacta. */
const cent = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100)

export const LineaAsientoSchema = z.object({
  cuenta_id: Id,
  debe:      Importe.default(0),
  haber:     Importe.default(0),
  aux_id:    Id.nullable().optional(),
  obra_cod:  z.string().trim().max(40).nullable().optional(),
  glosa:     z.string().max(300).optional().default(''),
}).superRefine((l, ctx) => {
  // Exactamente uno de los dos > 0 (después de redondear a centavos).
  const d = cent(l.debe), h = cent(l.haber)
  if ((d > 0) === (h > 0)) ctx.addIssue({ code: 'custom', path: [d > 0 ? 'haber' : 'debe'], message: 'LINEA_IMPORTE_INVALIDO' })
})
export type LineaAsientoDto = z.infer<typeof LineaAsientoSchema>

export interface ChequeoPartidaDoble {
  code: 'MENOS_DE_DOS_LINEAS' | 'ASIENTO_DESBALANCEADO' | 'ASIENTO_TOTAL_CERO'
  detail: Record<string, unknown>
}

/**
 * La partida doble de un asiento CONFIRMADO (espejo de `_cont_chequear_asiento`):
 * al menos dos líneas, Σdebe = Σhaber al centavo y total > 0. Un borrador no
 * tiene que cuadrar. `null` = está bien.
 */
export function chequearPartidaDoble(lineas: Array<{ debe?: number; haber?: number }>): ChequeoPartidaDoble | null {
  if (lineas.length < 2) return { code: 'MENOS_DE_DOS_LINEAS', detail: { lineas: lineas.length } }
  const d = lineas.reduce((s, l) => s + cent(l.debe ?? 0), 0)
  const h = lineas.reduce((s, l) => s + cent(l.haber ?? 0), 0)
  if (d !== h) return { code: 'ASIENTO_DESBALANCEADO', detail: { debe: d / 100, haber: h / 100, diferencia: (d - h) / 100 } }
  if (d === 0) return { code: 'ASIENTO_TOTAL_CERO', detail: {} }
  return null
}

export const GuardarAsientoSchema = z.object({
  fecha:  FechaISO,
  tipo:   z.enum(['manual', 'ajuste', 'apertura']).default('manual'),
  glosa:  z.string().trim().min(3, 'GLOSA_REQUERIDA').max(500),
  estado: z.enum(['borrador', 'confirmado']),
  lineas: z.array(LineaAsientoSchema).min(1, 'SIN_LINEAS').max(500, 'DEMASIADAS_LINEAS'),
}).superRefine((a, ctx) => {
  if (a.estado !== 'confirmado') return
  // Si alguna línea ya está mal, ese error es el que sirve (y no se suma nada raro).
  if (a.lineas.some((l) => (cent(l.debe) > 0) === (cent(l.haber) > 0))) return
  const r = chequearPartidaDoble(a.lineas)
  if (r) ctx.addIssue({ code: 'custom', path: ['lineas'], message: r.code, params: r.detail })
})
export type GuardarAsientoDto = z.infer<typeof GuardarAsientoSchema>

export const AnularAsientoSchema = z.object({
  motivo: Motivo,
  fecha:  FechaISO.optional(),
})

export const ListAsientosQuerySchema = z.object({
  desde:     FechaISO.optional(),
  hasta:     FechaISO.optional(),
  estado:    z.enum(['todos', 'borrador', 'confirmado', 'anulado']).optional().default('todos'),
  tipo:      z.enum(['apertura', 'manual', 'automatico', 'ajuste', 'cierre']).optional(),
  q:         z.string().max(200).optional(),
  cuenta_id: IdQ.optional(),
  limit:     z.coerce.number().int().min(1).max(200).optional().default(50),
  offset:    z.coerce.number().int().min(0).optional().default(0),
})
export type ListAsientosQuery = z.infer<typeof ListAsientosQuerySchema>

// ── Reportes ────────────────────────────────────────────────────────────────

/** `detallado` = un asiento por comprobante; `dia`/`mes` = automáticos resumidos por circuito (20260928i). */
export const DIARIO_MODOS = ['detallado', 'dia', 'mes'] as const
export type DiarioModo = (typeof DIARIO_MODOS)[number]

export const DiarioQuerySchema = z.object({
  desde:  FechaISO,
  hasta:  FechaISO,
  modo:   z.enum(DIARIO_MODOS).optional().default('detallado'),
  limit:  z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})
export type DiarioQuery = z.infer<typeof DiarioQuerySchema>

export const MayorQuerySchema = z.object({
  cuenta_id: IdQ,
  desde:     FechaISO,
  hasta:     FechaISO,
  obra_cod:  z.string().trim().min(1).max(40).optional(),
  aux_id:    IdQ.optional(),
  limit:     z.coerce.number().int().min(1).max(1000).optional().default(500),
  offset:    z.coerce.number().int().min(0).optional().default(0),
})
export type MayorQuery = z.infer<typeof MayorQuerySchema>

export const SumasSaldosQuerySchema = z.object({
  desde: FechaISO,
  hasta: FechaISO,
  nivel: z.coerce.number().int().min(1).max(6).optional(),
  incluir_sin_movimiento: BoolQ,
})
export type SumasSaldosQuery = z.infer<typeof SumasSaldosQuerySchema>

// Estados contables (20260928j): balance a una fecha y resultados de un rango.
export const BalanceQuerySchema = z.object({
  fecha:        FechaISO,
  nivel:        z.coerce.number().int().min(1).max(5).optional().default(3),
  incluir_cero: BoolQ,
})
export type BalanceQuery = z.infer<typeof BalanceQuerySchema>

export const ResultadosQuerySchema = z.object({
  desde:        FechaISO,
  hasta:        FechaISO,
  nivel:        z.coerce.number().int().min(1).max(5).optional().default(4),
  comparativo:  BoolQ,
  incluir_cero: BoolQ,
})
export type ResultadosQuery = z.infer<typeof ResultadosQuerySchema>

// ── Tesorería ───────────────────────────────────────────────────────────────

/**
 * `tarjeta` = tarjeta de crédito de la empresa (pasivo; sin CBU ni alias,
 * `banco` = emisor) y `billetera` = Mercado Pago u otra (CVU en `cbu` y alias).
 * 20260927h. CBU/alias solo en banco y billetera (`validarDatosBanco`).
 */
export const TIPOS_TESORERIA = ['banco', 'caja', 'valores', 'tarjeta', 'billetera'] as const
const Cbu = z.string().trim().regex(/^\d{22}$/, 'CBU_INVALIDO')

export const TesoreriaSchema = z.object({
  tipo:             z.enum(TIPOS_TESORERIA),
  nombre:           z.string().trim().min(2).max(80),
  banco:            z.string().trim().max(80).optional(),
  cbu:              Cbu.nullable().optional(),
  alias:            z.string().trim().max(20).nullable().optional(),
  moneda:           z.enum(['ARS', 'USD']).default('ARS'),
  cuenta_id:        Id.nullable().optional(),
  ventas_cuenta_id: Id.nullable().optional(),
  obs:              z.string().max(1000).optional(),
})
export type TesoreriaDto = z.infer<typeof TesoreriaSchema>

/** PATCH: sin defaults. */
export const UpdateTesoreriaSchema = z.object({
  tipo:             z.enum(TIPOS_TESORERIA).optional(),
  nombre:           z.string().trim().min(2).max(80).optional(),
  banco:            z.string().trim().max(80).optional(),
  cbu:              Cbu.nullable().optional(),
  alias:            z.string().trim().max(20).nullable().optional(),
  moneda:           z.enum(['ARS', 'USD']).optional(),
  cuenta_id:        Id.nullable().optional(),
  ventas_cuenta_id: Id.nullable().optional(),
  obs:              z.string().max(1000).optional(),
})
export type UpdateTesoreriaDto = z.infer<typeof UpdateTesoreriaSchema>

export const ListTesoreriaQuerySchema = z.object({ incluir_inactivas: BoolQ })

// ── Asientos automáticos y mapeos (fase 3, 20260927d–f) ─────────────────────

/** Orígenes que contabiliza el motor (`cont_contabilizar`). */
/** Tanda 5 (20260928m): `tesoreria_movimientos` = movimientos de fondos sin factura (circuito «fondos»). */
export const FUENTES = ['ventas_facturas', 'ventas_comprobantes_externos', 'ventas_cobros', 'pagos_facturas', 'pagos_ordenes', 'tesoreria_movimientos'] as const
export type CtbFuente = (typeof FUENTES)[number]
export const PENDIENTE_ESTADOS = ['sin_contabilizar', 'pendiente', 'desactualizado', 'a_revertir'] as const

export const PendientesQuerySchema = z.object({
  /** Default: `cont_config.automaticos_desde`. */
  desde:  FechaISO.optional(),
  /** Default: hoy (AR). */
  hasta:  FechaISO.optional(),
  fuente: z.enum(FUENTES).optional(),
  /** Circuitos tildados, como lista de fuentes separada por comas (20260928h). */
  fuentes: z.string().trim().optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(FUENTES)).min(1).max(FUENTES.length).optional()),
  estado: z.enum(PENDIENTE_ESTADOS).optional(),
  motivo: z.string().trim().max(60).optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PendientesQuery = z.infer<typeof PendientesQuerySchema>

export const PropuestaQuerySchema = z.object({
  origen_tabla: z.enum(FUENTES),
  origen_id:    IdQ,
})

/** Dónde siguió el contabilizador (lo devuelve la RPC y se reenvía tal cual). */
export const CursorSchema = z.object({
  fecha: FechaISO,
  tabla: z.enum(FUENTES),
  id:    Id,
}).strict()

export const ContabilizarSchema = z.object({
  hasta:             FechaISO,
  fuentes:           z.array(z.enum(FUENTES)).min(1).max(FUENTES.length).optional(),
  /** Corregir también en períodos cerrados con contraasientos: exige `cerrar_periodos`. */
  revertir_cerrados: z.boolean().optional().default(false),
  /** Opcional: seguir desde donde quedó la llamada anterior (`hay_mas`). */
  cursor:            CursorSchema.nullable().optional(),
}).strict()
export type ContabilizarDto = z.infer<typeof ContabilizarSchema>

export const MapeoInputSchema = z.object({
  clave:     z.string().trim().min(1).max(60),
  subclave:  z.string().max(120),
  cuenta_id: Id.nullable(),
}).strict()
export const GuardarMapeosSchema = z.object({
  mapeos: z.array(MapeoInputSchema).min(1, 'SIN_FILAS').max(500, 'DEMASIADAS_FILAS'),
}).strict()
export type GuardarMapeosDto = z.infer<typeof GuardarMapeosSchema>

export const CVLP_MODOS = ['neto_liquidado', 'bruto'] as const
export const BU_FRECUENCIAS = ['mensual', 'anual'] as const
export const BU_CRITERIOS = ['completo', 'proporcional'] as const
export const COMPRAS_FECHA_CONTABLE = ['fecha', 'mes_iva'] as const
export const ConfigSchema = z.object({
  automaticos_desde:      FechaISO.refine((s) => s >= '2026-07-01', 'CONFIG_INVALIDA').optional(),
  cvlp_modo:              z.enum(CVLP_MODOS).optional(),
  compras_fecha_contable: z.enum(COMPRAS_FECHA_CONTABLE).optional(),
  /** Pendiente de definir con el contador (P3.4): hoy solo null. */
  paga_cliente_modo:      z.null().optional(),
  // Tanda 5 (20260928n): asiento de IVA y bienes de uso. La base valida
  // además que frecuencia y corte no cambien con amortizaciones hechas.
  iva_ddjj_arrastre:      z.boolean().optional(),
  bu_frecuencia:          z.enum(BU_FRECUENCIAS).optional(),
  bu_criterio_alta:       z.enum(BU_CRITERIOS).optional(),
  bu_corte_inicial:       FechaISO.optional(),
  // 20260929h: cuenta título de los rubros de bienes de uso. La base valida
  // que sea un título del activo y que no deje bienes afuera.
  bu_titulo_rubros:       z.coerce.number().int().positive().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'CONFIG_INVALIDA', path: [] })
export type ConfigDto = z.infer<typeof ConfigSchema>

/** POST /periodos/:id/cerrar: body opcional. */
export const CerrarPeriodoSchema = z.object({
  /** Cerrar aunque haya orígenes sin contabilizar o desactualizados. */
  forzar: z.boolean().optional().default(false),
}).strict()

// ── Catálogos ───────────────────────────────────────────────────────────────

export const AuxiliaresQuerySchema = z.object({
  tipo: z.enum(['cliente', 'proveedor', 'tesoreria']),
  q:    z.string().max(200).optional(),
  ids:  z.string().max(4000).regex(/^\d+(,\d+)*$/, 'ids: números separados por coma').optional(),
})
export type AuxiliaresQuery = z.infer<typeof AuxiliaresQuerySchema>

// ═══════════════════════════════════ Tanda 5 (20260928l–r) ══════════════════

const ImportePositivo = z.number().positive('IMPORTE_INVALIDO').max(999_999_999_999.99, 'IMPORTE_INVALIDO')
const TextoOpc = (max: number) => z.string().trim().max(max).optional()
const ObraCod = z.string().trim().max(40).nullable().optional()

// ── Movimientos de fondos (tab `tesoreria`) ────────────────────────────────

export const TES_MOV_TIPOS = ['ingreso', 'egreso', 'transferencia'] as const
export const TES_CONCEPTO_SENTIDOS = ['ingreso', 'egreso', 'ambos'] as const
export const TES_ADJ_TIPOS = ['comprobante', 'vep', 'extracto', 'otro'] as const

/**
 * Alta y edición (el PATCH manda el movimiento COMPLETO). La forma se chequea
 * acá; monedas, cotización, cuentas activas, concepto compatible y período
 * abierto los decide la RPC `tesoreria_guardar_movimiento` (y el trigger).
 */
export const TesMovimientoSchema = z.object({
  fecha:                FechaISO,
  tipo:                 z.enum(TES_MOV_TIPOS, 'TIPO_INVALIDO'),
  tesoreria_id:         Id,
  tesoreria_destino_id: Id.nullable().optional(),
  concepto_id:          Id.nullable().optional(),
  importe:              ImportePositivo,
  importe_destino:      ImportePositivo.nullable().optional(),
  cotizacion:           z.number().positive('COTIZACION_REQUERIDA').max(99_999_999).nullable().optional(),
  obra_cod:             ObraCod,
  referencia:           TextoOpc(120),
  obs:                  TextoOpc(1000),
}).strict().superRefine((m, ctx) => {
  const destino = m.tesoreria_destino_id ?? null
  if (m.tipo === 'transferencia') {
    if (destino == null) ctx.addIssue({ code: 'custom', path: ['tesoreria_destino_id'], message: 'TESORERIA_DESTINO_REQUERIDA' })
    else if (destino === m.tesoreria_id) ctx.addIssue({ code: 'custom', path: ['tesoreria_destino_id'], message: 'TESORERIA_IGUALES' })
    if (m.concepto_id != null) ctx.addIssue({ code: 'custom', path: ['concepto_id'], message: 'CONCEPTO_NO_CORRESPONDE' })
    if (m.obra_cod) ctx.addIssue({ code: 'custom', path: ['obra_cod'], message: 'OBRA_NO_CORRESPONDE' })
  } else {
    if (m.concepto_id == null) ctx.addIssue({ code: 'custom', path: ['concepto_id'], message: 'CONCEPTO_REQUERIDO' })
    if (destino != null) ctx.addIssue({ code: 'custom', path: ['tesoreria_destino_id'], message: 'DESTINO_NO_CORRESPONDE' })
  }
})
export type TesMovimientoDto = z.infer<typeof TesMovimientoSchema>

export const TesMovimientosQuerySchema = z.object({
  desde:        FechaISO.optional(),
  hasta:        FechaISO.optional(),
  tipo:         z.enum(TES_MOV_TIPOS).optional(),
  tesoreria_id: IdQ.optional(),
  concepto_id:  IdQ.optional(),
  obra_cod:     z.string().trim().min(1).max(40).optional(),
  /** Sin estado = todos (vigentes y anulados). */
  estado:       z.enum(['vigente', 'anulado', 'todos']).optional(),
  origen:       z.enum(['manual', 'conciliacion']).optional(),
  q:            z.string().trim().max(200).optional(),
  limit:        z.coerce.number().int().min(1).max(200).optional().default(50),
  offset:       z.coerce.number().int().min(0).optional().default(0),
})
export type TesMovimientosQuery = z.infer<typeof TesMovimientosQuerySchema>

export const TesConceptoSchema = z.object({
  nombre:  z.string().trim().min(2, 'NOMBRE_INVALIDO').max(120),
  sentido: z.enum(TES_CONCEPTO_SENTIDOS),
  orden:   z.number().int().min(0).max(32767).optional(),
  activo:  z.boolean().optional(),
  obs:     TextoOpc(500),
}).strict()
export type TesConceptoDto = z.infer<typeof TesConceptoSchema>
/** PATCH: parcial; el service completa con lo guardado. */
export const UpdateTesConceptoSchema = TesConceptoSchema.partial().strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'SIN_CAMBIOS', path: [] })
export type UpdateTesConceptoDto = z.infer<typeof UpdateTesConceptoSchema>

export const TesConceptosQuerySchema = z.object({ incluir_inactivos: BoolQ })

/** Adjuntos de un movimiento (bucket privado `tesoreria-docs`, 10 MB). */
export const TES_ADJ_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const
export const TES_ADJ_MAX_BYTES = 10 * 1024 * 1024
export const TesAdjUploadUrlSchema = z.object({
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(TES_ADJ_MIMES, 'MIME_NO_PERMITIDO'),
  size_bytes:     z.number().int().positive('TAMANO_INVALIDO').max(TES_ADJ_MAX_BYTES, 'TAMANO_INVALIDO'),
  /** Opcional: el tipo se decide al registrar. */
  tipo:           z.enum(TES_ADJ_TIPOS).optional(),
}).strict()
export type TesAdjUploadUrlDto = z.infer<typeof TesAdjUploadUrlSchema>
export const TesAdjRegistrarSchema = z.object({
  tipo:           z.enum(TES_ADJ_TIPOS),
  storage_path:   z.string().min(1).max(500),
  nombre_archivo: z.string().trim().min(1).max(255),
  mime_type:      z.enum(TES_ADJ_MIMES, 'MIME_NO_PERMITIDO'),
  obs:            TextoOpc(500),
}).strict()
export type TesAdjRegistrarDto = z.infer<typeof TesAdjRegistrarSchema>

// ── Asiento mensual de IVA (tab `periodos`) ────────────────────────────────

export const IvaEstadosQuerySchema = z.object({ ejercicio_id: IdQ.optional() })
export const IvaGenerarSchema = z.object({ forzar: z.boolean().optional().default(false) }).strict()

// ── Bienes de uso (tab `bienes`) ────────────────────────────────────────────

/** Alta y edición (el PATCH manda el bien completo, como el alta). */
export const BienSchema = z.object({
  descripcion:        z.string().trim().min(3, 'DESCRIPCION_REQUERIDA').max(300),
  identificador:      TextoOpc(120),
  cuenta_origen_id:   Id,
  cuenta_amort_id:    Id.nullable().optional(),
  cuenta_gasto_id:    Id.nullable().optional(),
  fecha_alta:         FechaISO,
  valor_origen:       ImportePositivo,
  vida_util_anios:    z.number().positive('VIDA_UTIL_INVALIDA').max(999.99, 'VIDA_UTIL_INVALIDA').nullable().optional(),
  valor_residual:     Importe.optional(),
  amort_acum_inicial: Importe.optional(),
  criterio_alta:      z.enum(BU_CRITERIOS).nullable().optional(),
  obra_cod:           ObraCod,
  pagos_factura_id:   Id.nullable().optional(),
  obs:                TextoOpc(1000),
}).strict().superRefine((b, ctx) => {
  const residual = b.valor_residual ?? 0
  const inicial = b.amort_acum_inicial ?? 0
  if (residual >= b.valor_origen) ctx.addIssue({ code: 'custom', path: ['valor_residual'], message: 'BU_RESIDUAL_INVALIDO' })
  else if (inicial > b.valor_origen - residual + 0.001) ctx.addIssue({ code: 'custom', path: ['amort_acum_inicial'], message: 'BU_INICIAL_INVALIDA' })
  if (b.vida_util_anios != null) {
    if (b.cuenta_amort_id == null) ctx.addIssue({ code: 'custom', path: ['cuenta_amort_id'], message: 'BU_SIN_CUENTA_AMORT' })
    if (b.cuenta_gasto_id == null) ctx.addIssue({ code: 'custom', path: ['cuenta_gasto_id'], message: 'BU_SIN_CUENTA_GASTO' })
  }
})
export type BienDto = z.infer<typeof BienSchema>

export const BajaBienSchema = z.object({ fecha: FechaISO, motivo: Motivo }).strict()

export const BienesQuerySchema = z.object({
  incluir_bajas:    BoolQ,
  q:                z.string().trim().max(200).optional(),
  cuenta_origen_id: IdQ.optional(),
  obra_cod:         z.string().trim().min(1).max(40).optional(),
})
export type BienesQuery = z.infer<typeof BienesQuerySchema>

export const ImportarBienesSchema = z.object({
  filas:     z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(2000, 'DEMASIADAS_FILAS').optional(),
  csv:       z.string().max(4_000_000).optional(),
  confirmar: z.boolean().optional().default(false),
}).refine((b) => (b.filas && b.filas.length > 0) || (b.csv != null && b.csv.trim() !== ''), { message: 'SIN_FILAS', path: ['filas'] })
export type ImportarBienesDto = z.infer<typeof ImportarBienesSchema>

export const CuadroBienesQuerySchema = z.object({ hasta: FechaISO })
export const CorridasQuerySchema = z.object({ ejercicio_id: IdQ.optional() })
export const AmortizarSchema = z.object({ hasta: FechaISO }).strict()

// ── Cartera de cheques recibidos (20260930n) ────────────────────────────────

export const ChequesRecibidosQuerySchema = z.object({
  /** `vencidos` / `por_vencer` = en cartera con la fecha de cobro pasada / por venir. Sin estado = todos. */
  estado: z.enum(['en_cartera', 'endosado', 'depositado', 'rechazado', 'recuperado', 'vencidos', 'por_vencer', 'todos']).optional(),
  origen: z.enum(['logistica_cobro', 'ventas_cobro', 'manual']).optional(),
  desde:  FechaISO.optional(),
  hasta:  FechaISO.optional(),
  q:      z.string().trim().max(200).optional(),
  limit:  z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})
export type ChequesRecibidosQuery = z.infer<typeof ChequesRecibidosQuerySchema>

export const ChequeRecibidoAManoSchema = z.object({
  numero:        z.string().trim().min(1).max(40),
  banco:         z.string().trim().max(80).nullable().optional(),
  librador:      z.string().trim().min(1).max(160),
  librador_cuit: z.string().trim().max(20).nullable().optional(),
  fecha_cobro:   FechaISO.nullable().optional(),
  importe:       z.number().positive(),
  es_echeq:      z.boolean().nullable().optional(),
  obs:           z.string().trim().max(300).nullable().optional(),
})
export type ChequeRecibidoAManoDto = z.infer<typeof ChequeRecibidoAManoSchema>
export const ChequesRecibidosAManoSchema = z.object({ cheques: z.array(ChequeRecibidoAManoSchema).min(1).max(60) })

export const ChequesCambiarEstadoSchema = z.object({
  ids:          z.array(z.number().int().positive()).min(1).max(500),
  accion:       z.enum(['depositar', 'rechazar', 'recuperar', 'volver_a_cartera']),
  /** Sin fecha al depositar = la fecha de cobro de cada cheque (para los vencidos en lote). */
  fecha:        FechaISO.nullable().optional(),
  tesoreria_id: z.number().int().positive().nullable().optional(),
  motivo:       z.string().trim().max(300).nullable().optional(),
})
export type ChequesCambiarEstadoDto = z.infer<typeof ChequesCambiarEstadoSchema>
