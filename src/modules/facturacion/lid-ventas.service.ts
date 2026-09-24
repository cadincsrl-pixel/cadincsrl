/**
 * Libro IVA Digital de Ventas del período (RG 4597). Lee:
 *   - lo emitido por el ERP: `ventas_facturas` ambiente 'prod', estado
 *     'autorizada', con su desglose `ventas_factura_alicuotas`;
 *   - lo importado de ARCA «Mis Comprobantes Emitidos»:
 *     `ventas_comprobantes_externos` (sin desglose: la alícuota se deduce).
 * y arma los archivos con las funciones puras de `lid-ventas.ts` (ahí están
 * las fuentes del diseño de registro).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todasLasFilas } from '../../lib/paginar.js'
import { FacturacionHttpError } from './facturacion.errors.js'
import {
  armarLibro, desdeErp, desdeExterno, rangoPeriodo, LidFormatoError,
  type FilaExterno, type FilaFacturaErp, type LibroVentas,
} from './lid-ventas.js'

async function leer(periodo: string, db: SupabaseClient) {
  let rango: { desde: string; hasta: string }
  try { rango = rangoPeriodo(periodo) } catch (e) {
    if (e instanceof LidFormatoError) throw new FacturacionHttpError(400, 'DATOS_INVALIDOS', { campo: 'periodo', mensaje: 'período AAAA-MM' })
    throw e
  }
  const [erp, externos] = await Promise.all([
    todasLasFilas<FilaFacturaErp>((d, h) => db.from('ventas_facturas')
      .select('id, cbte_tipo, pto_vta, numero, fecha_cbte, fch_vto_pago, rec_doc_tipo, rec_doc_nro, rec_razon_social, moneda, cotizacion, imp_neto, imp_iva, imp_trib, imp_op_ex, imp_tot_conc, imp_total, alicuotas:ventas_factura_alicuotas(alicuota_id, base_imp, importe)')
      .eq('ambiente', 'prod').eq('estado', 'autorizada')
      .gte('fecha_cbte', rango.desde).lte('fecha_cbte', rango.hasta)
      .order('id').range(d, h) as unknown as PromiseLike<{ data: FilaFacturaErp[] | null; error: { message: string } | null }>),
    todasLasFilas<FilaExterno>((d, h) => db.from('ventas_comprobantes_externos')
      .select('id, cbte_tipo, pto_vta, numero, fecha, rec_doc_tipo, rec_doc_nro, rec_razon_social, neto, no_gravado, exento, iva, total, moneda, tipo_cambio')
      .gte('fecha', rango.desde).lte('fecha', rango.hasta)
      .order('id').range(d, h) as unknown as PromiseLike<{ data: FilaExterno[] | null; error: { message: string } | null }>),
  ])
  return { erp, externos }
}

export const lidVentasService = {
  async libro(periodo: string, incluirCvlp: boolean, db: SupabaseClient): Promise<LibroVentas> {
    const { erp, externos } = await leer(periodo, db)
    return armarLibro(periodo, erp.map(desdeErp), externos.map(desdeExterno), { incluirCvlp })
  },
}
