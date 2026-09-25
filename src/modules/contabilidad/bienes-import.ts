/**
 * Importador del inventario de bienes de uso (tanda 5, 20260928p): lo PURO.
 * Normaliza encabezados (en cualquier orden, sin tildes), fechas, importes y
 * vida útil, descarta títulos y subtotales, y deja cada fila lista para
 * `cont_importar_bienes`, que resuelve las cuentas (código con puntos, 7
 * dígitos de Finnegans o nombre del rubro), la obra y los duplicados.
 *
 * Los errores de formato que se ven sin la base (fecha ilegible, importe
 * ilegible, vida útil negativa) se marcan acá y hacen fallar la confirmación
 * igual que un error de la RPC.
 */
import { normTxt } from '../../lib/norm-txt.js'
import { parsearCsv } from './plan-import.js'

export type Celda = string | number | boolean | null | undefined

/** Lo que se guarda (y la RPC resuelve). */
export type CampoBien =
  | 'descripcion' | 'cuenta' | 'fecha_alta' | 'valor_origen' | 'vida_util' | 'valor_residual'
  | 'amort_acum_inicial' | 'cuenta_amort' | 'cuenta_gasto' | 'identificador' | 'obra' | 'obs'
/** Solo de control: se leen y se comparan, no se guardan. */
export type CampoControl = 'control_neto' | 'control_amort_ejercicio'
export type UnidadVida = 'anios' | 'meses' | 'tasa'

export interface Encabezado { campo: CampoBien | CampoControl; unidad?: UnidadVida }

const EXACTOS: Record<string, Encabezado> = {
  // descripción
  descripcion: { campo: 'descripcion' }, detalle: { campo: 'descripcion' }, bien: { campo: 'descripcion' }, concepto: { campo: 'descripcion' },
  // cuenta
  cuenta: { campo: 'cuenta' }, rubro: { campo: 'cuenta' }, 'codigo cuenta': { campo: 'cuenta' }, 'cuenta contable': { campo: 'cuenta' },
  'cuenta origen': { campo: 'cuenta' }, 'cuenta origen codigo': { campo: 'cuenta' },
  // fecha de alta
  'fecha alta': { campo: 'fecha_alta' }, 'fecha de alta': { campo: 'fecha_alta' }, 'fecha compra': { campo: 'fecha_alta' },
  'fecha de compra': { campo: 'fecha_alta' }, alta: { campo: 'fecha_alta' }, fecha: { campo: 'fecha_alta' },
  // valor de origen
  'valor origen': { campo: 'valor_origen' }, 'valor de origen': { campo: 'valor_origen' }, 'v o': { campo: 'valor_origen' },
  vo: { campo: 'valor_origen' }, costo: { campo: 'valor_origen' }, importe: { campo: 'valor_origen' },
  // vida útil
  'vida util': { campo: 'vida_util', unidad: 'anios' }, anos: { campo: 'vida_util', unidad: 'anios' },
  anios: { campo: 'vida_util', unidad: 'anios' }, 'vida util anos': { campo: 'vida_util', unidad: 'anios' },
  'vida util anios': { campo: 'vida_util', unidad: 'anios' }, meses: { campo: 'vida_util', unidad: 'meses' },
  'vida util meses': { campo: 'vida_util', unidad: 'meses' }, tasa: { campo: 'vida_util', unidad: 'tasa' },
  // residual
  'valor residual': { campo: 'valor_residual' }, residual: { campo: 'valor_residual' }, 'valor de recupero': { campo: 'valor_residual' },
  // amortización acumulada inicial
  acumulada: { campo: 'amort_acum_inicial' }, 'amort acum inicial': { campo: 'amort_acum_inicial' },
  // cuentas opcionales
  'cuenta amort': { campo: 'cuenta_amort' }, 'cuenta amortizacion acumulada': { campo: 'cuenta_amort' },
  'cuenta amort acum': { campo: 'cuenta_amort' }, 'cuenta amortizacion': { campo: 'cuenta_gasto' }, 'cuenta gasto': { campo: 'cuenta_gasto' },
  // identificador
  identificador: { campo: 'identificador' }, patente: { campo: 'identificador' }, dominio: { campo: 'identificador' },
  serie: { campo: 'identificador' }, 'n serie': { campo: 'identificador' }, 'no serie': { campo: 'identificador' },
  'nro serie': { campo: 'identificador' }, 'numero de serie': { campo: 'identificador' },
  // obra
  obra: { campo: 'obra' }, 'obra cod': { campo: 'obra' }, 'centro de costo': { campo: 'obra' },
  // observaciones
  observaciones: { campo: 'obs' }, obs: { campo: 'obs' },
  // control
  'valor residual contable': { campo: 'control_neto' }, neto: { campo: 'control_neto' }, 'valor neto': { campo: 'control_neto' },
}

/** Encabezado del archivo → campo (o null si no se usa). */
export function campoDeEncabezado(h: string): Encabezado | null {
  const crudo = String(h ?? '')
  const n = normTxt(crudo)
  if (!n) return crudo.includes('%') ? { campo: 'vida_util', unidad: 'tasa' } : null
  const exacto = EXACTOS[n]
  if (exacto) return exacto
  if (n.startsWith('cuenta amort')) return n.includes('acum') ? { campo: 'cuenta_amort' } : { campo: 'cuenta_gasto' }
  if (n.startsWith('cuenta gasto')) return { campo: 'cuenta_gasto' }
  if (n.startsWith('amort') && n.includes('ejercicio')) return { campo: 'control_amort_ejercicio' }
  if (n.startsWith('amort') && n.includes('acum')) return { campo: 'amort_acum_inicial' }
  if (n.startsWith('vida util')) return { campo: 'vida_util', unidad: n.includes('mes') ? 'meses' : 'anios' }
  if (crudo.includes('%') || n.startsWith('tasa')) return { campo: 'vida_util', unidad: 'tasa' }
  if (n.startsWith('fecha de alta') || n.startsWith('fecha alta')) return { campo: 'fecha_alta' }
  if (n.startsWith('valor de origen') || n.startsWith('valor origen')) return { campo: 'valor_origen' }
  if (n.startsWith('valor residual contable')) return { campo: 'control_neto' }
  return null
}

// ── Valores ─────────────────────────────────────────────────────────────────

const vacio = (v: Celda) => v == null || (typeof v === 'string' && v.trim() === '')

/** 1900-01-01 = serial 1 del Excel (con su 29/02/1900 inexistente: base 1899-12-30). */
function fechaDeSerial(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null
  const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

function armarFecha(a: number, m: number, d: number): string | null {
  if (a < 100) a += a < 70 ? 2000 : 1900
  if (m < 1 || m > 12 || d < 1 || d > 31 || a < 1900 || a > 2200) return null
  const s = `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dt = new Date(`${s}T00:00:00Z`)
  return dt.toISOString().startsWith(s) ? s : null
}

/**
 * dd/mm/aaaa (también con - o .), aaaa-mm-dd, serial de Excel y mm/aaaa
 * (→ día 1). `undefined` = vacío; `null` = ilegible.
 */
export function parsearFecha(v: Celda): string | null | undefined {
  if (vacio(v)) return undefined
  if (typeof v === 'number') return fechaDeSerial(v)
  if (typeof v === 'boolean') return null
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/)
  if (m) return armarFecha(+m[1]!, +m[2]!, +m[3]!)
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/)
  if (m) return armarFecha(+m[3]!, +m[2]!, +m[1]!)
  m = s.match(/^(\d{1,2})[/.-](\d{4})$/)
  if (m) return armarFecha(+m[2]!, +m[1]!, 1)
  if (/^\d{1,7}(\.\d+)?$/.test(s)) return fechaDeSerial(Number(s))
  return null
}

/**
 * «$ 1.234.567,89», «1234567.89», «1,234,567.89», número. Con los dos
 * separadores, el último es el decimal; con solo coma, la coma es decimal;
 * con un solo punto seguido de exactamente 3 dígitos, es de miles (formato
 * argentino). `undefined` = vacío; `null` = ilegible.
 */
export function parsearImporte(v: Celda): number | null | undefined {
  if (vacio(v)) return undefined
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
  if (typeof v === 'boolean') return null
  let s = String(v).trim().replace(/\$|ars|\s/gi, '')
  let negativo = false
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { negativo = true; s = s.slice(1) }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null
  const ultPunto = s.lastIndexOf('.'), ultComa = s.lastIndexOf(',')
  if (ultPunto >= 0 && ultComa >= 0) {
    const dec = ultPunto > ultComa ? '.' : ','
    const mil = dec === '.' ? ',' : '.'
    s = s.split(mil).join('').replace(dec, '.')
  } else if (ultComa >= 0) {
    const partes = s.split(',')
    s = partes.length === 2 ? `${partes[0]}.${partes[1]}` : partes.join('')
  } else if (ultPunto >= 0) {
    const partes = s.split('.')
    if (partes.length > 2 || (partes.length === 2 && partes[1]!.length === 3)) s = partes.join('')
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round((negativo ? -n : n) * 100) / 100
}

/**
 * Vida útil en años. «5», «5 años», «60 meses», «20%», o el número con la
 * unidad del encabezado (meses → /12, tasa → 100/tasa). `undefined` = vacío;
 * `null` = ilegible o ≤ 0.
 */
export function parsearVidaUtil(v: Celda, unidad: UnidadVida = 'anios'): number | null | undefined {
  if (vacio(v)) return undefined
  let u = unidad
  let s = typeof v === 'number' ? String(v) : String(v).trim().toLowerCase()
  if (s.includes('%')) { u = 'tasa'; s = s.replace('%', '') }
  else if (/mes/.test(s)) { u = 'meses'; s = s.replace(/mes(es)?/, '') }
  else if (/a[ñn]o|anio/.test(s)) { u = 'anios'; s = s.replace(/a[ñn]os?|anios?/, '') }
  const n = parsearImporte(s.trim())
  if (n == null || n <= 0) return null
  const anios = u === 'meses' ? n / 12 : u === 'tasa' ? 100 / n : n
  return Math.round(anios * 100) / 100
}

// ── Filas ───────────────────────────────────────────────────────────────────

export interface FilaBien {
  descripcion: string | null
  cuenta: string | null
  fecha_alta: string | null
  valor_origen: number | null
  vida_util_anios: number | null
  valor_residual: number
  amort_acum_inicial: number
  cuenta_amort: string | null
  cuenta_gasto: string | null
  identificador: string
  obra: string | null
  obs: string
}

export interface ErrorLocal { codigo: string; campo?: string; detalle?: unknown }

export interface BienNormalizado {
  /** Número de fila de datos del archivo (1 = la primera después del encabezado). */
  indice: number
  fila: FilaBien
  errores: ErrorLocal[]
  avisos: ErrorLocal[]
  /** Control leído del archivo (no se guarda). */
  control: { neto?: number; amort_ejercicio?: number }
}

const texto = (v: Celda) => (vacio(v) ? '' : String(v).trim())

/**
 * Título, subtotal o renglón vacío: una fila sin fecha y sin valor de origen
 * no es un bien. También «TOTAL …» / «SUBTOTAL …» aunque traiga importes.
 */
export function esFilaDeBien(raw: Record<string, Celda>, enc: Map<string, Encabezado>): boolean {
  let fecha: Celda, valor: Celda, desc = ''
  for (const [k, v] of Object.entries(raw ?? {})) {
    const e = enc.get(k)
    if (!e) continue
    if (e.campo === 'fecha_alta') fecha = v
    else if (e.campo === 'valor_origen') valor = v
    else if (e.campo === 'descripcion') desc = texto(v)
  }
  if (/^(sub)?total(es)?\b/.test(normTxt(desc))) return false
  return !(vacio(fecha) && vacio(valor))
}

/** Encabezados del conjunto de filas → campo. */
export function mapaDeEncabezados(filas: Record<string, Celda>[]): Map<string, Encabezado> {
  const out = new Map<string, Encabezado>()
  for (const f of filas) for (const k of Object.keys(f ?? {})) {
    if (out.has(k)) continue
    const e = campoDeEncabezado(k)
    if (e) out.set(k, e)
  }
  return out
}

/** Una fila cruda → fila para la RPC + errores/avisos locales. */
export function normalizarBien(raw: Record<string, Celda>, indice: number, enc: Map<string, Encabezado>): BienNormalizado {
  const val: Partial<Record<CampoBien | CampoControl, Celda>> = {}
  let unidad: UnidadVida = 'anios'
  for (const [k, v] of Object.entries(raw ?? {})) {
    const e = enc.get(k)
    if (!e) continue
    // Si dos columnas van al mismo campo, gana la primera con dato.
    if (!vacio(val[e.campo]) || vacio(v)) continue
    val[e.campo] = v
    if (e.campo === 'vida_util' && e.unidad) unidad = e.unidad
  }
  const errores: ErrorLocal[] = []
  const avisos: ErrorLocal[] = []

  const descripcion = texto(val.descripcion) || null
  if (!descripcion || descripcion.length < 3) errores.push({ codigo: 'DESCRIPCION_REQUERIDA', campo: 'descripcion' })
  const cuenta = texto(val.cuenta) || null
  if (!cuenta) errores.push({ codigo: 'BU_CUENTA_INVALIDA', campo: 'cuenta', detalle: { motivo: 'vacia' } })

  const fecha = parsearFecha(val.fecha_alta)
  if (fecha === undefined) errores.push({ codigo: 'FECHA_REQUERIDA', campo: 'fecha_alta' })
  else if (fecha === null) errores.push({ codigo: 'FECHA_INVALIDA', campo: 'fecha_alta', detalle: { valor: texto(val.fecha_alta) } })

  const vo = parsearImporte(val.valor_origen)
  if (vo == null || vo <= 0) errores.push({ codigo: 'IMPORTE_INVALIDO', campo: 'valor_origen', detalle: { valor: texto(val.valor_origen) } })

  const vida = parsearVidaUtil(val.vida_util, unidad)
  if (vida === null) errores.push({ codigo: 'VIDA_UTIL_INVALIDA', campo: 'vida_util_anios', detalle: { valor: texto(val.vida_util) } })

  const residual = parsearImporte(val.valor_residual)
  if (residual === null || (residual != null && residual < 0)) errores.push({ codigo: 'BU_RESIDUAL_INVALIDO', campo: 'valor_residual', detalle: { valor: texto(val.valor_residual) } })
  const inicial = parsearImporte(val.amort_acum_inicial)
  if (inicial === null || (inicial != null && inicial < 0)) errores.push({ codigo: 'BU_INICIAL_INVALIDA', campo: 'amort_acum_inicial', detalle: { valor: texto(val.amort_acum_inicial) } })

  const r = residual ?? 0, ini = inicial ?? 0
  if (vo != null && vo > 0) {
    if (r >= vo) errores.push({ codigo: 'BU_RESIDUAL_INVALIDO', campo: 'valor_residual' })
    else if (ini > vo - r + 0.001) errores.push({ codigo: 'BU_INICIAL_INVALIDA', campo: 'amort_acum_inicial', detalle: { maximo: Math.round((vo - r) * 100) / 100 } })
  }

  const control: BienNormalizado['control'] = {}
  const neto = parsearImporte(val.control_neto)
  if (typeof neto === 'number') {
    control.neto = neto
    if (vo != null && vo > 0 && Math.abs(vo - ini - neto) > 1) {
      avisos.push({ codigo: 'NETO_NO_COINCIDE', campo: 'amort_acum_inicial', detalle: { archivo: neto, calculado: Math.round((vo - ini) * 100) / 100 } })
    }
  }
  const amortEj = parsearImporte(val.control_amort_ejercicio)
  if (typeof amortEj === 'number') control.amort_ejercicio = amortEj

  return {
    indice,
    fila: {
      descripcion, cuenta, fecha_alta: fecha ?? null, valor_origen: vo ?? null,
      vida_util_anios: vida ?? null, valor_residual: r > 0 ? r : 0, amort_acum_inicial: ini > 0 ? ini : 0,
      cuenta_amort: texto(val.cuenta_amort) || null, cuenta_gasto: texto(val.cuenta_gasto) || null,
      identificador: texto(val.identificador), obra: texto(val.obra) || null, obs: texto(val.obs),
    },
    errores, avisos, control,
  }
}

/**
 * Filas del Excel (ya como objetos) o CSV → bienes normalizados. Los títulos,
 * subtotales y renglones vacíos no cuentan; el índice es la fila de datos del
 * archivo, para que la vista previa apunte al renglón que el usuario ve.
 */
export function bienesDeEntrada(entrada: { filas?: Record<string, Celda>[]; csv?: string }): { bienes: BienNormalizado[]; ignoradas: number; columnas: Record<string, string> } {
  const crudas: Record<string, Celda>[] = entrada.filas && entrada.filas.length > 0 ? entrada.filas : parsearCsv(entrada.csv ?? '')
  const enc = mapaDeEncabezados(crudas)
  const bienes: BienNormalizado[] = []
  let ignoradas = 0
  crudas.forEach((raw, i) => {
    if (!esFilaDeBien(raw, enc)) { ignoradas++; return }
    bienes.push(normalizarBien(raw, i + 1, enc))
  })
  const columnas: Record<string, string> = {}
  for (const [k, e] of enc) columnas[k] = e.campo
  return { bienes, ignoradas, columnas }
}

// ── Vista previa ────────────────────────────────────────────────────────────

export interface FilaImportRpc {
  indice: number
  estado?: 'ok' | 'error' | 'aviso'
  errores?: ErrorLocal[]
  avisos?: ErrorLocal[]
  resuelto?: Record<string, unknown>
}

export interface FilaVistaPrevia {
  indice: number
  estado: 'ok' | 'error' | 'aviso'
  errores: ErrorLocal[]
  avisos: ErrorLocal[]
  resuelto: Record<string, unknown>
}

export interface ResumenImport {
  total: number; ok: number; con_error: number; con_aviso: number
  valor_origen: number; amort_acum_inicial: number; ignoradas: number
}

/**
 * Junta lo local con lo que devolvió la RPC. Los índices de la RPC cuentan
 * lo ENVIADO (1..n); se vuelven al renglón del archivo. `filasRpc` puede
 * estar vacío (la RPC no se llamó o frenó): quedan solo los locales.
 */
export function armarVistaPreviaBienes(bienes: BienNormalizado[], filasRpc: FilaImportRpc[], ignoradas = 0): { filas: FilaVistaPrevia[]; resumen: ResumenImport } {
  const porIndice = new Map<number, FilaImportRpc>()
  for (const f of filasRpc ?? []) if (f && typeof f.indice === 'number') porIndice.set(f.indice, f)
  const filas = bienes.map((b, i) => {
    const r = porIndice.get(i + 1)
    const errores = [...b.errores, ...(r?.errores ?? []).filter((e) => !b.errores.some((l) => l.codigo === e.codigo && l.campo === e.campo))]
    const avisos = [...b.avisos, ...(r?.avisos ?? [])]
    const resuelto: Record<string, unknown> = { ...b.fila, ...(r?.resuelto ?? {}) }
    if (b.control.amort_ejercicio != null) resuelto.amort_ejercicio_archivo = b.control.amort_ejercicio
    const estado: FilaVistaPrevia['estado'] = errores.length > 0 ? 'error' : avisos.length > 0 ? 'aviso' : 'ok'
    return { indice: b.indice, estado, errores, avisos, resuelto }
  })
  const suma = (k: 'valor_origen' | 'amort_acum_inicial') =>
    Math.round(filas.filter((f) => f.estado !== 'error').reduce((s, f) => s + Number(f.resuelto[k] ?? 0), 0) * 100) / 100
  return {
    filas,
    resumen: {
      total: filas.length,
      ok: filas.filter((f) => f.estado === 'ok').length,
      con_error: filas.filter((f) => f.estado === 'error').length,
      con_aviso: filas.filter((f) => f.estado === 'aviso').length,
      valor_origen: suma('valor_origen'),
      amort_acum_inicial: suma('amort_acum_inicial'),
      ignoradas,
    },
  }
}
