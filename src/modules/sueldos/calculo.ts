/**
 * Motor de cálculo de Sueldos (TS puro: sin base, sin red, testeable).
 *
 * Recibe el legajo, la liquidación, los valores vigentes (lo que devuelve
 * `sueldos_valores_a_fecha`: escala, conceptos con su valor y parámetros) y
 * las ENTRADAS del liquidador (horas, extras, días, km, viáticos, préstamos,
 * líneas a mano…) y devuelve las líneas del recibo con sus totales. La base
 * (`sueldos_guardar_recibo`) solo persiste y vuelve a sumar.
 *
 * Nada de montos ni porcentajes está escrito acá: todo sale de las tablas
 * (`sueldos_conceptos`, `sueldos_concepto_valores`, `sueldos_parametros`).
 * Lo único que vive en el código es la MECÁNICA, y está dirigida por las
 * columnas del concepto:
 *
 *   calculo = cantidad_x_escala → cantidad × valor de la escala × (porcentaje/100
 *             si el concepto tiene porcentaje; el básico sin valor = 100 %).
 *             El básico usa horas (categoría por hora) o días/30 (por mes).
 *   calculo = porcentaje        → base × %/100. Base: basico | remunerativo |
 *             bruto_rem_no_rem | sereno_zona_a. Si la unidad del concepto es
 *             'anios' se multiplica además por los años de antigüedad
 *             (antigüedad de Camioneros: 1 % por año).
 *   calculo = por_unidad        → cantidad × monto. Cantidad: años de antigüedad
 *             (unidad 'anios'), km (unidad 'km') o lo que cargue el liquidador.
 *   calculo = monto_fijo        → monto. Los `titulo_<nivel>` solo si coincide
 *             con legajo.titulo_nivel.
 *   calculo = manual            → solo el importe que cargue el liquidador.
 *
 * Reglas de la mecánica (decisiones documentadas en el contrato de la API):
 *   · Redondeo a 2 decimales por línea; las bases se toman ya redondeadas.
 *   · Un valor null (concepto sin valor cargado) → el concepto no se aplica y
 *     queda el aviso CONCEPTO_SIN_VALOR. Un importe 0 → no hay línea.
 *   · Condición: afiliado / no_afiliado / antigüedad < 1 / ≥ 1 / rifl / no_rifl.
 *   · Los conceptos MENSUALES de monto fijo (SCVO, ART fija, OSCHOCA, títulos,
 *     sumas del acuerdo) y los de base `sereno_zona_a` (seguro de vida UOCRA)
 *     van una sola vez por mes: en la liquidación mensual o en la 2ª quincena.
 *   · En SAC, vacaciones, final y ajuste NO se agregan solos los haberes
 *     (básico, asistencia, antigüedad…): solo lo que cargue el liquidador. Sí
 *     corren los aportes y contribuciones porcentuales sobre lo que haya.
 *   · Detracción (parámetro `detraccion_por_empleado`): baja la base de la
 *     contribución de seguridad social (`parametro_clave = contrib_patronal_pct`,
 *     o `contrib_patronal_jubilado_pct` para jubilados); mitad en cada quincena,
 *     entera en la mensual, nada en las demás.
 *   · Jubilados (`legajo.jubilado`): no entran los conceptos `excluye_jubilados`
 *     (INSSJP, obra social, contribución general) y sí los `solo_jubilados`.
 *   · Fondo de cese: contribución con destino `fondo_cese`; no resta del neto.
 */

// ── Tipos del modelo ────────────────────────────────────────────────────────

export const TIPOS_CONCEPTO = ['remunerativo', 'no_remunerativo', 'descuento', 'contribucion'] as const
export type TipoConcepto = (typeof TIPOS_CONCEPTO)[number]
export const CALCULOS = ['manual', 'cantidad_x_escala', 'porcentaje', 'monto_fijo', 'por_unidad'] as const
export type Calculo = (typeof CALCULOS)[number]
export const BASES = ['basico', 'remunerativo', 'bruto_rem_no_rem', 'sereno_zona_a'] as const
export type BaseConcepto = (typeof BASES)[number]
export const CONDICIONES = ['siempre', 'afiliado', 'no_afiliado', 'antiguedad_menor_1', 'antiguedad_mayor_igual_1', 'rifl', 'no_rifl'] as const
export type Condicion = (typeof CONDICIONES)[number]
export const DESTINOS = ['f931', 'sindicato', 'fondo_cese', 'prestamo', 'otros'] as const
export type Destino = (typeof DESTINOS)[number]
export const GRUPOS = ['sindical', 'seguridad_social', 'obra_social', 'inssjp', 'art', 'camaras', 'otros'] as const
export type GrupoContribucion = (typeof GRUPOS)[number]
export const UNIDADES = ['horas', 'dias', 'km', '%', '$', 'anios', 'unidades'] as const
export type Unidad = (typeof UNIDADES)[number]
export const TIPOS_LIQUIDACION = ['quincena', 'mensual', 'sac', 'vacaciones', 'final', 'ajuste'] as const
export type TipoLiquidacion = (typeof TIPOS_LIQUIDACION)[number]
export type UnidadBasico = 'hora' | 'mes'

export interface ValorConcepto {
  origen: 'concepto' | 'parametro'
  parametro_clave: string | null
  porcentaje: number | null
  monto: number | null
  vigente_desde: string
  a_confirmar: boolean
  fuente: string
}

export interface ConceptoMotor {
  id: number
  convenio_id: number | null
  codigo: string
  nombre: string
  tipo: TipoConcepto
  calculo: Calculo
  base: BaseConcepto | null
  condicion: Condicion
  codigo_arca: string | null
  grupo_contribucion: GrupoContribucion | null
  destino: Destino | null
  parametro_clave: string | null
  unidad: Unidad | null
  en_recibo: boolean
  orden: number
  automatico: boolean
  activo: boolean
  /** No se aplica a jubilados (aportes y contribuciones de obra social e INSSJP, contribución general). */
  excluye_jubilados?: boolean
  /** Se aplica solo a jubilados (contribución previsional reducida). */
  solo_jubilados?: boolean
  valor: ValorConcepto | null
}

export interface CategoriaMotor {
  id: number
  codigo: string
  nombre: string
  orden: number
  unidad_basico: UnidadBasico
  por_defecto: boolean
  activo: boolean
  valor: number | null
  vigente_desde: string | null
  a_confirmar: boolean | null
  fuente: string | null
}

export interface ParametroVigente {
  valor: number
  vigente_desde: string
  a_confirmar: boolean
  fuente: string
}

/** Lo que devuelve `sueldos_valores_a_fecha(convenio, fecha, zona)`. */
export interface ValoresAFecha {
  fecha: string
  zona: string
  convenio: { id: number; codigo: string; nombre: string; periodicidad: 'quincenal' | 'mensual'; unidad_basico: UnidadBasico }
  categorias: CategoriaMotor[]
  conceptos: ConceptoMotor[]
  parametros: Record<string, ParametroVigente>
  sereno_zona_a: number | null
}

/** Lo que el motor necesita del legajo. */
export interface LegajoMotor {
  id: number
  categoria_id: number | null
  zona: string
  fecha_ingreso: string | null
  fecha_egreso: string | null
  afiliado_sindicato: boolean
  rifl: boolean
  /** Jubilado que sigue trabajando: sin INSSJP ni obra social, contribución previsional reducida. */
  jubilado?: boolean
  titulo_nivel: 'A' | 'B' | 'C' | null
}

export interface LiquidacionMotor {
  tipo: TipoLiquidacion
  /** YYYY-MM-01 */
  periodo: string
  quincena: 1 | 2 | null
}

// ── Entradas del liquidador ─────────────────────────────────────────────────

/** Un concepto del catálogo agregado o ajustado a mano (por código). */
export interface EntradaConcepto {
  codigo: string
  /** Horas, días, km, unidades o años según el concepto. */
  cantidad?: number | null
  /** Importe fijo: pisa el cálculo (la línea queda `manual`). */
  importe?: number | null
  /** Porcentaje propio (p. ej. adicional por tarea 15 %): pisa el del concepto. */
  porcentaje?: number | null
  /** Nombre a mostrar (p. ej. «Adicional por guardia»). */
  nombre?: string | null
}

/** Línea sin concepto del catálogo. */
export interface LineaLibre {
  nombre: string
  tipo: TipoConcepto
  importe: number
  codigo_arca?: string | null
  destino?: Destino | null
  cantidad?: number | null
  unidad?: Unidad | null
}

export interface EntradasRecibo {
  /** UOCRA (y cualquier categoría por hora): horas normales de la quincena. */
  horas_normales?: number | null
  horas_extra_50?: number | null
  horas_extra_100?: number | null
  /** Mensuales: días trabajados (default 30; 15 si es una quincena de un mensual). */
  dias_trabajados?: number | null
  /** UOCRA: asistencia perfecta en la quincena (default true). */
  asistencia?: boolean | null
  /** UECARA: presentismo (default true). */
  presentismo?: boolean | null
  /** Camioneros: km recorridos (km remunerativo + viático por km). */
  km?: number | null
  /** Pisa los años de antigüedad calculados con la fecha de ingreso. */
  antiguedad_anios?: number | null
  /** Importe de préstamos/anticipos a descontar (concepto `prestamo`). */
  prestamos?: number | null
  /** Conceptos del catálogo que no son automáticos (viáticos, falla de caja, SAC, vacaciones…) o ajustes de uno automático. */
  conceptos?: EntradaConcepto[] | null
  lineas_libres?: LineaLibre[] | null
  /** Códigos de conceptos automáticos que NO van en este recibo. */
  omitir?: string[] | null
  obs?: string | null
}

// ── Salida ──────────────────────────────────────────────────────────────────

export interface LineaCalculada {
  concepto_id: number | null
  codigo: string | null
  nombre: string
  tipo: TipoConcepto
  destino: Destino | null
  grupo_contribucion: GrupoContribucion | null
  codigo_arca: string | null
  cantidad: number | null
  unidad: Unidad | null
  base: number | null
  porcentaje: number | null
  importe: number
  manual: boolean
  en_recibo: boolean
  orden: number
  a_confirmar: boolean
}

export interface TotalesRecibo {
  remunerativo: number
  no_remunerativo: number
  descuentos: number
  neto: number
  /** Contribuciones patronales SIN el fondo de cese. */
  contribuciones: number
  fondo_cese: number
  /** Costo empresa = rem + no rem + contribuciones + fondo de cese. */
  costo_total: number
}

export type CodigoAviso =
  | 'CONCEPTO_SIN_VALOR' | 'VALOR_A_CONFIRMAR' | 'ESCALA_A_CONFIRMAR' | 'SIN_FECHA_INGRESO'
  | 'NETO_NEGATIVO' | 'SIN_CODIGO_ARCA' | 'HORAS_MES_POR_DEFECTO' | 'SIN_HISTORIAL' | 'LEGAJO_EGRESADO'

export interface AvisoCalculo {
  codigo: CodigoAviso
  detalle?: Record<string, unknown>
}

export interface ResultadoCalculo {
  lineas: LineaCalculada[]
  totales: TotalesRecibo
  dias_trabajados: number | null
  horas_trabajadas: number | null
  antiguedad_anios: number
  valor_escala: number
  unidad_basico: UnidadBasico
  valor_hora: number
  fecha_valores: string
  avisos: AvisoCalculo[]
}

export class CalculoError extends Error {
  constructor(public code: string, public detail?: Record<string, unknown>) {
    super(code)
    this.name = 'CalculoError'
  }
}

// ── Utilidades ──────────────────────────────────────────────────────────────

/** Redondeo a centavos, simétrico para negativos. */
export function r2(n: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  const s = v < 0 ? -1 : 1
  return (s * Math.round((Math.abs(v) + Number.EPSILON) * 100)) / 100
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseISO(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 }
}

function utc(iso: string): number {
  const { y, m, d } = parseISO(iso)
  return Date.UTC(y, m - 1, d)
}

export function isoDe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function ultimoDiaDelMes(periodo: string): string {
  const { y, m } = parseISO(periodo)
  return isoDe(Date.UTC(y, m, 0))
}

/** Días corridos entre dos fechas, ambas inclusive (0 si hasta < desde). */
export function diasEntre(desde: string, hasta: string): number {
  const n = Math.round((utc(hasta) - utc(desde)) / 86_400_000) + 1
  return n > 0 ? n : 0
}

/**
 * Días entre dos fechas (inclusive) con MES DE 30 DÍAS SIEMPRE, el criterio del
 * contador (27/09/2026) para mensualizados y SAC: el último día del mes (28, 29
 * o 31) cuenta como 30, así un mes completo da 30 y un semestre 180.
 */
export function dias30(desde: string, hasta: string): number {
  if (hasta < desde) return 0
  const a = parseISO(desde), b = parseISO(hasta)
  const dia = (iso: string, y: number, m: number) => {
    const d = Number(iso.slice(8, 10))
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return d === ultimo ? 30 : Math.min(d, 30)
  }
  const d1 = Math.min(Number(desde.slice(8, 10)), 30)
  const d2 = dia(hasta, b.y, b.m)
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1) + 1
}

/** Rango devengado de la liquidación: 1–15 / 16–fin para quincenas; el mes para lo demás. */
export function rangoPeriodo(l: LiquidacionMotor): { desde: string; hasta: string } {
  const { y, m } = parseISO(l.periodo)
  const primero = isoDe(Date.UTC(y, m - 1, 1))
  const fin = ultimoDiaDelMes(primero)
  if (l.tipo === 'quincena' && l.quincena === 1) return { desde: primero, hasta: isoDe(Date.UTC(y, m - 1, 15)) }
  if (l.tipo === 'quincena' && l.quincena === 2) return { desde: isoDe(Date.UTC(y, m - 1, 16)), hasta: fin }
  return { desde: primero, hasta: fin }
}

/** Fecha a la que se toman escala, conceptos y parámetros: el fin del período devengado (igual que la base). */
export function fechaDeValores(l: LiquidacionMotor): string {
  return rangoPeriodo(l).hasta
}

/** Años COMPLETOS de antigüedad a una fecha (0 sin fecha de ingreso o si ingresó después). */
export function aniosAntiguedad(fechaIngreso: string | null, aFecha: string): number {
  if (!fechaIngreso) return 0
  const i = parseISO(fechaIngreso)
  const f = parseISO(aFecha)
  let a = f.y - i.y
  if (f.m < i.m || (f.m === i.m && f.d < i.d)) a -= 1
  return a > 0 ? a : 0
}

/** CUIL/CUIT: 11 dígitos con dígito verificador (mod 11, pesos 5432765432; 11 → 0, 10 → 9). Espejo de `_sueldos_cuil_valido`. */
export function cuilValido(v: string | null | undefined): boolean {
  const s = String(v ?? '').replace(/\D/g, '')
  if (!/^\d{11}$/.test(s)) return false
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i++) sum += Number(s[i]) * (w[i] ?? 0)
  let d = 11 - (sum % 11)
  if (d === 11) d = 0
  else if (d === 10) d = 9
  return d === Number(s[10])
}

/** CBU: 22 dígitos con los dos dígitos verificadores. Espejo de `_sueldos_cbu_valido`. */
export function cbuValido(v: string | null | undefined): boolean {
  const s = String(v ?? '').replace(/\D/g, '')
  if (!/^\d{22}$/.test(s)) return false
  const w1 = [7, 1, 3, 9, 7, 1, 3]
  const w2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]
  let a = 0
  for (let i = 0; i < 7; i++) a += Number(s[i]) * (w1[i] ?? 0)
  if ((10 - (a % 10)) % 10 !== Number(s[7])) return false
  let b = 0
  for (let i = 0; i < 13; i++) b += Number(s[8 + i]) * (w2[i] ?? 0)
  return (10 - (b % 10)) % 10 === Number(s[21])
}

function cumpleCondicion(c: Condicion, legajo: LegajoMotor, anios: number): boolean {
  switch (c) {
    case 'siempre': return true
    case 'afiliado': return legajo.afiliado_sindicato === true
    case 'no_afiliado': return legajo.afiliado_sindicato !== true
    case 'antiguedad_menor_1': return anios < 1
    case 'antiguedad_mayor_igual_1': return anios >= 1
    case 'rifl': return legajo.rifl === true
    case 'no_rifl': return legajo.rifl !== true
    default: return false
  }
}

/** Contribuciones de seguridad social cuya base baja por la detracción (Ley 27.430). */
const PARAMETROS_CON_DETRACCION = new Set(['contrib_patronal_pct', 'contrib_patronal_jubilado_pct'])

const esRegular = (t: TipoLiquidacion) => t === 'quincena' || t === 'mensual'

/** ¿Corresponde aplicar en esta liquidación un concepto que es mensual (una vez por mes)? */
function tocaMensual(l: LiquidacionMotor): boolean {
  return l.tipo === 'mensual' || (l.tipo === 'quincena' && l.quincena === 2)
}

/** Horas del mes para pasar un básico mensual a valor hora (extras de mensualizados). Sin parámetro: 200. */
function horasMes(v: ValoresAFecha): { horas: number; porDefecto: boolean } {
  const p = v.parametros[`horas_mes_${v.convenio.codigo}`] ?? v.parametros.horas_mes
  const n = num(p?.valor)
  return n && n > 0 ? { horas: n, porDefecto: false } : { horas: 200, porDefecto: true }
}

// ── Motor ───────────────────────────────────────────────────────────────────

export interface EntradaMotor {
  legajo: LegajoMotor
  liquidacion: LiquidacionMotor
  valores: ValoresAFecha
  entradas: EntradasRecibo
}

/**
 * Calcula las líneas del recibo. Tira `CalculoError` si no se puede calcular
 * (legajo sin categoría, categoría sin escala, concepto desconocido, importe
 * faltante en un concepto manual…); lo demás son avisos.
 */
export function calcularRecibo(inp: EntradaMotor): ResultadoCalculo {
  const { legajo, liquidacion: liq, valores: v } = inp
  const e = inp.entradas ?? {}
  const avisos: AvisoCalculo[] = []
  const fecha = v.fecha || fechaDeValores(liq)
  const regular = esRegular(liq.tipo)

  // Categoría y escala.
  if (legajo.categoria_id == null) throw new CalculoError('LEGAJO_SIN_CATEGORIA', { legajo_id: legajo.id, campo: 'categoria_id' })
  const cat = v.categorias.find(c => Number(c.id) === Number(legajo.categoria_id))
  if (!cat) throw new CalculoError('CATEGORIA_OTRO_CONVENIO', { legajo_id: legajo.id, categoria_id: legajo.categoria_id })
  const valorEscala = num(cat.valor)
  if (valorEscala == null || valorEscala <= 0) {
    throw new CalculoError('SIN_ESCALA', { categoria_id: cat.id, categoria: cat.nombre, zona: v.zona, fecha })
  }
  if (cat.a_confirmar) avisos.push({ codigo: 'ESCALA_A_CONFIRMAR', detalle: { categoria: cat.nombre, valor: valorEscala } })
  const unidad: UnidadBasico = cat.unidad_basico === 'mes' ? 'mes' : 'hora'
  const quincenaDeMensual = unidad === 'mes' && liq.tipo === 'quincena'

  // Antigüedad.
  const aniosOverride = num(e.antiguedad_anios)
  const anios = aniosOverride != null ? Math.max(0, Math.floor(aniosOverride)) : aniosAntiguedad(legajo.fecha_ingreso, fecha)
  if (!legajo.fecha_ingreso && aniosOverride == null) avisos.push({ codigo: 'SIN_FECHA_INGRESO' })
  if (legajo.fecha_egreso && legajo.fecha_egreso < rangoPeriodo(liq).desde) {
    avisos.push({ codigo: 'LEGAJO_EGRESADO', detalle: { fecha_egreso: legajo.fecha_egreso } })
  }

  // Valor hora (extras): la escala si es por hora; si es mensual, básico / horas del mes.
  const hm = horasMes(v)
  const valorHora = unidad === 'hora' ? valorEscala : r2(valorEscala / hm.horas)

  // Conceptos: los del catálogo vigente, por código.
  const porCodigo = new Map<string, ConceptoMotor>()
  for (const k of v.conceptos) if (k.activo !== false) porCodigo.set(k.codigo, k)
  const omitir = new Set((e.omitir ?? []).map(String))
  const pedidos = new Map<string, EntradaConcepto>()
  for (const x of e.conceptos ?? []) {
    if (!porCodigo.has(x.codigo)) throw new CalculoError('CONCEPTO_DESCONOCIDO', { codigo: x.codigo, campo: 'conceptos' })
    pedidos.set(x.codigo, x)
  }
  // Atajos de las entradas → conceptos.
  const atajo = (codigo: string, cantidad: number | null | undefined) => {
    const n = num(cantidad)
    if (n == null || n === 0 || !porCodigo.has(codigo) || pedidos.has(codigo)) return
    pedidos.set(codigo, { codigo, cantidad: n })
  }
  atajo('horas_extra_50', e.horas_extra_50)
  atajo('horas_extra_100', e.horas_extra_100)
  const prestamos = num(e.prestamos)
  if (prestamos && prestamos > 0 && porCodigo.has('prestamo') && !pedidos.has('prestamo')) {
    pedidos.set('prestamo', { codigo: 'prestamo', importe: prestamos })
  }
  // Km: todo concepto por km (km remunerativo y viático por km) toma los km cargados.
  const km = num(e.km) ?? 0
  if (km > 0) {
    for (const k of porCodigo.values()) {
      if (k.calculo === 'por_unidad' && k.unidad === 'km' && !pedidos.has(k.codigo)) pedidos.set(k.codigo, { codigo: k.codigo, cantidad: km })
    }
  }
  if (e.asistencia === false) omitir.add('asistencia')
  if (e.presentismo === false) omitir.add('presentismo')

  const lineas: LineaCalculada[] = []
  const valorConfirmar: string[] = []
  const sinValor: string[] = []

  const agregar = (k: ConceptoMotor | null, l: Omit<LineaCalculada, 'orden' | 'a_confirmar' | 'en_recibo' | 'concepto_id' | 'codigo'> & { a_confirmar?: boolean; en_recibo?: boolean }) => {
    const importe = r2(l.importe)
    if (importe === 0) return
    lineas.push({
      concepto_id: k ? Number(k.id) : null,
      codigo: k ? k.codigo : null,
      ...l,
      importe,
      en_recibo: l.en_recibo ?? k?.en_recibo ?? true,
      orden: k ? Number(k.orden) : 900,
      a_confirmar: l.a_confirmar ?? false,
    })
    if (l.a_confirmar && k) valorConfirmar.push(k.codigo)
  }

  const base = (b: BaseConcepto | null): number => {
    const suma = (t: TipoConcepto) => r2(lineas.filter(x => x.tipo === t).reduce((s, x) => s + x.importe, 0))
    switch (b) {
      case 'basico': return r2(lineas.filter(x => x.codigo === 'basico').reduce((s, x) => s + x.importe, 0))
      case 'remunerativo': return suma('remunerativo')
      case 'bruto_rem_no_rem': return r2(suma('remunerativo') + suma('no_remunerativo'))
      case 'sereno_zona_a': return num(v.sereno_zona_a) ?? 0
      default: return 0
    }
  }

  const detraccion = (): number => {
    const d = num(v.parametros.detraccion_por_empleado?.valor) ?? 0
    if (liq.tipo === 'mensual') return d
    if (liq.tipo === 'quincena') return r2(d / 2)
    return 0
  }

  /** Aplica un concepto del catálogo. `pedido` = lo que cargó el liquidador para ese código. */
  const aplicar = (k: ConceptoMotor, pedido: EntradaConcepto | undefined) => {
    const nombre = (pedido?.nombre ?? '').trim() || k.nombre
    const comunes = {
      nombre, tipo: k.tipo, destino: k.destino, grupo_contribucion: k.tipo === 'contribucion' ? k.grupo_contribucion : null,
      codigo_arca: k.codigo_arca,
    }
    const imp = num(pedido?.importe)
    if (imp != null) {
      agregar(k, { ...comunes, cantidad: num(pedido?.cantidad), unidad: k.unidad, base: null, porcentaje: null, importe: imp, manual: true })
      return
    }
    if (k.calculo === 'manual') {
      if (pedido) throw new CalculoError('IMPORTE_REQUERIDO', { codigo: k.codigo, campo: 'conceptos' })
      return
    }
    const val = k.valor
    const pctPedido = num(pedido?.porcentaje)
    const aConf = !!val?.a_confirmar

    // El básico no necesita valor del concepto: sale de la escala.
    if (k.codigo === 'basico' && k.calculo === 'cantidad_x_escala') {
      const factor = val && num(val.porcentaje) != null ? (num(val.porcentaje) ?? 100) / 100 : 1
      if (unidad === 'hora') {
        const horas = num(pedido?.cantidad) ?? num(e.horas_normales) ?? 0
        agregar(k, { ...comunes, cantidad: horas, unidad: 'horas', base: valorEscala, porcentaje: null,
          importe: horas * valorEscala * factor, manual: false, a_confirmar: aConf })
      } else {
        const diasBase = quincenaDeMensual ? 15 : (num(v.parametros.dias_mes?.valor) ?? 30)
        const dias = num(pedido?.cantidad) ?? num(e.dias_trabajados) ?? diasBase
        const mensual = quincenaDeMensual ? valorEscala / 2 : valorEscala
        const imp2 = dias >= diasBase ? mensual : (mensual / diasBase) * dias
        agregar(k, { ...comunes, cantidad: dias, unidad: 'dias', base: valorEscala, porcentaje: null,
          importe: imp2 * factor, manual: false, a_confirmar: aConf })
      }
      return
    }

    if (!val || (val.porcentaje == null && val.monto == null)) {
      if (pctPedido == null) { sinValor.push(k.codigo); return }
    }
    const pct = pctPedido ?? num(val?.porcentaje)
    const monto = num(val?.monto)

    switch (k.calculo) {
      case 'cantidad_x_escala': {
        const cant = num(pedido?.cantidad) ?? 0
        const vh = k.unidad === 'horas' || k.codigo.startsWith('horas_') ? valorHora : valorEscala
        const f = pct != null ? pct / 100 : 1
        agregar(k, { ...comunes, cantidad: cant, unidad: k.unidad, base: vh, porcentaje: pct, importe: cant * vh * f, manual: false, a_confirmar: aConf })
        return
      }
      case 'porcentaje': {
        if (pct == null) { sinValor.push(k.codigo); return }
        if (k.base === 'sereno_zona_a' && !tocaMensual(liq)) return
        let b = base(k.base)
        if (k.parametro_clave && PARAMETROS_CON_DETRACCION.has(k.parametro_clave)) b = Math.max(0, r2(b - detraccion()))
        let cant: number | null = null
        let factorAnios = 1
        if (k.unidad === 'anios') {
          cant = num(pedido?.cantidad) ?? anios
          factorAnios = cant
        }
        agregar(k, { ...comunes, cantidad: cant, unidad: k.unidad === 'anios' ? 'anios' : '%', base: b, porcentaje: pct,
          importe: (b * pct * factorAnios) / 100, manual: false, a_confirmar: aConf })
        return
      }
      case 'por_unidad': {
        if (monto == null) { sinValor.push(k.codigo); return }
        let cant = num(pedido?.cantidad)
        if (cant == null) {
          if (k.unidad === 'anios') cant = anios
          else if (k.unidad === 'km') cant = num(e.km) ?? 0
          else cant = 0
        }
        agregar(k, { ...comunes, cantidad: cant, unidad: k.unidad, base: monto, porcentaje: null, importe: cant * monto, manual: false, a_confirmar: aConf })
        return
      }
      case 'monto_fijo': {
        if (monto == null) { sinValor.push(k.codigo); return }
        const cant = num(pedido?.cantidad)
        agregar(k, { ...comunes, cantidad: cant, unidad: k.unidad, base: null, porcentaje: null,
          importe: monto * (cant ?? 1), manual: false, a_confirmar: aConf })
        return
      }
      default:
        return
    }
  }

  /** ¿Entra solo este concepto automático en este recibo? */
  const entraSolo = (k: ConceptoMotor): boolean => {
    if (!k.automatico || omitir.has(k.codigo)) return false
    if (!cumpleCondicion(k.condicion, legajo, anios)) return false
    if (legajo.jubilado ? k.excluye_jubilados === true : k.solo_jubilados === true) return false
    const haber = k.tipo === 'remunerativo' || k.tipo === 'no_remunerativo'
    if (haber && !regular) return false
    // Mensuales: una sola vez por mes.
    if (k.calculo === 'monto_fijo' && !tocaMensual(liq)) return false
    const titulo = /^titulo_([abc])$/.exec(k.codigo)
    if (titulo && (legajo.titulo_nivel ?? '').toLowerCase() !== titulo[1]) return false
    // Km: solo si hay km cargados (y entonces ya vienen como pedido).
    if (k.calculo === 'por_unidad' && k.unidad === 'km') return false
    return true
  }

  const ordenados = [...porCodigo.values()].sort((a, b) => Number(a.orden) - Number(b.orden) || Number(a.id) - Number(b.id))
  const correr = (filtro: (k: ConceptoMotor) => boolean) => {
    for (const k of ordenados) {
      if (!filtro(k)) continue
      const pedido = pedidos.get(k.codigo)
      if (pedido || entraSolo(k)) aplicar(k, pedido)
    }
  }
  const sobreRem = (k: ConceptoMotor) => k.calculo === 'porcentaje' && (k.base === 'remunerativo' || k.base === 'bruto_rem_no_rem')

  // 1) Básico primero (la base de los porcentajes sobre el básico).
  correr(k => k.codigo === 'basico')
  // 2) Haberes que no dependen del total remunerativo.
  correr(k => (k.tipo === 'remunerativo' || k.tipo === 'no_remunerativo') && k.codigo !== 'basico' && !sobreRem(k))
  // 3) Haberes porcentuales sobre el remunerativo (raros, pero posibles).
  correr(k => (k.tipo === 'remunerativo' || k.tipo === 'no_remunerativo') && k.codigo !== 'basico' && sobreRem(k))
  // 4) Líneas libres de haberes.
  const libres = e.lineas_libres ?? []
  for (const l of libres.filter(x => x.tipo === 'remunerativo' || x.tipo === 'no_remunerativo')) agregarLibre(l)
  // 5) Descuentos y 6) contribuciones.
  correr(k => k.tipo === 'descuento')
  for (const l of libres.filter(x => x.tipo === 'descuento')) agregarLibre(l)
  correr(k => k.tipo === 'contribucion')
  for (const l of libres.filter(x => x.tipo === 'contribucion')) agregarLibre(l)

  function agregarLibre(l: LineaLibre) {
    const esDesc = l.tipo === 'descuento' || l.tipo === 'contribucion'
    agregar(null, {
      nombre: l.nombre.trim(), tipo: l.tipo, destino: esDesc ? (l.destino ?? 'otros') : null,
      grupo_contribucion: l.tipo === 'contribucion' ? 'otros' : null,
      codigo_arca: l.codigo_arca ?? null, cantidad: num(l.cantidad), unidad: l.unidad ?? null,
      base: null, porcentaje: null, importe: l.importe, manual: true,
    })
  }

  // Orden estable: por el orden del concepto y, a igual orden, como se agregaron.
  const conIndice = lineas.map((l, i) => ({ l, i }))
  conIndice.sort((a, b) => a.l.orden - b.l.orden || a.i - b.i)
  const final = conIndice.map(x => x.l)

  if (unidad === 'mes' && hm.porDefecto && final.some(l => l.unidad === 'horas' && l.codigo !== 'basico')) {
    avisos.push({ codigo: 'HORAS_MES_POR_DEFECTO', detalle: { horas_mes: 200 } })
  }
  const totales = totalesDe(final)
  if (totales.neto < 0) avisos.push({ codigo: 'NETO_NEGATIVO', detalle: { neto: totales.neto } })
  if (sinValor.length) avisos.push({ codigo: 'CONCEPTO_SIN_VALOR', detalle: { conceptos: [...new Set(sinValor)] } })
  if (valorConfirmar.length) avisos.push({ codigo: 'VALOR_A_CONFIRMAR', detalle: { conceptos: [...new Set(valorConfirmar)] } })
  const sinArca = final.filter(l => l.tipo !== 'contribucion' && !l.codigo_arca).map(l => l.codigo ?? l.nombre)
  if (sinArca.length) avisos.push({ codigo: 'SIN_CODIGO_ARCA', detalle: { conceptos: [...new Set(sinArca)] } })

  const basico = final.find(l => l.codigo === 'basico')
  const horasTot = unidad === 'hora'
    ? r2((basico?.cantidad ?? 0) + (num(pedidos.get('horas_extra_50')?.cantidad) ?? 0) + (num(pedidos.get('horas_extra_100')?.cantidad) ?? 0))
    : null
  return {
    lineas: final,
    totales,
    dias_trabajados: unidad === 'mes' ? (basico?.cantidad ?? num(e.dias_trabajados)) : num(e.dias_trabajados),
    horas_trabajadas: horasTot != null && horasTot > 0 ? horasTot : null,
    antiguedad_anios: anios,
    valor_escala: valorEscala,
    unidad_basico: unidad,
    valor_hora: valorHora,
    fecha_valores: fecha,
    avisos,
  }
}

/** Totales de un conjunto de líneas (mismo criterio que `sueldos_guardar_recibo`). */
export function totalesDe(lineas: Pick<LineaCalculada, 'tipo' | 'destino' | 'importe'>[]): TotalesRecibo {
  let rem = 0, nor = 0, des = 0, con = 0, fc = 0
  for (const l of lineas) {
    const i = r2(l.importe)
    if (l.tipo === 'remunerativo') rem += i
    else if (l.tipo === 'no_remunerativo') nor += i
    else if (l.tipo === 'descuento') des += i
    else if (l.destino === 'fondo_cese') fc += i
    else con += i
  }
  rem = r2(rem); nor = r2(nor); des = r2(des); con = r2(con); fc = r2(fc)
  return {
    remunerativo: rem, no_remunerativo: nor, descuentos: des, neto: r2(rem + nor - des),
    contribuciones: con, fondo_cese: fc, costo_total: r2(rem + nor + con + fc),
  }
}

/** Líneas en el formato de `p_lineas` de `sueldos_guardar_recibo` (sin `codigo` ni `a_confirmar`). */
export function lineasParaGuardar(lineas: LineaCalculada[]) {
  return lineas.map((l, i) => ({
    concepto_id: l.concepto_id,
    nombre: l.nombre,
    tipo: l.tipo,
    importe: l.importe,
    cantidad: l.cantidad,
    unidad: l.unidad,
    base: l.base,
    porcentaje: l.porcentaje,
    codigo_arca: l.codigo_arca,
    destino: l.destino,
    grupo_contribucion: l.grupo_contribucion,
    manual: l.manual,
    en_recibo: l.en_recibo,
    orden: i,
  }))
}

// ── SAC ─────────────────────────────────────────────────────────────────────

/** Fila de `sueldos_historial_remuneraciones`. */
export interface HistorialFila {
  periodo: string
  tipo: TipoLiquidacion
  total_remunerativo: number
  total_no_remunerativo: number
  dias_trabajados: number | null
  horas_trabajadas: number | null
  recibos: number
}

/** Tipos de liquidación que forman la «remuneración mensual» (el SAC y la final no). */
export const TIPOS_REMUNERACION_MENSUAL: readonly TipoLiquidacion[] = ['quincena', 'mensual', 'vacaciones', 'ajuste']

export interface SugerenciaSac {
  anio: number
  semestre: 1 | 2
  desde: string
  hasta: string
  meses: { periodo: string; remunerativo: number }[]
  mejor_periodo: string | null
  mejor_remuneracion: number
  dias_semestre: number
  dias_computados: number
  importe: number
  proporcional: boolean
  avisos: AvisoCalculo[]
}

export function semestreDe(periodo: string): { anio: number; semestre: 1 | 2 } {
  const { y, m } = parseISO(periodo)
  return { anio: y, semestre: m <= 6 ? 1 : 2 }
}

export function rangoSemestre(anio: number, semestre: 1 | 2): { desde: string; hasta: string } {
  return semestre === 1 ? { desde: `${anio}-01-01`, hasta: `${anio}-06-30` } : { desde: `${anio}-07-01`, hasta: `${anio}-12-31` }
}

/** Remuneración mensual por período (suma quincenas, mensual, vacaciones y ajustes). */
export function remuneracionesMensuales(historial: HistorialFila[]): { periodo: string; remunerativo: number }[] {
  const m = new Map<string, number>()
  for (const h of historial) {
    if (!TIPOS_REMUNERACION_MENSUAL.includes(h.tipo)) continue
    const p = String(h.periodo).slice(0, 10)
    m.set(p, r2((m.get(p) ?? 0) + (num(h.total_remunerativo) ?? 0)))
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([periodo, remunerativo]) => ({ periodo, remunerativo }))
}

/**
 * SAC = 50 % de la mejor remuneración mensual del semestre, proporcional a
 * los días trabajados en el semestre (ingreso después del 1º o egreso antes
 * del fin: Ley 23.041), contados con meses de 30 días (contador, 27/09/2026:
 * el mes del egreso entra proporcional a los días trabajados). `hasta` corta el
 * semestre (liquidación final).
 */
export function calcularSac(args: {
  historial: HistorialFila[]
  anio: number
  semestre: 1 | 2
  fecha_ingreso: string | null
  fecha_egreso?: string | null
  hasta?: string | null
}): SugerenciaSac {
  const rango = rangoSemestre(args.anio, args.semestre)
  const avisos: AvisoCalculo[] = []
  const meses = remuneracionesMensuales(args.historial).filter(x => x.periodo >= rango.desde && x.periodo <= rango.hasta)
  let mejor: { periodo: string; remunerativo: number } | null = null
  for (const x of meses) if (!mejor || x.remunerativo > mejor.remunerativo) mejor = x
  if (!mejor) avisos.push({ codigo: 'SIN_HISTORIAL', detalle: { desde: rango.desde, hasta: rango.hasta } })
  // Meses de 30 días (semestre = 180): el mes del egreso entra por los días trabajados.
  const diasSem = dias30(rango.desde, rango.hasta)
  const ini = args.fecha_ingreso && args.fecha_ingreso > rango.desde ? args.fecha_ingreso : rango.desde
  let fin = rango.hasta
  for (const f of [args.fecha_egreso, args.hasta]) if (f && f < fin) fin = f
  const computados = Math.min(diasSem, dias30(ini, fin))
  const importe = mejor ? r2((mejor.remunerativo / 2) * (computados / diasSem)) : 0
  return {
    anio: args.anio, semestre: args.semestre, desde: rango.desde, hasta: rango.hasta, meses,
    mejor_periodo: mejor?.periodo ?? null, mejor_remuneracion: mejor?.remunerativo ?? 0,
    dias_semestre: diasSem, dias_computados: computados, importe, proporcional: computados < diasSem, avisos,
  }
}

// ── Vacaciones ──────────────────────────────────────────────────────────────

/** LCT art. 150: días de vacaciones por antigüedad al 31/12 del año. */
export function diasVacacionesPorAntiguedad(anios: number): 14 | 21 | 28 | 35 {
  if (anios >= 20) return 35
  if (anios >= 10) return 28
  if (anios >= 5) return 21
  return 14
}

export interface SugerenciaVacaciones {
  anio: number
  antiguedad_anios: number
  /** 'escala' = 14/21/28/35; 'proporcional' = 1 día cada 20 (menos de 6 meses trabajados en el año). */
  criterio: 'escala' | 'proporcional'
  dias: number
  valor_dia: number
  /** 'jornal' (UOCRA: horas del día × valor hora) o 'sueldo_25' (mensual / divisor). */
  base_valor: 'jornal' | 'sueldo_25'
  remuneracion_base: number
  importe: number
  avisos: AvisoCalculo[]
}

/** Valor de un día de vacaciones: jornal (por hora) o remuneración mensual / 25 (LCT art. 155). */
export function valorDiaVacaciones(args: {
  unidad_basico: UnidadBasico
  valor_escala: number
  horas_dia: number | null
  divisor: number | null
  remuneracion_mensual?: number | null
}): { valor_dia: number; base_valor: 'jornal' | 'sueldo_25'; remuneracion_base: number } {
  if (args.unidad_basico === 'hora') {
    const h = args.horas_dia && args.horas_dia > 0 ? args.horas_dia : 9
    return { valor_dia: r2(h * args.valor_escala), base_valor: 'jornal', remuneracion_base: r2(h * args.valor_escala) }
  }
  const div = args.divisor && args.divisor > 0 ? args.divisor : 25
  const rem = args.remuneracion_mensual && args.remuneracion_mensual > 0 ? args.remuneracion_mensual : args.valor_escala
  return { valor_dia: r2(rem / div), base_valor: 'sueldo_25', remuneracion_base: r2(rem) }
}

export function calcularVacaciones(args: {
  anio: number
  fecha_ingreso: string | null
  unidad_basico: UnidadBasico
  valor_escala: number
  horas_dia: number | null
  divisor: number | null
  remuneracion_mensual?: number | null
  /** Pisa los días (el liquidador sabe cuántos se toman). */
  dias?: number | null
}): SugerenciaVacaciones {
  const avisos: AvisoCalculo[] = []
  const finAnio = `${args.anio}-12-31`
  if (!args.fecha_ingreso) avisos.push({ codigo: 'SIN_FECHA_INGRESO' })
  const anios = aniosAntiguedad(args.fecha_ingreso, finAnio)
  let criterio: 'escala' | 'proporcional' = 'escala'
  let dias: number = diasVacacionesPorAntiguedad(anios)
  // LCT art. 153: con menos de la mitad del año trabajado, 1 día cada 20 (aprox.: días corridos desde el ingreso).
  if (args.fecha_ingreso && args.fecha_ingreso > `${args.anio}-01-01` && args.fecha_ingreso <= finAnio) {
    const corridos = diasEntre(args.fecha_ingreso, finAnio)
    if (corridos < 183) { criterio = 'proporcional'; dias = Math.floor(corridos / 20) }
  }
  const d = num(args.dias)
  if (d != null) dias = d
  const vd = valorDiaVacaciones(args)
  return {
    anio: args.anio, antiguedad_anios: anios, criterio, dias, ...vd, importe: r2(dias * vd.valor_dia), avisos,
  }
}

// ── Liquidación final ───────────────────────────────────────────────────────

export interface SugerenciaFinal {
  fecha_egreso: string
  sac_proporcional: SugerenciaSac
  vacaciones_no_gozadas: {
    dias_anuales: number
    dias_trabajados_anio: number
    dias_gozados: number
    dias: number
    valor_dia: number
    importe: number
  }
  avisos: AvisoCalculo[]
}

/**
 * Final = SAC proporcional del semestre hasta el egreso + vacaciones no gozadas
 * (LCT art. 156: días del año × días trabajados en el año / 365, menos los ya
 * gozados) + lo que se cargue a mano (indemnización, preaviso…).
 */
export function calcularFinal(args: {
  fecha_egreso: string
  fecha_ingreso: string | null
  historial: HistorialFila[]
  unidad_basico: UnidadBasico
  valor_escala: number
  horas_dia: number | null
  divisor: number | null
  remuneracion_mensual?: number | null
  dias_gozados?: number | null
}): SugerenciaFinal {
  const { anio, semestre } = semestreDe(args.fecha_egreso)
  const sac = calcularSac({ historial: args.historial, anio, semestre, fecha_ingreso: args.fecha_ingreso, fecha_egreso: args.fecha_egreso })
  const vac = calcularVacaciones({
    anio, fecha_ingreso: args.fecha_ingreso, unidad_basico: args.unidad_basico, valor_escala: args.valor_escala,
    horas_dia: args.horas_dia, divisor: args.divisor, remuneracion_mensual: args.remuneracion_mensual,
  })
  const inicioAnio = `${anio}-01-01`
  const desde = args.fecha_ingreso && args.fecha_ingreso > inicioAnio ? args.fecha_ingreso : inicioAnio
  const trabajados = diasEntre(desde, args.fecha_egreso)
  const anuales = diasVacacionesPorAntiguedad(vac.antiguedad_anios)
  const gozados = Math.max(0, num(args.dias_gozados) ?? 0)
  const dias = Math.max(0, r2((anuales * trabajados) / 365 - gozados))
  return {
    fecha_egreso: args.fecha_egreso,
    sac_proporcional: sac,
    vacaciones_no_gozadas: {
      dias_anuales: anuales, dias_trabajados_anio: trabajados, dias_gozados: gozados, dias,
      valor_dia: vac.valor_dia, importe: r2(dias * vac.valor_dia),
    },
    avisos: [...sac.avisos, ...vac.avisos.filter(a => a.codigo !== 'SIN_FECHA_INGRESO' || !sac.avisos.length)],
  }
}

// ── Entradas por defecto (Generar recibos) ──────────────────────────────────

/**
 * Entradas sugeridas para un legajo en una liquidación. UOCRA toma las horas
 * de tarja de la quincena (SOLO sugerencia: el liquidador las corrige); los
 * mensuales, los días del período dentro de ingreso/egreso. El préstamo
 * sugerido es el saldo pendiente del legajo, sin pasar el neto (lo recorta el
 * que llama después de calcular).
 */
export function entradasPorDefecto(args: {
  liquidacion: LiquidacionMotor
  unidad_basico: UnidadBasico
  fecha_ingreso: string | null
  fecha_egreso: string | null
  horas_tarja?: number | null
  saldo_prestamos?: number | null
}): EntradasRecibo {
  const { liquidacion: liq } = args
  const e: EntradasRecibo = {}
  if (liq.tipo === 'quincena' || liq.tipo === 'mensual') {
    if (args.unidad_basico === 'hora') {
      e.horas_normales = r2(num(args.horas_tarja) ?? 0)
      e.asistencia = true
    } else {
      const { desde, hasta } = rangoPeriodo(liq)
      const ini = args.fecha_ingreso && args.fecha_ingreso > desde ? args.fecha_ingreso : desde
      const fin = args.fecha_egreso && args.fecha_egreso < hasta ? args.fecha_egreso : hasta
      const total = liq.tipo === 'quincena' ? 15 : 30
      const parcial = ini !== desde || fin !== hasta
      e.dias_trabajados = parcial ? Math.min(total, dias30(ini, fin)) : total
      e.presentismo = true
    }
  }
  const saldo = num(args.saldo_prestamos)
  if (saldo && saldo > 0) e.prestamos = r2(saldo)
  return e
}
