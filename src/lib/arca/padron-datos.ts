/**
 * Funciones PURAS sobre lo que devuelve el padrón de ARCA (`padron.ts`),
 * compartidas por Ventas (clientes) y Compras (proveedores). Salieron de
 * `modules/facturacion/padron.service.ts` el 2026-09-25 sin cambiar su
 * comportamiento: ese archivo las re-exporta.
 *
 * Nada de acá guarda ni consulta: toma un `PersonaPadron` y lo deja con la
 * forma en que lo guardan `ventas_clientes` y `pagos_proveedores`.
 */
import { ArcaError } from './errores.js'
import { domicilioEnLinea, nombrePropio, type PersonaPadron } from './padron.js'

/** Lo que precarga el alta de un cliente o de un proveedor. */
export interface PrecargaPadron {
  razon_social: string
  domicilio: string
  provincia: string
  condicion_iva_id: number
}

/**
 * Códigos del padrón → [status HTTP, código del módulo]. Mismos en Ventas y
 * Compras: el frontend traduce los dos con la misma tabla.
 */
export const ERRORES_PADRON: Readonly<Record<string, readonly [number, string]>> = {
  ARCA_PADRON_CUIT_INEXISTENTE: [404, 'PADRON_CUIT_INEXISTENTE'],
  ARCA_PADRON_NO_ALCANZADO: [422, 'PADRON_NO_ALCANZADO'],
  ARCA_PADRON_CLAVE_INACTIVA: [422, 'PADRON_CLAVE_INACTIVA'],
  ARCA_PADRON_SIN_DATOS: [422, 'PADRON_SIN_DATOS'],
  ARCA_PADRON_SIN_AUTORIZACION: [503, 'PADRON_SIN_AUTORIZACION'],
  ARCA_PADRON_CUIT_INVALIDO: [400, 'CUIT_INVALIDO'],
}

/** El [status, código] de un error del padrón, o null si no es uno de esos. */
export function errorDePadron(e: unknown): readonly [number, string] | null {
  return e instanceof ArcaError ? (ERRORES_PADRON[e.codigo] ?? null) : null
}

/**
 * Las provincias como las lista el selector del frontend (`PROVINCIAS` en
 * facturacion.utils.ts): sin tildes y CABA como «Capital Federal». ARCA las
 * manda en mayúsculas y a CABA como «CIUDAD AUTONOMA BUENOS AIRES».
 */
const PROVINCIAS = [
  'Buenos Aires', 'Capital Federal', 'Catamarca', 'Chaco', 'Chubut', 'Cordoba', 'Corrientes', 'Entre Rios',
  'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquen', 'Rio Negro', 'Salta',
  'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucuman',
]
const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

export function provinciaDePadron(desc: string | null | undefined): string {
  const n = sinTildes(desc ?? '')
  if (!n) return ''
  if (n.includes('ciudad autonoma') || n === 'caba' || n.includes('capital federal')) return 'Capital Federal'
  if (n.startsWith('tierra del fuego')) return 'Tierra del Fuego'
  return PROVINCIAS.find((p) => sinTildes(p) === n) ?? nombrePropio(desc ?? '')
}

/** Domicilio y provincia como los guardan `ventas_clientes` y `pagos_proveedores`. */
export function domicilioDePadron(p: PersonaPadron): { domicilio: string; provincia: string } {
  return {
    domicilio: domicilioEnLinea(p.domicilio_fiscal),
    provincia: provinciaDePadron(p.domicilio_fiscal?.provincia),
  }
}

/**
 * La precarga del alta. `idsValidos` = las condiciones de IVA que el módulo
 * acepta; si ARCA sugiere otra, queda consumidor final (5).
 */
export function precargaPadron(p: PersonaPadron, idsValidos: ReadonlySet<number>): PrecargaPadron {
  return {
    razon_social: p.razon_social,
    ...domicilioDePadron(p),
    condicion_iva_id: idsValidos.has(p.condicion_iva_id) ? p.condicion_iva_id : 5,
  }
}

/** El padrón a guardar en `padron_json`: todo lo resumido, con la fecha. */
export function padronJson(p: PersonaPadron, consultadoAt: string): Record<string, unknown> {
  return { ...p, consultado_at: consultadoAt }
}
