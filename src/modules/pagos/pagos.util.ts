/**
 * Normalizadores y validadores del módulo Pagos (diseño v3 §4.8).
 *
 * Son funciones puras, sin acceso a la base: las prueba vitest y el build las
 * corre. Cada una tiene su espejo en la base (`cbu_valido()`, `hoy_ar()`,
 * los CHECK de formato de `pagos_proveedores`); si cambia acá, cambia allá.
 */

/**
 * Hoy en Argentina (UTC-3 fijo, sin DST). Después de las 21:00 AR el "hoy"
 * UTC ya es mañana: `toISOString()` pelado dejaría pasar fechas futuras.
 * Copia de la privada de gastos.service.ts (no se importa: es privada).
 */
export function hoyAR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Fecha (YYYY-MM-DD) en Argentina de un timestamp ISO de la base. */
export function fechaARDe(iso: string): string {
  return new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * Número de factura comparable. Extrae TODOS los grupos de dígitos ignorando
 * letras, espacios y símbolos: 'FC A 0025-00024789', 'Nº 25-24789',
 * '0025 00024305' y '002500024305' son '25-24789' / '25-24305'.
 *
 *   - varios grupos → punto de venta = los anteriores al último, número = el último
 *   - un solo grupo → número = últimos 8 dígitos, punto de venta = lo anterior
 *   - sin dígitos → lower(trim) con espacios colapsados
 *   - vacío o null → null (una factura sin número es válida)
 */
export function normNumeroFactura(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.trim()
  if (!t) return null
  const grupos = t.match(/\d+/g)
  if (!grupos) return t.toLowerCase().replace(/\s+/g, ' ')
  let pvRaw: string
  let numRaw: string
  if (grupos.length >= 2) {
    numRaw = grupos[grupos.length - 1] ?? ''
    pvRaw = grupos.slice(0, -1).join('')
  } else {
    const d = grupos[0] ?? ''
    numRaw = d.slice(-8)
    pvRaw = d.slice(0, -8)
  }
  const num = numRaw.replace(/^0+/, '') || '0'
  const pv = pvRaw.replace(/^0+/, '')
  return pv ? `${pv}-${num}` : num
}

/** Solo dígitos: '30-57742861-8' → '30577428618'. Vacío → null. */
export function normCuit(s: string | null | undefined): string | null {
  if (s == null) return null
  const d = s.replace(/\D+/g, '')
  return d ? d : null
}

/** 11 dígitos y dígito verificador (pesos 5,4,3,2,7,6,5,4,3,2; 11 − suma mod 11; 11 → 0; 10 → inválido). */
export function cuitValido(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let suma = 0
  for (let i = 0; i < 10; i++) suma += Number(cuit[i]) * (pesos[i] ?? 0)
  let ver = 11 - (suma % 11)
  if (ver === 11) ver = 0
  if (ver === 10) return false
  return ver === Number(cuit[10])
}

/**
 * CBU: 22 dígitos con los DOS verificadores. Bloque 1 = 7 dígitos + verificador
 * (pesos 7,1,3,9,7,1,3); bloque 2 = 13 dígitos + verificador (pesos
 * 3,9,7,1,3,9,7,1,3,9,7,1,3); verificador = (10 − suma mod 10) mod 10.
 * Espejo de `cbu_valido()` de la base.
 */
export function cbuValido(cbu: string | null | undefined): boolean {
  if (!cbu || !/^\d{22}$/.test(cbu)) return false
  const w1 = [7, 1, 3, 9, 7, 1, 3]
  const w2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]
  let s = 0
  for (let i = 0; i < 7; i++) s += Number(cbu[i]) * (w1[i] ?? 0)
  if ((10 - (s % 10)) % 10 !== Number(cbu[7])) return false
  s = 0
  for (let i = 0; i < 13; i++) s += Number(cbu[8 + i]) * (w2[i] ?? 0)
  return (10 - (s % 10)) % 10 === Number(cbu[21])
}

/** Solo dígitos del CBU tipeado ('0170 099 2…' → '0170099…'). Vacío → null. */
export function normCbu(s: string | null | undefined): string | null {
  if (s == null) return null
  const d = s.replace(/\D+/g, '')
  return d ? d : null
}

/** Alias en minúsculas: `JUAN.PEREZ` y `juan.perez` son la misma cuenta. Vacío → null. */
export function normAlias(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.trim().toLowerCase()
  return t ? t : null
}

export const ALIAS_RE = /^[a-z0-9.-]{6,20}$/
export function aliasValido(alias: string): boolean {
  return ALIAS_RE.test(alias)
}

/**
 * CBU y alias son PII del módulo: sin `ver_pii` se ven como `***1234`. El
 * frontend nunca decide qué enmascarar; lo hace esta función en cada GET.
 */
export function enmascarar(v: string | null | undefined, verPii: boolean): string | null {
  if (v == null || v === '') return null
  if (verPii) return v
  return '***' + v.slice(-4)
}

/**
 * Enmascara CBU/alias adentro de un texto libre (el `detalle` de audit_log:
 * 'cbu: 0170… → 0170…'). Un número de 22 dígitos se reemplaza por `***` +
 * últimos 4; el valor de `alias_cbu` se reemplaza entero.
 */
export function enmascararTexto(t: string, verPii: boolean): string {
  if (verPii) return t
  return t
    .replace(/\d{22}/g, (m) => '***' + m.slice(-4))
    .replace(/alias_cbu: ([^·]*)/g, (_m, resto: string) =>
      'alias_cbu: ' + resto.split('→').map((p) => {
        const v = p.trim()
        return v === '' || v === '∅' || v === 'null' ? v : '***' + v.slice(-4)
      }).join(' → '))
}

/** Redondeo a centavos: la única tolerancia del módulo es $0,01. */
export function aCentavos(n: number): number {
  return Math.round(n * 100) / 100
}

export function sumaCentavos(ns: number[]): number {
  return aCentavos(ns.reduce((a, b) => a + b, 0))
}

/** |a − b| ≤ 0,01 (numeric(14,2)). */
export function cuadra(a: number, b: number): boolean {
  return Math.abs(aCentavos(a) - aCentavos(b)) <= 0.01 + 1e-9
}

/**
 * Separa de la búsqueda de la bandeja lo que es un número de comprobante
 * completo, para buscarlo EXACTO por `numero_norm` y no como texto: la
 * factura cargada a mano guarda `0005-00025267` y la importada de ARCA
 * `00005-00025267`; las dos normalizan a `5-25267`, pero `busq` solo tiene
 * el número crudo y un substring `5-25267` también pegaría en `25-25267`.
 *
 * Cuenta como número completo (siempre como palabras sueltas):
 *   - punto de venta y número con guion: `5-25267`, `0005-00025267`
 *     (1–5 y 1–8 dígitos; un CUIT con guiones `30-57742861-8` NO: tiene dos);
 *   - punto de venta y número separados por espacio, como en el papel:
 *     `0005 00025267` (4–5 dígitos y 8 dígitos exactos);
 *   - una tira de 12 o 13 dígitos: `000500025267` (un CUIT tiene 11).
 * Todo lo demás (p. ej. `25267` solo) sigue yendo al substring de `busq`.
 */
export function separarNumerosFactura(q: string | null | undefined): { numeros: string[]; resto: string } {
  const tokens = (q ?? '').trim().split(/\s+/).filter(Boolean)
  const numeros: string[] = []
  const resto: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    const sig = tokens[i + 1]
    if (/^\d{1,5}-\d{1,8}$/.test(t) || /^\d{12,13}$/.test(t)) {
      numeros.push(normNumeroFactura(t) as string)
    } else if (/^\d{4,5}$/.test(t) && sig !== undefined && /^\d{8}$/.test(sig)) {
      numeros.push(normNumeroFactura(`${t}-${sig}`) as string)
      i++
    } else {
      resto.push(t)
    }
  }
  return { numeros: [...new Set(numeros)], resto: resto.join(' ') }
}
