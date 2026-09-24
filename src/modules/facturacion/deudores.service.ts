/**
 * Lecturas de saldos de Ventas: pendientes de un cliente (grilla «Aplicación
 * de comprobantes» y popup de compensación), estado de deudores y estado de
 * cuenta. TODO sale de la fuente única `ventas_saldos_al` (20260924m), vía
 * `ventas_deudores_antiguedad_al` (antigüedad desde la fecha de la factura) y `ventas_estado_cuenta`. Ambiente 'prod' salvo que se
 * pida 'homo'.
 *
 * También el cambio de vencimiento de cobro de una factura
 * (`ventas_cambiar_vencimiento`): no es dato fiscal.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { rpc } from './comun.js'
import { ambienteDe } from './cobros.service.js'
import type { DeudoresQuery, EstadoCuentaQuery } from './facturacion.schema.js'

export interface FilaSaldo {
  origen: 'erp' | 'externo' | 'cobro'
  naturaleza: 'debito' | 'credito'
  factura_id: number | null
  externo_id: number | null
  cobro_id: number | null
  ambiente: string
  cliente_id: number
  cbte_tipo: number | null
  tipo: string
  letra: string | null
  pto_vta: number
  numero: number
  tipo_abrev: string
  numero_fmt: string
  comprobante: string
  fecha: string
  vence_el: string
  total: number
  saldo_inicial: number
  nc_aplicadas: number
  cobrado: number
  compensado: number
  aplicado: number
  saldo: number
  saldo_a_revisar: boolean
  estado: string
  dias_vencido: number
}

export interface Deudor {
  ambiente: string
  cliente_id: number
  cliente_razon_social: string
  cliente_doc_nro: string
  saldo: number
  a_cuenta: number
  nc_disponible: number
  saldo_neto: number
  /** Antigüedad por días desde la FECHA de la factura (24/09: el vencimiento de cobro no se usa). */
  d0_30: number
  d31_60: number
  d61_90: number
  d90_mas: number
  saldo_a_revisar: number
  comprobantes: number
  ultima_cobranza: string | null
  ultima_cobranza_total: number | null
}

const CAMPOS_TOTALES = ['saldo', 'a_cuenta', 'nc_disponible', 'saldo_neto', 'd0_30', 'd31_60', 'd61_90', 'd90_mas', 'saldo_a_revisar'] as const

/** Suma en centavos (los montos son numeric(14,2)). */
const sumar = (xs: number[]) => Math.round(xs.reduce((a, x) => a + Math.round(Number(x) * 100), 0)) / 100

export const deudoresService = {
  /**
   * Débitos con saldo > 0 del cliente (ordenados por fecha: así «Aplicar
   * automático» va del más viejo al más nuevo) y, aparte, sus créditos libres
   * (NC del ERP con parte no absorbida, NC externas y cobros con a cuenta).
   */
  async pendientes(clienteId: number, q: { ambiente?: string; al?: string }, db: SupabaseClient = supabase) {
    const ambiente = ambienteDe(q.ambiente)
    const { data: cli, error: e0 } = await db.from('ventas_clientes')
      .select('id, razon_social, doc_nro, activo, plazo_pago_dias').eq('id', clienteId).maybeSingle()
    if (e0) throw mapRpcError(e0 as PgError)
    if (!cli) throw new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { cliente_id: clienteId })
    const { data, error } = await db.rpc('ventas_saldos_al', { p_al: q.al ?? null, p_cliente_id: clienteId, p_ambiente: ambiente })
      .gt('saldo', 0)
      .order('fecha').order('pto_vta').order('numero')
    if (error) throw mapRpcError(error as PgError)
    const filas = (data ?? []) as FilaSaldo[]
    const debitos = filas.filter((f) => f.naturaleza === 'debito')
    const creditos = filas.filter((f) => f.naturaleza === 'credito').sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))
    return {
      cliente: cli,
      ambiente,
      al: q.al ?? null,
      debitos,
      creditos,
      totales: {
        debitos: sumar(debitos.map((d) => d.saldo)),
        creditos: sumar(creditos.map((c) => c.saldo)),
        a_cuenta: sumar(creditos.filter((c) => c.origen === 'cobro').map((c) => c.saldo)),
        nc_disponible: sumar(creditos.filter((c) => c.origen !== 'cobro').map((c) => c.saldo)),
      },
    }
  },

  /** Estado de deudores por cliente a una fecha de corte, ordenado por saldo neto; antigüedad desde la fecha de la factura. */
  async deudores(q: DeudoresQuery, db: SupabaseClient = supabase) {
    const ambiente = ambienteDe(q.ambiente)
    const { data, error } = await db.rpc('ventas_deudores_antiguedad_al', { p_al: q.al ?? null, p_ambiente: ambiente })
      .order('saldo_neto', { ascending: false }).order('cliente_razon_social')
    if (error) throw mapRpcError(error as PgError)
    let rows = (data ?? []) as Deudor[]
    const t = normTxt(q.q ?? '')
    if (t) rows = rows.filter((r) => normTxt(`${r.cliente_razon_social} ${r.cliente_doc_nro}`).includes(t))
    const totales = Object.fromEntries(CAMPOS_TOTALES.map((k) => [k, sumar(rows.map((r) => Number(r[k] ?? 0)))]))
    return { al: q.al ?? null, ambiente, rows, totales }
  },

  /** Movimientos cronológicos del cliente con saldo corrido (y saldo anterior si hay `desde`). */
  async estadoCuenta(clienteId: number, q: EstadoCuentaQuery, db: SupabaseClient = supabase) {
    const ambiente = ambienteDe(q.ambiente)
    if (q.desde && q.hasta && q.desde > q.hasta) throw new FacturacionHttpError(400, 'DATOS_INVALIDOS', { campo: 'desde', mensaje: 'desde posterior a hasta' })
    const { data: cli, error: e0 } = await db.from('ventas_clientes')
      .select('id, razon_social, doc_tipo, doc_nro, condicion_iva_id, domicilio, provincia, email, plazo_pago_dias, activo')
      .eq('id', clienteId).maybeSingle()
    if (e0) throw mapRpcError(e0 as PgError)
    if (!cli) throw new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { cliente_id: clienteId })
    const args = { p_cliente_id: clienteId, p_desde: q.desde ?? null, p_hasta: q.hasta ?? null, p_ambiente: ambiente }
    let movimientos: Array<Record<string, unknown> & { movimiento: string; debe: number; haber: number; saldo: number }>
    try {
      movimientos = await todasLasFilas((d, h) => db.rpc('ventas_estado_cuenta', args).order('orden').range(d, h))
    } catch (e) {
      throw mapRpcError({ message: e instanceof Error ? e.message : String(e) })
    }
    const anterior = movimientos.find((m) => m.movimiento === 'saldo_anterior')
    const periodo = movimientos.filter((m) => m.movimiento !== 'saldo_anterior')
    const saldoAnterior = anterior ? sumar([Number(anterior.debe)]) - sumar([Number(anterior.haber)]) : 0
    return {
      cliente: cli,
      ambiente,
      desde: q.desde ?? null,
      hasta: q.hasta ?? null,
      saldo_anterior: Math.round(saldoAnterior * 100) / 100,
      movimientos,
      totales: { debe: sumar(periodo.map((m) => m.debe)), haber: sumar(periodo.map((m) => m.haber)) },
      saldo_final: movimientos.length ? Number(movimientos[movimientos.length - 1]!.saldo) : 0,
    }
  },

  /** Vencimiento de cobro de una factura (no fiscal). `null` = volver al automático. */
  async cambiarVencimiento(facturaId: number, venceEl: string | null, userId: string, db: SupabaseClient = supabase) {
    const r = await rpc<unknown>(db, 'ventas_cambiar_vencimiento', { p_factura_id: facturaId, p_vence_el: venceEl, p_user_id: userId })
    console.info(`[facturacion] vencimiento de la factura ${facturaId} → ${venceEl ?? 'automático'} por ${userId}`)
    return r
  },
}
