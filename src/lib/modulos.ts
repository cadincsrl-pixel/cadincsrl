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
  'flota',
  'alquiler',
  'aridos',
  'admin',
] as const
// 2026-09-06: `ropa`, `prestamos` y `configuracion` salieron del catálogo.
// Ningún endpoint los exigía (todo va por tarja.*) y en la UI son tabs de
// tarja; como módulos solo desalineaban `modulos[]` con `permisos`.

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

/**
 * `profiles.modulos` se deriva de `permisos`: los módulos con lectura. La
 * pantalla ya no lo manda (era una segunda fuente de verdad que gateaba
 * páginas y el selector mientras el backend leía `permisos`). Espejo de
 * `public.modulos_de_permisos()` en la base.
 */
export function modulosDePermisos(permisos: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(permisos ?? {})
    .filter(([, v]) => !!v && typeof v === 'object' && (v as Record<string, unknown>).lectura === true)
    .map(([k]) => k)
    .sort()
}
