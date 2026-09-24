/**
 * Libro IVA Digital de Compras del período (RG 4597) y posición de IVA del mes.
 *
 * Lee las facturas de proveedor del módulo Compras (`pagos_facturas`, no
 * anuladas, por fecha del comprobante) con su desglose (`pagos_factura_iva`,
 * `pagos_factura_tributos`) y arma los archivos con las funciones puras de
 * `lid-compras.ts`. Es el ÚNICO lugar donde Ventas lee datos de Compras
 * (decisión del dueño del 24/09: los impuestos se llevan en el ERP, en la tab
 * «Impuestos», y necesitan los dos libros). No escribe nada de Compras.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todasLasFilas } from '../../lib/paginar.js'
import { FacturacionHttpError } from './facturacion.errors.js'
import { rangoPeriodo, LidFormatoError } from './lid-ventas.js'
import { lidVentasService } from './lid-ventas.service.js'
import {
  armarLibroCompras, desdeFacturaCompra, posicionIva,
  type FilaFacturaCompra, type LibroCompras, type NcSinComprobante, type PosicionIva,
} from './lid-compras.js'

type Resp<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

function rango(periodo: string) {
  try { return rangoPeriodo(periodo) } catch (e) {
    if (e instanceof LidFormatoError) throw new FacturacionHttpError(400, 'DATOS_INVALIDOS', { campo: 'periodo', mensaje: 'período AAAA-MM' })
    throw e
  }
}

interface FilaLineaNc {
  monto: number | string; nc_numero: string | null; nc_fecha: string | null
  orden: { numero: number; estado: string; proveedor: { razon_social: string | null } | null } | null
}

interface FilaRetencion {
  fecha: string | null; importe: number | string
  cobro: { fecha: string; estado: string; ambiente: string } | null
}

export const lidComprasService = {
  async libro(periodo: string, db: SupabaseClient): Promise<LibroCompras> {
    const r = rango(periodo)
    const [facturas, lineasNc] = await Promise.all([
      todasLasFilas<FilaFacturaCompra>((d, h) => db.from('pagos_facturas')
        .select('id, tipo_comprobante, cbte_tipo_arca, numero, fecha, neto, iva, no_gravado, exento, total, estado, paga_cliente, desglose_a_revisar, proveedor:pagos_proveedores(razon_social, cuit), iva_detalle:pagos_factura_iva(alicuota_id, base_imp, importe), tributos:pagos_factura_tributos(tipo, importe)')
        .neq('estado', 'anulada')
        .gte('fecha', r.desde).lte('fecha', r.hasta)
        .order('id').range(d, h) as unknown as Resp<FilaFacturaCompra>),
      todasLasFilas<FilaLineaNc>((d, h) => db.from('pagos_orden_lineas')
        .select('monto, nc_numero, nc_fecha, orden:pagos_ordenes(numero, estado, proveedor:pagos_proveedores(razon_social))')
        .eq('tipo', 'nota_credito')
        .gte('nc_fecha', r.desde).lte('nc_fecha', r.hasta)
        .order('id').range(d, h) as unknown as Resp<FilaLineaNc>),
    ])
    const nc: NcSinComprobante[] = lineasNc
      .filter(l => l.orden && l.orden.estado !== 'anulada')
      .map(l => ({
        orden: `OP-${String(l.orden!.numero).padStart(4, '0')}`,
        proveedor: l.orden!.proveedor?.razon_social ?? '',
        nc_numero: l.nc_numero, nc_fecha: l.nc_fecha, monto: Number(l.monto),
      }))
    return armarLibroCompras(periodo, facturas.map(f => ({ ...desdeFacturaCompra(f), fila: f })), nc)
  },

  /** Retenciones de IVA que le hicieron a CADINC los clientes, en cobros vigentes de prod del mes. */
  async retencionesIva(periodo: string, db: SupabaseClient): Promise<number> {
    const r = rango(periodo)
    const filas = await todasLasFilas<FilaRetencion>((d, h) => db.from('ventas_cobro_retenciones')
      .select('fecha, importe, cobro:ventas_cobros!inner(fecha, estado, ambiente)')
      .eq('tipo', 'iva')
      .eq('cobro.estado', 'vigente').eq('cobro.ambiente', 'prod')
      .order('id').range(d, h) as unknown as Resp<FilaRetencion>)
    // La fecha del certificado manda; sin ella, la del cobro.
    return filas
      .filter(f => f.cobro && f.cobro.estado === 'vigente' && f.cobro.ambiente === 'prod')
      .filter(f => { const fe = f.fecha ?? f.cobro!.fecha; return fe >= r.desde && fe <= r.hasta })
      .reduce((s, f) => s + Number(f.importe), 0)
  },

  async posicion(periodo: string, incluirCvlp: boolean, db: SupabaseClient): Promise<PosicionIva> {
    const [ventas, compras, retenciones] = await Promise.all([
      lidVentasService.libro(periodo, incluirCvlp, db),
      this.libro(periodo, db),
      this.retencionesIva(periodo, db),
    ])
    return posicionIva(periodo, {
      debito: ventas.resumen.iva,
      credito: compras.resumen.credito_fiscal,
      percepciones: compras.resumen.perc_iva,
      retenciones,
      excluidosVentas: ventas.resumen.excluidos,
      excluidosCompras: compras.resumen.excluidos,
      ncEnOrdenes: compras.resumen.nc_en_ordenes,
    })
  },
}
