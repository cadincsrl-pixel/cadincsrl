/**
 * Marcar pagadas en lote con tarjeta de crédito o billetera (20260927h,
 * pedido del dueño del 24/09): las compras de Mercado Libre y parecidas son
 * facturas de VENDEDORES DISTINTOS ya pagadas en el momento con la tarjeta de
 * la empresa o con saldo de Mercado Pago. `pagos_marcar_pagadas` crea UNA OP
 * POR FACTURA (cada una a su proveedor) por el saldo pagable, todo o nada.
 *
 * Es un HECHO CONSUMADO, como «ya está pagada» al cargar con tarjeta: es la
 * excepción a la doble firma, acotada a tarjeta/billetera. No exige
 * aprobación previa, admite facturas sin imputar y no aplican
 * NO_PUEDE_PAGAR_PROPIA / NO_PUEDE_PAGAR_LO_QUE_APROBO. Lo puede hacer quien
 * carga facturas (`pagos.creacion`) o admin; la RPC lo repite.
 */
import { supabase } from '../../lib/supabase.js'
import { PagosHttpError, errorDeCampo, mapRpcError } from './pagos.errors.js'
import { esAdmin, permisoPagos, type Perfil } from './pagos.service.js'
import { hoyAR } from './pagos.util.js'
import type { MarcarPagadasDto } from './pagos.schema.js'

export interface MarcarPagadasRes {
  ordenes: { factura_id: number; orden_id: number; numero: number }[]
  total: number
}

export const marcarPagadasService = {
  async marcar(dto: MarcarPagadasDto, userId: string, perfil: Perfil | null): Promise<MarcarPagadasRes> {
    if (!esAdmin(perfil) && !permisoPagos(perfil, 'creacion')) {
      throw new PagosHttpError(403, 'SIN_PERMISO', { accion: 'creacion' })
    }
    if (dto.fecha && dto.fecha > hoyAR()) throw errorDeCampo('FECHA_FUTURA', 'fecha', { hoy: hoyAR() })
    const ids = [...new Set(dto.factura_ids)].sort((a, b) => a - b)
    const { data, error } = await supabase.rpc('pagos_marcar_pagadas', {
      p_factura_ids:      ids,
      p_cuenta_origen_id: dto.cuenta_origen_id,
      p_forma:            dto.forma_pago,
      p_fecha:            dto.fecha ?? null,
      p_user_id:          userId,
    })
    if (error) throw mapRpcError(error)
    const r = (data ?? { ordenes: [], total: 0 }) as MarcarPagadasRes
    console.info(`[pagos] ${ids.length} factura(s) marcadas pagadas con ${dto.forma_pago} (cuenta ${dto.cuenta_origen_id}`
      + `${dto.fecha ? `, fecha ${dto.fecha}` : ', fecha de cada factura'}) por ${userId}: ${r.ordenes?.length ?? 0} OP, total ${String(r.total)}`)
    return r
  },
}
