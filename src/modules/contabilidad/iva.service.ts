/**
 * Asiento mensual de IVA (tanda 5, 20260928o). Se opera desde la tab
 * Períodos: generar, regenerar y anular piden el flag `contabilizar`.
 *
 * El asiento cancela los saldos del MAYOR del mes (DF, CF, percepciones y
 * retenciones de IVA) contra IVA a pagar / saldo a favor: lo calcula la base
 * (`_cont_iva_calculo`, única fuente). La posición FISCAL, la de los libros
 * (`lidComprasService.posicion`, la misma de la tab Impuestos), se usa como
 * CONTROL: si no coincide, la RPC frena con 409 IVA_DIFIERE_DE_LIBROS salvo
 * `forzar`. La foto fiscal la arma SIEMPRE el server; nunca se acepta la del
 * cliente.
 *
 * Único lugar de Contabilidad que lee los libros de Ventas/Compras, de solo
 * lectura, como la tab Impuestos.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { FacturacionHttpError } from '../facturacion/facturacion.errors.js'
import { lidComprasService } from '../facturacion/lid-compras.service.js'
import type { PosicionIva } from '../facturacion/lid-compras.js'
import { hoyAR } from '../pagos/pagos.util.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { rpc, aCentavos } from './comun.js'
import { periodosService, ejercicioPorDefecto } from './periodos.service.js'

export { ddjjBloqueaCierre } from './periodos.service.js'

/** Tolerancia de la comparación mayor vs libros (la misma de la RPC). */
export const TOLERANCIA_IVA = 0.05

export type IvaEstado = 'sin_generar' | 'al_dia' | 'desactualizado' | 'sin_movimientos'

export interface IvaContable {
  periodo_id: number; desde: string; hasta: string
  debito_fiscal: number; credito_fiscal: number; pagos_a_cuenta: number
  /** ITC computable que entró en el mes (20261001b); sin mapeo de la cuenta, 0. */
  itc_mes?: number
  estado: IvaEstado
  registro: Record<string, unknown> | null
  [k: string]: unknown
}

export interface IvaDiferencia {
  componente: 'debito' | 'credito' | 'pagos_a_cuenta' | 'itc' | 'excluidos'
  contable: number; fiscal: number; diferencia: number
}

export interface IvaPosicion { contable: IvaContable; fiscal: PosicionIva; diferencias: IvaDiferencia[] }

/** `2026-08-01` → `2026-08` (el período de los libros). */
export const periodoDeFecha = (fecha: string) => fecha.slice(0, 7)

/**
 * Mayor vs libros, con la misma regla que `cont_iva_generar`: débito, crédito,
 * pagos a cuenta (percepciones + retenciones de IVA) y pago a cuenta ITC del
 * mes (20261001b) con tolerancia de $0,05, más los comprobantes que quedaron
 * FUERA de algún libro (con ellos la posición fiscal está incompleta). Puro.
 */
export function diferenciasIva(
  contable: Pick<IvaContable, 'debito_fiscal' | 'credito_fiscal' | 'pagos_a_cuenta' | 'itc_mes'>,
  fiscal: Pick<PosicionIva, 'debito_fiscal' | 'credito_fiscal' | 'percepciones_iva' | 'retenciones_iva' | 'excluidos_ventas' | 'excluidos_compras'>
    & Partial<Pick<PosicionIva, 'pago_a_cuenta_itc'>>,
  tolerancia = TOLERANCIA_IVA,
): IvaDiferencia[] {
  const out: IvaDiferencia[] = []
  const par = (componente: IvaDiferencia['componente'], c: number, f: number) => {
    const cc = aCentavos(Number(c ?? 0)), ff = aCentavos(Number(f ?? 0))
    const dif = aCentavos(cc - ff)
    if (Math.abs(dif) > tolerancia + 1e-9) out.push({ componente, contable: cc, fiscal: ff, diferencia: dif })
  }
  par('debito', contable.debito_fiscal, fiscal.debito_fiscal)
  par('credito', contable.credito_fiscal, fiscal.credito_fiscal)
  par('pagos_a_cuenta', contable.pagos_a_cuenta, Number(fiscal.percepciones_iva ?? 0) + Number(fiscal.retenciones_iva ?? 0))
  if (fiscal.pago_a_cuenta_itc !== undefined) par('itc', Number(contable.itc_mes ?? 0), Number(fiscal.pago_a_cuenta_itc ?? 0))
  const excluidos = Number(fiscal.excluidos_ventas ?? 0) + Number(fiscal.excluidos_compras ?? 0)
  if (excluidos > 0) out.push({ componente: 'excluidos', contable: 0, fiscal: excluidos, diferencia: -excluidos })
  return out
}

/** Los errores de los libros (Facturación) salen con el mismo cuerpo que los de Contabilidad. */
function comoContabilidad(e: unknown): unknown {
  if (e instanceof FacturacionHttpError) return new ContabilidadHttpError(e.status, e.code, e.detail, e.extra)
  return e
}

async function periodo(id: number, db: SupabaseClient): Promise<{ id: number; desde: string; hasta: string }> {
  const { data, error } = await db.from('cont_periodos').select('id, desde, hasta').eq('id', id).maybeSingle()
  if (error) throw mapRpcError(error as PgError)
  if (!data) throw new ContabilidadHttpError(404, 'PERIODO_NO_EXISTE', { periodo_id: id })
  return data as { id: number; desde: string; hasta: string }
}

async function fiscalDe(desde: string, db: SupabaseClient): Promise<PosicionIva> {
  try {
    // CVLP incluidas, igual que el default de la tab Impuestos.
    return await lidComprasService.posicion(periodoDeFecha(desde), true, db)
  } catch (e) {
    throw comoContabilidad(e)
  }
}

export const ivaService = {
  /** Columna «IVA» de Períodos: un estado por mes del ejercicio (default: el de hoy). */
  async estados(ejercicioId: number | undefined, db: SupabaseClient = supabase): Promise<unknown[]> {
    let id = ejercicioId
    if (id == null) {
      const ej = ejercicioPorDefecto(await periodosService.ejercicios(db), hoyAR())
      if (!ej) return []
      id = ej.id
    }
    const r = await rpc<unknown[] | null>(db, 'cont_iva_estados', { p_ejercicio_id: id })
    return r ?? []
  },

  /** Lo contable (RPC) + lo fiscal (libros) + sus diferencias. */
  async posicion(periodoId: number, db: SupabaseClient = supabase): Promise<IvaPosicion> {
    const p = await periodo(periodoId, db)
    const [contable, fiscal] = await Promise.all([
      rpc<IvaContable | null>(db, 'cont_iva_posicion', { p_periodo_id: periodoId }),
      fiscalDe(p.desde, db),
    ])
    if (!contable) throw new ContabilidadHttpError(404, 'PERIODO_NO_EXISTE', { periodo_id: periodoId })
    return { contable, fiscal, diferencias: diferenciasIva(contable, fiscal) }
  },

  /**
   * Genera o regenera el asiento. La foto fiscal se recalcula acá y viaja a la
   * RPC, que compara, guarda la foto y frena con IVA_DIFIERE_DE_LIBROS si no
   * se fuerza.
   */
  async generar(periodoId: number, forzar: boolean, userId: string, db: SupabaseClient = supabase): Promise<{ accion: string; posicion: IvaPosicion }> {
    const p = await periodo(periodoId, db)
    const fiscal = await fiscalDe(p.desde, db)
    const r = await rpc<{ accion: string; posicion: IvaContable | null } | null>(db, 'cont_iva_generar', {
      p_periodo_id: periodoId, p_fiscal: fiscal, p_forzar: forzar, p_user_id: userId,
    })
    const accion = r?.accion ?? 'sin_cambios'
    const contable = r?.posicion ?? (await rpc<IvaContable | null>(db, 'cont_iva_posicion', { p_periodo_id: periodoId }))
    if (!contable) throw new ContabilidadHttpError(404, 'PERIODO_NO_EXISTE', { periodo_id: periodoId })
    console.info(`[contabilidad] IVA ${periodoDeFecha(p.desde)}: ${accion}${forzar ? ' (forzado)' : ''} por ${userId}`
      + ` — a pagar ${contable.a_pagar ?? 0}, saldo técnico ${contable.saldo_tecnico ?? 0}, libre ${contable.libre_disponibilidad ?? 0}`)
    return { accion, posicion: { contable, fiscal, diferencias: diferenciasIva(contable, fiscal) } }
  },

  async anular(periodoId: number, motivo: string, userId: string, db: SupabaseClient = supabase): Promise<IvaPosicion> {
    await rpc(db, 'cont_iva_anular', { p_periodo_id: periodoId, p_motivo: motivo.trim(), p_user_id: userId })
    console.info(`[contabilidad] IVA del período #${periodoId} anulado por ${userId}: ${motivo.trim()}`)
    return this.posicion(periodoId, db)
  },
}
