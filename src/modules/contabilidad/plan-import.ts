/**
 * Importación del plan de cuentas: lo PURO (sin base). Normaliza las filas
 * que llegan de un xlsx (el frontend las manda como `filas`) o de un CSV
 * (texto) al formato que espera `cont_importar_plan`:
 * `{ codigo, nombre, rubro, imputable, auxiliar }`, con el rubro en su forma
 * canónica y `imputable` boolean o null.
 *
 * Lo que no se puede interpretar se deja para que la RPC lo marque en su fila
 * (RUBRO_INVALIDO, AUXILIAR_INVALIDO, CODIGO_INVALIDO). La única excepción es
 * `imputable`: la RPC lo recibe como boolean, así que un valor raro se marca
 * acá (IMPUTABLE_INVALIDO) y el service lo mezcla con la vista previa.
 */
import { normTxt } from '../../lib/norm-txt.js'

export type Celda = string | number | boolean | null | undefined

export interface FilaPlan {
  codigo: string | null
  nombre: string | null
  rubro: string | null
  imputable: boolean | null
  auxiliar: string | null
}

export interface FilaNormalizada {
  fila: FilaPlan
  /** Error detectado al normalizar (hoy solo IMPUTABLE_INVALIDO). */
  error: { code: string; detalle: Record<string, unknown> } | null
}

/** Encabezado → campo. Acentos y mayúsculas indistintas. */
const ENCABEZADOS: Record<string, keyof FilaPlan> = {
  codigo: 'codigo', cod: 'codigo', cuenta: 'codigo',
  nombre: 'nombre', denominacion: 'nombre', descripcion: 'nombre',
  rubro: 'rubro', tipo: 'rubro',
  imputable: 'imputable', imp: 'imputable',
  auxiliar: 'auxiliar', aux: 'auxiliar',
}

export function campoDeEncabezado(h: string): keyof FilaPlan | null {
  return ENCABEZADOS[normTxt(String(h ?? ''))] ?? null
}

/**
 * Rubro en su forma canónica. `r+`/`r-` se miran ANTES de normalizar (normTxt
 * se come los signos). Lo que no se reconoce vuelve en minúscula para que la
 * RPC lo marque RUBRO_INVALIDO; vacío → null (se hereda del padre).
 */
export function normRubro(v: Celda): string | null {
  if (v == null) return null
  const crudo = String(v).trim().toLowerCase().replace(/\s+/g, '')
  if (crudo === '') return null
  if (crudo === 'r+') return 'ingreso'
  if (crudo === 'r-') return 'egreso'
  const t = normTxt(String(v))
  switch (t) {
    case 'a': case 'activo': return 'activo'
    case 'p': case 'pasivo': return 'pasivo'
    case 'pn': case 'patrimonio neto': case 'patrimonio': return 'pn'
    case 'ingreso': case 'ingresos': case 'resultado positivo': return 'ingreso'
    case 'egreso': case 'egresos': case 'gasto': case 'gastos': case 'resultado negativo': return 'egreso'
    default: return t || String(v).trim().toLowerCase()
  }
}

/** S/N, si/no, true/false, 1/0 → boolean; vacío → null; otra cosa → undefined (inválido). */
export function normImputable(v: Celda): boolean | null | undefined {
  if (v == null) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined
  const t = normTxt(v)
  if (t === '') return null
  if (['s', 'si', 'true', '1', 'x', 'yes', 'y'].includes(t)) return true
  if (['n', 'no', 'false', '0'].includes(t)) return false
  return undefined
}

/** Auxiliar: vacío → null (la RPC pone 'none'); lo desconocido va crudo para AUXILIAR_INVALIDO. */
export function normAuxiliar(v: Celda): string | null {
  if (v == null) return null
  const t = normTxt(String(v))
  if (t === '') return null
  switch (t) {
    case 'none': case 'ninguno': case 'no': case 'sin': case 'n': return 'none'
    case 'cliente': case 'clientes': return 'cliente'
    case 'proveedor': case 'proveedores': return 'proveedor'
    case 'tesoreria': case 'banco': case 'bancos': return 'tesoreria'
    default: return t
  }
}

const texto = (v: Celda): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Una fila cruda (encabezado → celda) al formato de la RPC. */
export function normalizarFila(raw: Record<string, Celda>): FilaNormalizada {
  const f: Record<keyof FilaPlan, Celda> = { codigo: null, nombre: null, rubro: null, imputable: null, auxiliar: null }
  for (const [k, v] of Object.entries(raw ?? {})) {
    const campo = campoDeEncabezado(k)
    if (campo && f[campo] == null) f[campo] = v
  }
  const imp = normImputable(f.imputable)
  const fila: FilaPlan = {
    codigo: texto(f.codigo)?.replace(/\s+/g, '') ?? null,
    nombre: texto(f.nombre),
    rubro: normRubro(f.rubro),
    imputable: imp === undefined ? null : imp,
    auxiliar: normAuxiliar(f.auxiliar),
  }
  return {
    fila,
    error: imp === undefined ? { code: 'IMPUTABLE_INVALIDO', detalle: { valor: String(f.imputable) } } : null,
  }
}

/** Fila sin nada útil (renglón vacío del Excel) o comentario (`# …`). */
export function esFilaIgnorable(raw: Record<string, Celda>): boolean {
  const valores = Object.values(raw ?? {}).map((v) => (v == null ? '' : String(v).trim()))
  if (valores.every((v) => v === '')) return true
  const primero = valores.find((v) => v !== '') ?? ''
  return primero.startsWith('#')
}

/** Separa una línea de CSV respetando comillas dobles ("a;b" y "" como comilla). */
export function partirLineaCsv(linea: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let enComillas = false
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i]
    if (enComillas) {
      if (ch === '"') {
        if (linea[i + 1] === '"') { cur += '"'; i++ } else enComillas = false
      } else cur += ch
    } else if (ch === '"' && cur.trim() === '') {
      enComillas = true
      cur = ''
    } else if (ch === sep) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** El separador del encabezado: el que más aparece entre `;`, tab y `,` (en ese orden de preferencia). */
export function detectarSeparador(encabezado: string): string {
  const cuenta = (c: string) => encabezado.split(c).length - 1
  const cands: Array<[string, number]> = [[';', cuenta(';')], ['\t', cuenta('\t')], [',', cuenta(',')]]
  const mejor = cands.reduce((a, b) => (b[1] > a[1] ? b : a))
  return mejor[1] > 0 ? mejor[0] : ';'
}

/**
 * CSV → filas crudas (encabezado → celda). Separador `;`, `,` o tab; ignora
 * las líneas vacías y las que empiezan con `#`; saca el BOM.
 */
export function parsearCsv(csv: string): Record<string, string>[] {
  const lineas = csv.replace(/^﻿/, '').split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  const [primera] = lineas
  if (primera === undefined) return []
  const sep = detectarSeparador(primera)
  const enc = partirLineaCsv(primera, sep)
  return lineas.slice(1).map((l) => {
    const celdas = partirLineaCsv(l, sep)
    const fila: Record<string, string> = {}
    enc.forEach((h, i) => { if (h) fila[h] = celdas[i] ?? '' })
    return fila
  })
}

/** De lo que mandó el cliente (filas o csv) a las filas normalizadas, sin las ignorables. */
export function filasDeEntrada(entrada: { filas?: Record<string, Celda>[]; csv?: string }): FilaNormalizada[] {
  const crudas: Record<string, Celda>[] = entrada.filas && entrada.filas.length > 0
    ? entrada.filas
    : parsearCsv(entrada.csv ?? '')
  return crudas.filter((r) => !esFilaIgnorable(r)).map(normalizarFila)
}

/** Una fila de la vista previa de `cont_importar_plan`. */
export interface ImportarFila {
  indice: number; estado: 'nueva' | 'duplicada' | 'error'; error: string | null; detalle: Record<string, unknown> | null
  codigo: string | null; nombre: string | null; rubro: string | null; imputable: boolean | null; auxiliar: string | null
  nivel: number | null; padre_codigo: string | null; cuenta_id: number | null
}

/**
 * Suma los errores detectados al normalizar a las filas de la vista previa.
 * La RPC numera las filas por posición de entrada (`indice`); si una fila ya
 * tenía error de la RPC, se respeta ese.
 */
export function mezclarErroresLocales(
  filas: ImportarFila[],
  locales: Array<{ indice: number; code: string; detalle: Record<string, unknown> }>,
): ImportarFila[] {
  if (locales.length === 0) return filas
  // La RPC puede numerar desde 0 o desde 1: se alinea por posición en el array.
  const base = filas.length > 0 ? Math.min(...filas.map((f) => f.indice)) : 0
  const porIndice = new Map(locales.map((l) => [l.indice + base, l]))
  return filas.map((f) => {
    const l = porIndice.get(f.indice)
    if (!l || f.estado === 'error') return f
    // El imputable que puso la RPC es su default (llegó null): no mostrarlo como si fuera del archivo.
    const imputable = l.code === 'IMPUTABLE_INVALIDO' ? null : f.imputable
    return { ...f, estado: 'error', error: l.code, detalle: l.detalle, imputable }
  })
}
