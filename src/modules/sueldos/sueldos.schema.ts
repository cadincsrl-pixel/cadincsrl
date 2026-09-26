/**
 * Validación zod de Sueldos. Lo que la base vuelve a validar (CUIL con su
 * dígito, CBU, unicidades, estados) igual se chequea acá lo que se puede,
 * para devolver el `campo` y no gastar un viaje a la base.
 *
 * En los PATCH los `.optional()` van afuera de los transforms: un campo
 * ausente sigue ausente y la RPC no lo pisa (edición parcial).
 */
import { z } from 'zod'
import {
  TIPOS_CONCEPTO, CALCULOS, BASES, CONDICIONES, DESTINOS, GRUPOS, UNIDADES, TIPOS_LIQUIDACION,
  cuilValido, cbuValido,
} from './calculo.js'

const Fecha = z.iso.date('Fecha inválida (YYYY-MM-DD)')
const Id = z.number().int().positive()
const Texto = (max: number) => z.string().trim().max(max)
const Importe = z.number().finite().gt(-1e12).lt(1e12)
const Codigo = z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'CODIGO_INVALIDO')
const CodigoArca = z.string().trim().regex(/^\d{6}$/, 'CODIGO_ARCA_INVALIDO').nullable()
const Zona = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,5}$/, 'ZONA_INVALIDA')

/** 'true'/'1'/'si' en query string. */
export const esBoolQ = (v: string | undefined | null) => !!v && ['1', 'true', 'si', 'sí'].includes(v.trim().toLowerCase())

// ── Convenios, categorías, escalas ──────────────────────────────────────────

export const ConvenioCreateSchema = z.object({
  codigo: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,30}$/, 'CODIGO_INVALIDO'),
  nombre: Texto(120).min(2, 'NOMBRE_REQUERIDO'),
  cct: Texto(40).optional(),
  periodicidad: z.enum(['quincenal', 'mensual'], 'PERIODICIDAD_INVALIDA'),
  unidad_basico: z.enum(['hora', 'mes'], 'UNIDAD_INVALIDA'),
  obs: Texto(1000).optional(),
  activo: z.boolean().optional(),
})
export const ConvenioUpdateSchema = z.object({
  nombre: Texto(120).min(2, 'NOMBRE_REQUERIDO').optional(),
  cct: Texto(40).optional(),
  periodicidad: z.enum(['quincenal', 'mensual'], 'PERIODICIDAD_INVALIDA').optional(),
  unidad_basico: z.enum(['hora', 'mes'], 'UNIDAD_INVALIDA').optional(),
  obs: Texto(1000).optional(),
  activo: z.boolean().optional(),
})

export const CategoriaCreateSchema = z.object({
  convenio_id: Id,
  codigo: Codigo,
  nombre: Texto(120).min(2, 'NOMBRE_REQUERIDO'),
  orden: z.number().int().min(0).max(999).optional(),
  unidad_basico: z.enum(['hora', 'mes'], 'UNIDAD_INVALIDA').nullable().optional(),
  por_defecto: z.boolean().optional(),
  activo: z.boolean().optional(),
})
export const CategoriaUpdateSchema = CategoriaCreateSchema.omit({ convenio_id: true, codigo: true }).partial()

export const EscalaCreateSchema = z.object({
  categoria_id: Id,
  zona: Zona.optional(),
  vigente_desde: Fecha,
  valor: z.number().positive('VALOR_INVALIDO').lt(1e12),
  fuente: Texto(300).optional(),
  a_confirmar: z.boolean().optional(),
})
export const EscalaUpdateSchema = z.object({
  valor: z.number().positive('VALOR_INVALIDO').lt(1e12).optional(),
  fuente: Texto(300).optional(),
  a_confirmar: z.boolean().optional(),
})
export const EscalasQuerySchema = z.object({
  convenio_id: z.coerce.number().int().positive().optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  zona: z.string().optional(),
})

export const ParitariaSchema = z.object({
  convenio_id: Id,
  desde: Fecha,
  porcentaje: z.number().gt(-50, 'PORCENTAJE_INVALIDO').max(200, 'PORCENTAJE_INVALIDO'),
  fuente: Texto(300).optional(),
  a_confirmar: z.boolean().optional(),
  zona: Zona.nullable().optional(),
})

// ── Conceptos, valores, parámetros ──────────────────────────────────────────

const ConceptoBase = z.object({
  nombre: Texto(120).min(2, 'NOMBRE_REQUERIDO'),
  tipo: z.enum(TIPOS_CONCEPTO, 'TIPO_INVALIDO'),
  calculo: z.enum(CALCULOS, 'CALCULO_INVALIDO'),
  base: z.enum(BASES, 'BASE_INVALIDA').nullable(),
  condicion: z.enum(CONDICIONES, 'CONDICION_INVALIDA'),
  codigo_arca: CodigoArca,
  grupo_contribucion: z.enum(GRUPOS, 'GRUPO_INVALIDO').nullable(),
  destino: z.enum(DESTINOS, 'DESTINO_INVALIDO').nullable(),
  parametro_clave: z.string().trim().regex(/^[a-z0-9_]{2,60}$/, 'CLAVE_INVALIDA').nullable(),
  unidad: z.enum(UNIDADES, 'UNIDAD_INVALIDA').nullable(),
  en_recibo: z.boolean(),
  orden: z.number().int().min(0).max(999),
  automatico: z.boolean(),
  activo: z.boolean(),
  obs: Texto(1000),
})
export const ConceptoCreateSchema = ConceptoBase.partial().extend({
  convenio_id: Id.nullable(),
  codigo: Codigo,
  nombre: ConceptoBase.shape.nombre,
  tipo: ConceptoBase.shape.tipo,
  calculo: ConceptoBase.shape.calculo,
})
export const ConceptoUpdateSchema = ConceptoBase.partial()
export const ConceptosQuerySchema = z.object({
  convenio_id: z.coerce.number().int().positive().optional(),
  incluir_inactivos: z.string().optional(),
  /** Con fecha, cada concepto trae su `valor` vigente (sueldos_valor_concepto). */
  fecha: Fecha.optional(),
})

export const ConceptoValorCreateSchema = z.object({
  concepto_id: Id,
  vigente_desde: Fecha,
  porcentaje: z.number().gt(-1000).lt(100000).nullable().optional(),
  monto: z.number().gt(-1e12).lt(1e12).nullable().optional(),
  a_confirmar: z.boolean().optional(),
  fuente: Texto(300).optional(),
}).refine(v => v.porcentaje != null || v.monto != null, { message: 'VALOR_REQUERIDO', path: ['monto'] })
export const ConceptoValorUpdateSchema = z.object({
  porcentaje: z.number().gt(-1000).lt(100000).nullable().optional(),
  monto: z.number().gt(-1e12).lt(1e12).nullable().optional(),
  a_confirmar: z.boolean().optional(),
  fuente: Texto(300).optional(),
})

export const ParametroCreateSchema = z.object({
  clave: z.string().trim().regex(/^[a-z0-9_]{2,60}$/, 'CLAVE_INVALIDA'),
  vigente_desde: Fecha,
  valor: z.number().finite().gt(-1e12).lt(1e12),
  a_confirmar: z.boolean().optional(),
  fuente: Texto(300).optional(),
  descripcion: Texto(500).optional(),
})
export const ParametroUpdateSchema = ParametroCreateSchema.omit({ clave: true, vigente_desde: true }).partial()
export const ParametrosQuerySchema = z.object({ clave: z.string().optional(), fecha: Fecha.optional() })

export const ValoresQuerySchema = z.object({
  convenio_id: z.coerce.number().int().positive(),
  fecha: Fecha,
  zona: z.string().optional(),
})

// ── Legajos ─────────────────────────────────────────────────────────────────

const Cuil = z.string().trim().max(20)
  .transform(s => s.replace(/\D/g, ''))
  .refine(s => s === '' || cuilValido(s), 'CUIL_INVALIDO')
  .transform(s => (s === '' ? null : s))
const Cbu = z.string().trim().max(30)
  .transform(s => s.replace(/\D/g, ''))
  .refine(s => s === '' || cbuValido(s), 'CBU_INVALIDO')
  .transform(s => (s === '' ? null : s))

const LegajoCampos = {
  nombre: Texto(120),
  cuil: Cuil.nullable(),
  fecha_ingreso: Fecha.nullable(),
  fecha_egreso: Fecha.nullable(),
  categoria_id: Id.nullable(),
  zona: Zona,
  modalidad_contratacion: z.string().trim().regex(/^[a-z_]{3,40}$/, 'MODALIDAD_INVALIDA'),
  jornada: z.enum(['completa', 'parcial'], 'JORNADA_INVALIDA'),
  obra_social: Texto(120),
  obra_social_codigo: Texto(20),
  afiliado_sindicato: z.boolean(),
  cbu: Cbu.nullable(),
  banco: Texto(120),
  estado_civil: Texto(40),
  conyuge_a_cargo: z.boolean(),
  hijos_a_cargo: z.number().int().min(0, 'HIJOS_INVALIDO').max(30, 'HIJOS_INVALIDO'),
  ieric_numero: Texto(40),
  fondo_cese_cuenta: Texto(60),
  titulo_nivel: z.enum(['A', 'B', 'C'], 'TITULO_INVALIDO').nullable(),
  carnet_profesional: Texto(60),
  rifl: z.boolean(),
  obra_cod_habitual: Texto(60).nullable(),
  activo: z.boolean(),
  obs: Texto(2000),
}

const LegajoCamposSchema = z.object(LegajoCampos).partial()

export const LegajoCreateSchema = LegajoCamposSchema.extend({
  leg: Texto(10).nullable().optional(),
  chofer_id: Id.nullable().optional(),
  convenio_id: Id.optional(),
  convenio_codigo: z.string().trim().optional(),
}).refine(v => v.convenio_id != null || !!v.convenio_codigo, { message: 'CONVENIO_INVALIDO', path: ['convenio_id'] })
  .refine(v => !!v.leg || v.chofer_id != null || (v.nombre ?? '').length >= 3, { message: 'NOMBRE_REQUERIDO', path: ['nombre'] })
  .refine(v => !v.fecha_egreso || !v.fecha_ingreso || v.fecha_egreso >= v.fecha_ingreso, { message: 'FECHAS_INVALIDAS', path: ['fecha_egreso'] })

export const LegajoUpdateSchema = LegajoCamposSchema.extend({
  leg: Texto(10).nullable().optional(),
  chofer_id: Id.nullable().optional(),
  convenio_id: Id.optional(),
}).refine(v => !v.fecha_egreso || !v.fecha_ingreso || v.fecha_egreso >= v.fecha_ingreso, { message: 'FECHAS_INVALIDAS', path: ['fecha_egreso'] })

export const LegajosQuerySchema = z.object({
  convenio_id: z.coerce.number().int().positive().optional(),
  activo: z.enum(['true', 'false', 'todos']).optional(),
  incompleto: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(80).optional(),
})

// ── Liquidaciones y recibos ─────────────────────────────────────────────────

export const LiquidacionCreateSchema = z.object({
  convenio_id: Id,
  tipo: z.enum(TIPOS_LIQUIDACION, 'TIPO_INVALIDO'),
  periodo: Fecha,
  quincena: z.union([z.literal(1), z.literal(2)]).nullable().optional(),
  fecha_pago: Fecha.nullable().optional(),
  obs: Texto(1000).optional(),
}).refine(v => v.tipo !== 'quincena' || v.quincena === 1 || v.quincena === 2, { message: 'QUINCENA_INVALIDA', path: ['quincena'] })

export const LiquidacionUpdateSchema = z.object({
  fecha_pago: Fecha.nullable().optional(),
  obs: Texto(1000).optional(),
})

export const LiquidacionesQuerySchema = z.object({
  convenio_id: z.coerce.number().int().positive().optional(),
  estado: z.enum(['borrador', 'cerrada', 'anulada']).optional(),
  tipo: z.enum(TIPOS_LIQUIDACION).optional(),
  desde: Fecha.optional(),
  hasta: Fecha.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const MotivoSchema = z.object({ motivo: z.string().trim().min(3, 'MOTIVO_REQUERIDO').max(500) })

const Cant = z.number().finite().min(0).max(100000)
export const EntradasSchema = z.object({
  horas_normales: Cant.nullable().optional(),
  horas_extra_50: Cant.nullable().optional(),
  horas_extra_100: Cant.nullable().optional(),
  dias_trabajados: z.number().finite().min(0).max(31).nullable().optional(),
  asistencia: z.boolean().nullable().optional(),
  presentismo: z.boolean().nullable().optional(),
  km: Cant.nullable().optional(),
  antiguedad_anios: z.number().int().min(0).max(80).nullable().optional(),
  prestamos: z.number().finite().min(0).lt(1e12).nullable().optional(),
  conceptos: z.array(z.object({
    codigo: Codigo,
    cantidad: Cant.nullable().optional(),
    importe: Importe.nullable().optional(),
    porcentaje: z.number().finite().gt(-1000).lt(100000).nullable().optional(),
    nombre: Texto(200).nullable().optional(),
  })).max(60).nullable().optional(),
  lineas_libres: z.array(z.object({
    nombre: Texto(200).min(1, 'LINEA_NOMBRE_REQUERIDO'),
    tipo: z.enum(TIPOS_CONCEPTO, 'LINEA_TIPO_INVALIDO'),
    importe: Importe,
    codigo_arca: CodigoArca.optional(),
    destino: z.enum(DESTINOS, 'LINEA_DESTINO_INVALIDO').nullable().optional(),
    cantidad: Cant.nullable().optional(),
    unidad: z.enum(UNIDADES, 'LINEA_UNIDAD_INVALIDA').nullable().optional(),
  })).max(60).nullable().optional(),
  omitir: z.array(Codigo).max(60).nullable().optional(),
  obs: Texto(1000).nullable().optional(),
}).strict()

export const CalcularReciboSchema = z.object({
  legajo_id: Id,
  entradas: EntradasSchema.default({}),
})
export const GuardarReciboSchema = z.object({
  entradas: EntradasSchema.default({}),
  obs: Texto(1000).optional(),
})

export const GenerarSchema = z.object({
  /** Sin lista = todos los legajos activos del convenio (solo quincena, mensual y SAC). */
  legajo_ids: z.array(Id).max(500).optional(),
  /** true = recalcula también los que ya tienen recibo (pisa lo cargado). Default false. */
  reemplazar: z.boolean().optional(),
  /** Sugerir el saldo de préstamos como descuento. Default true. */
  incluir_prestamos: z.boolean().optional(),
})

export const SacQuerySchema = z.object({
  anio: z.coerce.number().int().min(2000).max(2100).optional(),
  semestre: z.coerce.number().int().min(1).max(2).optional(),
})
export const VacacionesQuerySchema = z.object({
  anio: z.coerce.number().int().min(2000).max(2100).optional(),
  dias: z.coerce.number().min(0).max(60).optional(),
})
export const FinalQuerySchema = z.object({
  fecha_egreso: Fecha.optional(),
  dias_gozados: z.coerce.number().min(0).max(60).optional(),
})

export const BancoQuerySchema = z.object({
  descargar: z.string().optional(),
  decimal: z.enum(['coma', 'punto']).optional(),
})
export const DescargarQuerySchema = z.object({ descargar: z.string().optional() })

export type ConvenioCreate = z.infer<typeof ConvenioCreateSchema>
export type LegajoCreate = z.infer<typeof LegajoCreateSchema>
export type LegajoUpdate = z.infer<typeof LegajoUpdateSchema>
export type LiquidacionCreate = z.infer<typeof LiquidacionCreateSchema>
export type EntradasInput = z.infer<typeof EntradasSchema>
