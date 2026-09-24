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
  /** Error detectado al normalizar (IMPUTABLE_INVALIDO y los del formato Finnegans). */
  error: { code: string; detalle: Record<string, unknown> } | null
  /** Código tal como vino en el archivo cuando se convirtió (formato Finnegans: 1110101). */
  codigoOriginal?: string | null
  /** `habilitada = NO` en Finnegans: no se importa (se muestra como omitida). */
  omitida?: boolean
  /** El error local manda sobre el de la RPC (la RPC solo vería el código crudo). */
  pisa?: boolean
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
    // Título «RESULTADO DEL PERIODO» del plan de Finnegans (pieza 5): madre de ingresos y gastos.
    case 'resultado': case 'resultados': case 'resultado del periodo': case 'resultado del ejercicio': return 'resultado'
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

// ── Formato Finnegans ────────────────────────────────────────────────────
//
// El contador exporta el plan de Finnegans como
// `codigo;descripcion;nivel;cuenta_madre;imputable;capitulo;saldo_normal;habilitada`
// con códigos de 7 dígitos. El sistema usa códigos con puntos en segmentos
// 1-1-1-2-2: 1110101 → 1.1.1.01.01, 1110100 (nivel 4) → 1.1.1.01,
// 2130310 → 2.1.3.03.10. Rubro: capítulo ACTIVO/PASIVO/PATRIMONIO NETO; en
// RESULTADOS manda el saldo normal (ACREEDOR → ingreso, DEUDOR → egreso,
// vacío → resultado, que solo puede ser título). `habilitada = NO` no se
// importa: la RPC no crea cuentas inactivas y una cuenta deshabilitada en
// Finnegans no tiene por qué nacer en el ERP.

export type FormatoPlan = 'estandar' | 'finnegans'

/** Se reconoce por las columnas `cuenta_madre` y `capitulo`. */
export function esFormatoFinnegans(encabezados: string[]): boolean {
  const n = new Set(encabezados.map((h) => normTxt(String(h ?? ''))))
  return n.has('cuenta madre') && n.has('capitulo')
}

const SEGMENTOS_FINNEGANS: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 5], [5, 7]]

/**
 * 7 dígitos de Finnegans → código con puntos. Con `nivel` (1–5) toma esa
 * cantidad de segmentos y exige que el resto sean ceros; sin nivel corta en
 * el último segmento distinto de cero. Un segmento en cero dentro del nivel
 * o un código que no son 7 dígitos → null (inválido).
 */
export function codigoFinnegans(v: Celda, nivel?: number | null): string | null {
  if (v == null) return null
  const s = String(v).trim().replace(/\s+/g, '').replace(/\.0+$/, '')
  if (!/^[1-9]\d{6}$/.test(s)) return null
  const segs = SEGMENTOS_FINNEGANS.map(([a, b]) => s.slice(a, b))
  let n: number
  if (nivel != null) {
    if (!Number.isInteger(nivel) || nivel < 1 || nivel > 5) return null
    n = nivel
  } else {
    n = 0
    segs.forEach((g, i) => { if (Number(g) !== 0) n = i + 1 })
  }
  if (segs.slice(0, n).some((g) => Number(g) === 0)) return null
  if (segs.slice(n).some((g) => Number(g) !== 0)) return null
  return segs.slice(0, n).join('.')
}

/** Capítulo + saldo normal de Finnegans → rubro canónico (lo desconocido va crudo para RUBRO_INVALIDO). */
export function rubroFinnegans(capitulo: Celda, saldoNormal: Celda): string | null {
  const c = normTxt(String(capitulo ?? ''))
  if (c === '') return null
  if (c === 'activo') return 'activo'
  if (c === 'pasivo') return 'pasivo'
  if (c === 'patrimonio neto' || c === 'patrimonio') return 'pn'
  if (c === 'resultados' || c === 'resultado') {
    const sn = normTxt(String(saldoNormal ?? ''))
    if (sn === '') return 'resultado'
    if (sn === 'acreedor') return 'ingreso'
    if (sn === 'deudor') return 'egreso'
    return sn
  }
  return c
}

/** Valor de la fila por encabezado normalizado (el primero que aparezca de los alias). */
function celda(raw: Record<string, Celda>, ...alias: string[]): Celda {
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (alias.includes(normTxt(String(k ?? '')))) return v
  }
  return null
}

const padreDe = (codigo: string): string | null => (codigo.includes('.') ? codigo.replace(/\.[0-9]+$/, '') : null)

/** Una fila del CSV de Finnegans al formato de la RPC, con sus errores de conversión. */
export function normalizarFilaFinnegans(raw: Record<string, Celda>): FilaNormalizada {
  const codRaw = texto(celda(raw, 'codigo', 'cod'))?.replace(/\s+/g, '') ?? null
  const nivelTxt = texto(celda(raw, 'nivel'))
  const nivel = nivelTxt == null ? null : Number(nivelTxt)
  const madreRaw = texto(celda(raw, 'cuenta madre'))?.replace(/\s+/g, '') ?? null
  const imp = normImputable(celda(raw, 'imputable', 'imp'))
  const hab = normImputable(celda(raw, 'habilitada'))

  const codigo = codigoFinnegans(codRaw, nivelTxt == null ? null : nivel)
  const fila: FilaPlan = {
    codigo: codigo ?? codRaw,
    nombre: texto(celda(raw, 'descripcion', 'nombre', 'denominacion')),
    rubro: rubroFinnegans(celda(raw, 'capitulo'), celda(raw, 'saldo normal')),
    imputable: imp === undefined ? null : imp,
    auxiliar: null,
  }
  const base: FilaNormalizada = { fila, error: null, codigoOriginal: codRaw, omitida: hab === false }
  const err = (code: string, detalle: Record<string, unknown>): FilaNormalizada => ({ ...base, error: { code, detalle }, pisa: true })

  if (codigo == null) return err('CODIGO_FINNEGANS_INVALIDO', { codigo: codRaw, nivel: nivelTxt })
  // La madre convertida tiene que ser la madre del código convertido.
  const esperada = padreDe(codigo)
  const sinMadre = madreRaw == null || /^0+$/.test(madreRaw)
  const madre = sinMadre ? null : codigoFinnegans(madreRaw, codigo.split('.').length - 1)
  if ((sinMadre ? null : madre ?? '') !== esperada) {
    return err('MADRE_NO_COINCIDE', { cuenta_madre: madreRaw, madre_convertida: madre, padre_codigo: esperada })
  }
  if (hab === undefined) return err('HABILITADA_INVALIDA', { valor: String(celda(raw, 'habilitada')) })
  if (imp === undefined) return { ...base, error: { code: 'IMPUTABLE_INVALIDO', detalle: { valor: String(celda(raw, 'imputable', 'imp')) } } }
  return base
}

/** Formato de lo que mandó el cliente, por los encabezados de la primera fila útil. */
export function formatoDeFilas(crudas: Record<string, Celda>[]): FormatoPlan {
  const primera = crudas.find((r) => !esFilaIgnorable(r))
  return primera && esFormatoFinnegans(Object.keys(primera)) ? 'finnegans' : 'estandar'
}

function crudasDeEntrada(entrada: { filas?: Record<string, Celda>[]; csv?: string }): Record<string, Celda>[] {
  return entrada.filas && entrada.filas.length > 0 ? entrada.filas : parsearCsv(entrada.csv ?? '')
}

/** De lo que mandó el cliente (filas o csv) a las filas normalizadas, sin las ignorables. */
export function filasDeEntrada(entrada: { filas?: Record<string, Celda>[]; csv?: string }): FilaNormalizada[] {
  const crudas = crudasDeEntrada(entrada)
  const norm = formatoDeFilas(crudas) === 'finnegans' ? normalizarFilaFinnegans : normalizarFila
  return crudas.filter((r) => !esFilaIgnorable(r)).map(norm)
}

/** Formato de la entrada (para la respuesta de la vista previa). */
export function formatoDeEntrada(entrada: { filas?: Record<string, Celda>[]; csv?: string }): FormatoPlan {
  return formatoDeFilas(crudasDeEntrada(entrada))
}

/** Una fila de la vista previa de `cont_importar_plan`. */
export interface ImportarFila {
  indice: number; estado: 'nueva' | 'duplicada' | 'error' | 'omitida'; error: string | null; detalle: Record<string, unknown> | null
  codigo: string | null; nombre: string | null; rubro: string | null; imputable: boolean | null; auxiliar: string | null
  nivel: number | null; padre_codigo: string | null; cuenta_id: number | null
  /** Código tal como vino en el archivo (formato Finnegans). */
  codigo_original?: string | null
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

/**
 * La vista previa completa a partir de lo que devolvió la RPC, que solo vio
 * las filas NO omitidas:
 *   - el `indice` vuelve a ser la posición en el archivo (1-based, sin
 *     renglones ignorables), también para las omitidas;
 *   - suma los errores locales (los de Finnegans pisan el de la RPC, que solo
 *     vio el código crudo; IMPUTABLE_INVALIDO no pisa, como antes);
 *   - agrega `codigo_original` y las filas omitidas (`habilitada = NO`);
 *   - una hija cuyo padre quedó omitido lleva `motivo: 'padre_deshabilitado'`.
 */
export function armarVistaPrevia(normalizadas: FilaNormalizada[], filasRpc: ImportarFila[]): ImportarFila[] {
  const enviadas: number[] = []
  normalizadas.forEach((n, i) => { if (!n.omitida) enviadas.push(i) })
  const omitidas = new Set(normalizadas.filter((n) => n.omitida && n.fila.codigo).map((n) => n.fila.codigo as string))
  // La RPC numera desde 1 (with ordinality). Fijo, no por el mínimo: la
  // lista de IMPORTACION_CON_ERRORES trae solo las filas con error.
  const base = 1

  const out: ImportarFila[] = filasRpc.map((f) => {
    const pos = enviadas[f.indice - base]
    if (pos === undefined) return f
    const n = normalizadas[pos]!
    let r: ImportarFila = { ...f, indice: pos + 1 }
    if (n.codigoOriginal !== undefined) r.codigo_original = n.codigoOriginal
    if (n.error && (r.estado !== 'error' || n.pisa)) {
      const imputable = n.error.code === 'IMPUTABLE_INVALIDO' ? null : r.imputable
      r = { ...r, estado: 'error', error: n.error.code, detalle: n.error.detalle, imputable }
    } else if (r.estado === 'error' && r.error === 'PADRE_NO_EXISTE' && omitidas.has(String(r.detalle?.padre_codigo ?? ''))) {
      r = { ...r, detalle: { ...(r.detalle ?? {}), motivo: 'padre_deshabilitado' } }
    }
    return r
  })

  normalizadas.forEach((n, i) => {
    if (!n.omitida) return
    const cod = n.fila.codigo
    const valido = !!cod && /^[1-9](\.[0-9]{1,3}){0,5}$/.test(cod)
    out.push({
      indice: i + 1,
      estado: n.error ? 'error' : 'omitida',
      error: n.error ? n.error.code : 'CUENTA_DESHABILITADA',
      detalle: n.error ? n.error.detalle : null,
      codigo: cod, nombre: n.fila.nombre, rubro: n.fila.rubro, imputable: n.fila.imputable, auxiliar: n.fila.auxiliar,
      nivel: valido ? cod!.split('.').length : null, padre_codigo: valido ? padreDe(cod!) : null, cuenta_id: null,
      ...(n.codigoOriginal !== undefined ? { codigo_original: n.codigoOriginal } : {}),
    })
  })
  return out.sort((a, b) => a.indice - b.indice)
}
