/**
 * Datos del cliente desde el padrón de ARCA (fase 7, 2026-09-23).
 *
 * - `consultar(cuit)`: lo que dice ARCA, listo para precargar el alta del
 *   cliente. NO guarda nada.
 * - `actualizarCliente(id, { todo })`: pisa domicilio y provincia con los de
 *   ARCA; razón social y condición de IVA solo si están vacías o con `todo`.
 *   Guarda lo que vino en `padron_json` / `padron_consultado_at`.
 *
 * La condición de IVA de ARCA es una DEDUCCIÓN (ver `lib/arca/padron.ts`):
 * sin `todo` nunca pisa la cargada, solo la informa en `diferencias`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { ArcaError, consultarPersona, domicilioEnLinea, nombrePropio, type PersonaPadron } from '../../lib/arca/index.js'
import { cuitValido } from '../pagos/pagos.util.js'
import { FacturacionHttpError, errorArca, mapRpcError, type PgError } from './facturacion.errors.js'
import { CONDICIONES_IVA_IDS, letraDe } from './reglas.js'
import { clientesService, type VentasCliente } from './clientes.service.js'

/** Lo que el alta del cliente precarga. */
export interface PrecargaPadron {
  razon_social: string
  domicilio: string
  provincia: string
  condicion_iva_id: number
}

export interface ResultadoPadron {
  cuit: string
  precarga: PrecargaPadron
  padron: PersonaPadron
  consultado_at: string
}

/** Códigos del padrón → error del módulo (status y código que entiende el front). */
const ERRORES_PADRON: Record<string, [number, string]> = {
  ARCA_PADRON_CUIT_INEXISTENTE: [404, 'PADRON_CUIT_INEXISTENTE'],
  ARCA_PADRON_NO_ALCANZADO: [422, 'PADRON_NO_ALCANZADO'],
  ARCA_PADRON_CLAVE_INACTIVA: [422, 'PADRON_CLAVE_INACTIVA'],
  ARCA_PADRON_SIN_DATOS: [422, 'PADRON_SIN_DATOS'],
  ARCA_PADRON_SIN_AUTORIZACION: [503, 'PADRON_SIN_AUTORIZACION'],
  ARCA_PADRON_CUIT_INVALIDO: [400, 'CUIT_INVALIDO'],
}

export function errorPadron(e: unknown, cuit: string): FacturacionHttpError {
  if (e instanceof ArcaError && ERRORES_PADRON[e.codigo]) {
    const [status, code] = ERRORES_PADRON[e.codigo]!
    return new FacturacionHttpError(status, code, {
      campo: 'doc_nro', cuit, mensaje: e.message, ...(e.errores.length ? { errores: e.errores.map((x) => x.msg) } : {}),
    })
  }
  return errorArca(e, { cuit })
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
const sinTildes = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

export function provinciaDePadron(desc: string | null | undefined): string {
  const n = sinTildes(desc ?? '')
  if (!n) return ''
  if (n.includes('ciudad autonoma') || n === 'caba' || n.includes('capital federal')) return 'Capital Federal'
  if (n.startsWith('tierra del fuego')) return 'Tierra del Fuego'
  return PROVINCIAS.find((p) => sinTildes(p) === n) ?? nombrePropio(desc ?? '')
}

/** Domicilio y provincia como los guarda `ventas_clientes`. */
export function domicilioDePadron(p: PersonaPadron): { domicilio: string; provincia: string } {
  return {
    domicilio: domicilioEnLinea(p.domicilio_fiscal),
    provincia: provinciaDePadron(p.domicilio_fiscal?.provincia),
  }
}

export function precargaDe(p: PersonaPadron): PrecargaPadron {
  return {
    razon_social: p.razon_social,
    ...domicilioDePadron(p),
    condicion_iva_id: CONDICIONES_IVA_IDS.has(p.condicion_iva_id) ? p.condicion_iva_id : 5,
  }
}

/** El padrón a guardar en `padron_json`: todo lo resumido, con la fecha. */
export function padronJson(p: PersonaPadron, consultadoAt: string): Record<string, unknown> {
  return { ...p, consultado_at: consultadoAt }
}

/**
 * Qué campos del cliente cambian con el padrón. Domicilio y provincia
 * siempre (si ARCA los trae); razón social y condición de IVA solo si están
 * vacías o con `todo`. La condición no se toca si con ella el cliente se
 * quedaría sin letra (ej. monotributo sin CUIT no pasa, pero acá siempre hay
 * CUIT) — igual se valida.
 */
export function cambiosDesdePadron(
  actual: Record<string, unknown>,
  p: PersonaPadron,
  todo: boolean,
): { upd: Record<string, unknown>; diferencias: Array<{ campo: string; actual: unknown; arca: unknown; aplicado: boolean }> } {
  const pre = precargaDe(p)
  const upd: Record<string, unknown> = {}
  const diferencias: Array<{ campo: string; actual: unknown; arca: unknown; aplicado: boolean }> = []
  const str = (v: unknown) => (v == null ? '' : String(v).trim())

  for (const k of ['domicilio', 'provincia'] as const) {
    if (pre[k] && pre[k] !== str(actual[k])) {
      upd[k] = pre[k]
      diferencias.push({ campo: k, actual: str(actual[k]), arca: pre[k], aplicado: true })
    }
  }
  if (pre.razon_social && pre.razon_social !== str(actual.razon_social)) {
    const aplicar = todo || !str(actual.razon_social)
    if (aplicar) upd.razon_social = pre.razon_social
    diferencias.push({ campo: 'razon_social', actual: str(actual.razon_social), arca: pre.razon_social, aplicado: aplicar })
  }
  const condActual = actual.condicion_iva_id == null ? null : Number(actual.condicion_iva_id)
  if (pre.condicion_iva_id !== condActual) {
    const aplicar = (todo || condActual == null) && !!letraDe(Number(actual.doc_tipo ?? 80), pre.condicion_iva_id)
    if (aplicar) upd.condicion_iva_id = pre.condicion_iva_id
    diferencias.push({ campo: 'condicion_iva_id', actual: condActual, arca: pre.condicion_iva_id, aplicado: aplicar })
  }
  return { upd, diferencias }
}

export const padronService = {
  async consultar(cuitCrudo: string): Promise<ResultadoPadron> {
    const cuit = String(cuitCrudo ?? '').replace(/\D/g, '')
    if (!/^\d{11}$/.test(cuit) || !cuitValido(cuit)) {
      throw new FacturacionHttpError(400, 'CUIT_INVALIDO', { campo: 'doc_nro', cuit })
    }
    let p: PersonaPadron
    try {
      p = await consultarPersona(cuit)
    } catch (e) {
      throw errorPadron(e, cuit)
    }
    return { cuit, precarga: precargaDe(p), padron: p, consultado_at: new Date().toISOString() }
  },

  async actualizarCliente(
    id: number,
    opts: { todo?: boolean },
    userId: string,
    db: SupabaseClient = supabase,
  ): Promise<{ cliente: VentasCliente; diferencias: ReturnType<typeof cambiosDesdePadron>['diferencias']; padron: PersonaPadron }> {
    const actual = await clientesService.detalle(id, db)
    if (Number(actual.doc_tipo) !== 80 && Number(actual.doc_tipo) !== 86) {
      throw new FacturacionHttpError(400, 'PADRON_SOLO_CUIT', { campo: 'doc_tipo', cliente_id: id })
    }
    const r = await this.consultar(String(actual.doc_nro))
    const { upd, diferencias } = cambiosDesdePadron(actual, r.padron, !!opts.todo)
    const { error } = await db.from('ventas_clientes').update({
      ...upd,
      padron_json: padronJson(r.padron, r.consultado_at),
      padron_consultado_at: r.consultado_at,
      updated_by: userId,
    }).eq('id', id)
    if (error) {
      if ((error as PgError).code === '23514') throw new FacturacionHttpError(400, 'CLIENTE_INVALIDO', { dbMessage: error.message })
      throw mapRpcError(error as PgError)
    }
    return { cliente: await clientesService.detalle(id, db), diferencias, padron: r.padron }
  },
}
