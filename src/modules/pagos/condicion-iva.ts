/**
 * Condición frente al IVA del proveedor vs la letra de su factura (20260925o).
 *
 * Los ids son los de ARCA (`FEParamGetCondicionIvaReceptor`), los mismos que
 * usa Ventas (`CONDICIONES_IVA` en facturacion/reglas.ts) y que acepta el
 * CHECK de `pagos_proveedores.condicion_iva_id`.
 *
 * El aviso NO bloquea: la condición del padrón propio puede estar vieja (el
 * proveedor pasó de monotributo a RI) o mal cargada, y el papel manda. Sirve
 * para que quien carga mire dos veces antes de tomar crédito fiscal de una
 * factura que no debería tenerlo.
 *
 *   monotributista (6, 13 social, 16 promovido) → emite C: A o B es raro
 *   responsable inscripto (1)                   → emite A o B: C es raro
 *   exento (4)                                  → emite B o C: A es raro
 */
import { CONDICIONES_IVA, CONDICIONES_IVA_IDS } from '../facturacion/reglas.js'

export { CONDICIONES_IVA_IDS }

export const CONDICIONES_MONOTRIBUTO = [6, 13, 16] as const
export const CONDICION_RI = 1
export const CONDICION_EXENTO = 4

export interface AvisoLetraCondicion {
  code: 'LETRA_NO_COINCIDE_CONDICION'
  condicion: number
  condicion_nombre: string
  letra: 'A' | 'B' | 'C'
  mensaje: string
}

export function nombreCondicionIva(id: number | null | undefined): string {
  if (id == null) return ''
  return CONDICIONES_IVA.find((c) => c.id === Number(id))?.descripcion ?? `condición ${id}`
}

/**
 * `null` si la letra es coherente con la condición, o si falta alguno de los
 * dos, o si el comprobante no es A/B/C (recibo, ticket, otro).
 */
export function avisoLetraCondicion(condicionIvaId: number | null | undefined, letra: string | null | undefined): AvisoLetraCondicion | null {
  if (condicionIvaId == null || !letra) return null
  const l = String(letra).trim().toUpperCase()
  if (l !== 'A' && l !== 'B' && l !== 'C') return null
  const cond = Number(condicionIvaId)
  let esperado: string | null = null
  if ((CONDICIONES_MONOTRIBUTO as readonly number[]).includes(cond) && (l === 'A' || l === 'B')) esperado = 'un monotributista factura C'
  else if (cond === CONDICION_RI && l === 'C') esperado = 'un responsable inscripto factura A (o B)'
  else if (cond === CONDICION_EXENTO && l === 'A') esperado = 'un exento factura B o C'
  if (!esperado) return null
  const nombre = nombreCondicionIva(cond)
  return {
    code: 'LETRA_NO_COINCIDE_CONDICION',
    condicion: cond,
    condicion_nombre: nombre,
    letra: l,
    mensaje: `El proveedor figura como ${nombre} y el comprobante es ${l}: ${esperado}. Revisá la letra o actualizá la condición del proveedor desde ARCA.`,
  }
}
