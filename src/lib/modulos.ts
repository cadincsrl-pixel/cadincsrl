/**
 * Fuente única de verdad del catálogo de módulos del ERP CADINC en el backend.
 *
 * IMPORTANTE: este array tiene que estar sincronizado con su gemelo en el
 * frontend (`src/lib/config/modulos.ts`). Cuando agregás un módulo, tocás
 * los DOS archivos. Es deuda asumida — los repos son separados, no hay
 * monorepo, así que esta es la opción menos mala vs llamadas dinámicas.
 *
 * Excepción documentada: `personal` NO es un módulo asignable, es un tab
 * de `tarja`. No está en este array.
 */
import { z } from 'zod'

export const MODULOS = [
  'tarja',
  'logistica',
  'certificaciones',
  'herramientas',
  'caja',
  'ropa',
  'prestamos',
  'configuracion',
  'flota',
  'alquiler',
  'admin',
] as const

export type Modulo = (typeof MODULOS)[number]

export const ModuloSchema = z.enum(MODULOS)

/**
 * Set helper para chequeo rápido `MODULO_SET.has(x)` sin pagar el costo del
 * enum cada vez. Equivalente al `MODULOS_VALIDOS` que vivía en
 * `lib/obras-usuario.ts` (deprecado).
 */
export const MODULO_SET = new Set<string>(MODULOS)

export function esModuloValido(x: string | null | undefined): x is Modulo {
  return !!x && MODULO_SET.has(x)
}
