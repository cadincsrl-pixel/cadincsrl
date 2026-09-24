/**
 * Completar el desglose impositivo de una factura ya cargada (20260924v).
 *
 * Las facturas reales se cargaron antes de «archivo primero»: pagadas y con
 * el desglose vacío. El dueño aprobó (24/09) completarlo para el Libro IVA de
 * compras SIN cambiar la plata:
 *
 *   · POST /facturas/:id/leer-adjunto — corre la misma lectura (QR que mandó
 *     el navegador + IA) sobre el adjunto tipo 'factura' ya guardado y
 *     devuelve la propuesta de desglose y cómo cierra contra la factura.
 *     NO guarda nada: ni la factura ni `pagos_facturas_lecturas`.
 *   · POST /facturas/:id/desglose — RPC `pagos_completar_desglose`: reemplaza
 *     el detalle de IVA/tributos, no gravado, exento y CAE, aunque la factura
 *     esté pagada, siempre que el total dé igual y las percepciones también
 *     (ver la migración 20260924v para la excepción de percepciones en 0).
 */
import { supabase } from '../../lib/supabase.js'
import { PagosHttpError, mapRpcError } from './pagos.errors.js'
import { BUCKET } from './adjuntos.service.js'
import { analizarComprobante } from './lectura.service.js'
import { esPercepcion } from './lectura/arca.js'
import type { AvisoLectura, IvaPropuesto, Propuesta, TributoPropuesto } from './lectura/fusion.js'
import { aCentavos, cuadra, sumaCentavos } from './pagos.util.js'
import { enmascararRespuesta } from './pagos.service.js'
import type { CompletarDesgloseDto, LeerAdjuntoDto } from './pagos.schema.js'

export interface FacturaParaDesglose {
  total: number | string
  percepciones: number | string | null
  tipo_comprobante: string
}

export interface DesgloseDto {
  iva_detalle: IvaPropuesto[]
  tributos: TributoPropuesto[]
  no_gravado: number | null
  exento: number | null
  /** Sólo sin alícuotas (B/C): con alícuotas lo deriva la base. */
  neto: number | null
  cae: string | null
  cae_vto: string | null
  cbte_tipo_arca: number | null
}

export interface CierreDesglose {
  total_papel: number | null
  total_factura: number
  /** El papel dice el mismo total que la factura cargada. */
  total_igual: boolean
  suma_desglose: number
  /** neto + IVA + no gravado + exento + tributos = total de la factura. */
  cuadra_con_total: boolean
  percepciones_papel: number
  percepciones_factura: number
  percepciones_iguales: boolean
  /** Factura A sin alícuotas y sin exento/no gravado: la lectura no trajo el IVA. */
  sin_iva: boolean
}

/**
 * Pasa la propuesta de la lectura a lo que recibe la RPC y mide cómo cierra
 * contra la factura guardada. Puro: lo prueba vitest.
 *
 * `completable` = se puede guardar tal cual sin tocar la plata: total del
 * papel = total cargado, el desglose suma ese total y las percepciones son
 * las mismas que ya tiene la factura (o las dos 0).
 */
export function evaluarDesglose(p: Pick<Propuesta, 'iva' | 'tributos' | 'no_gravado' | 'exento' | 'neto' | 'cae' | 'cae_vto' | 'cbte_tipo_arca' | 'total'>,
                                f: FacturaParaDesglose): { desglose: DesgloseDto; cierre: CierreDesglose; completable: boolean } {
  const iva = (p.iva ?? []).map((x) => ({ alicuota_id: x.alicuota_id, base_imp: aCentavos(x.base_imp), importe: aCentavos(x.importe) }))
  const tributos = (p.tributos ?? []).map((t) => ({ ...t, importe: aCentavos(t.importe) }))
  const ng = p.no_gravado != null ? aCentavos(p.no_gravado) : null
  const ex = p.exento != null ? aCentavos(p.exento) : null
  const percPapel = sumaCentavos(tributos.filter((t) => esPercepcion(t.tipo)).map((t) => t.importe))
  const otros = sumaCentavos(tributos.filter((t) => !esPercepcion(t.tipo)).map((t) => t.importe))
  const ivaTot = sumaCentavos(iva.map((x) => x.importe))
  const total = aCentavos(Number(f.total))
  const neto = iva.length > 0
    ? sumaCentavos(iva.map((x) => x.base_imp))
    : (p.neto != null ? aCentavos(p.neto) : aCentavos(total - (ng ?? 0) - (ex ?? 0) - percPapel - otros))
  const suma = sumaCentavos([neto, ivaTot, ng ?? 0, ex ?? 0, percPapel, otros])
  const percFactura = aCentavos(Number(f.percepciones ?? 0))
  const sinIva = f.tipo_comprobante === 'A' && iva.length === 0 && (ng ?? 0) + (ex ?? 0) === 0

  const cierre: CierreDesglose = {
    total_papel: p.total ?? null,
    total_factura: total,
    total_igual: p.total != null && cuadra(p.total, total),
    suma_desglose: suma,
    cuadra_con_total: cuadra(suma, total),
    percepciones_papel: percPapel,
    percepciones_factura: percFactura,
    percepciones_iguales: Math.round(percPapel * 100) === Math.round(percFactura * 100),
    sin_iva: sinIva,
  }
  return {
    desglose: {
      iva_detalle: iva,
      tributos,
      no_gravado: ng,
      exento: ex,
      neto: iva.length > 0 ? null : neto,
      cae: p.cae ?? null,
      cae_vto: p.cae_vto ?? null,
      cbte_tipo_arca: p.cbte_tipo_arca ?? null,
    },
    cierre,
    completable: cierre.total_igual && cierre.cuadra_con_total && cierre.percepciones_iguales && !cierre.sin_iva,
  }
}

export const desgloseService = {

  /** Lee el adjunto 'factura' ya guardado y propone el desglose. No guarda nada. */
  async leerAdjunto(facturaId: number, dto: LeerAdjuntoDto) {
    const { data: f, error: e0 } = await supabase.from('pagos_facturas')
      .select('id, estado, total, percepciones, tipo_comprobante').eq('id', facturaId).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    if (!f) throw new PagosHttpError(404, 'FACTURA_NO_EXISTE')
    const fac = f as FacturaParaDesglose & { estado: string }
    if (fac.estado === 'anulada') throw new PagosHttpError(409, 'FACTURA_CERRADA')

    let q = supabase.from('pagos_facturas_adjuntos')
      .select('id, storage_path, nombre_archivo, mime_type')
      .eq('factura_id', facturaId).eq('tipo', 'factura').is('deleted_at', null)
    if (dto.adjunto_id) q = q.eq('id', dto.adjunto_id)
    const { data: adjs, error: e1 } = await q.order('created_at', { ascending: false }).limit(1)
    if (e1) throw new PagosHttpError(500, 'DB_ERROR', e1.message)
    const adj = (adjs ?? [])[0] as { id: number; storage_path: string; nombre_archivo: string; mime_type: string } | undefined
    if (!adj) throw new PagosHttpError(404, 'ADJUNTO_FACTURA_NO_EXISTE')

    const dl = await supabase.storage.from(BUCKET).download(adj.storage_path)
    if (dl.error || !dl.data) throw new PagosHttpError(404, 'ARCHIVO_NO_SUBIDO', { storage_path: adj.storage_path })
    const { qr, ia, fusion } = await analizarComprobante(Buffer.from(await dl.data.arrayBuffer()), adj.mime_type, dto.qr_texto ?? null)

    const ev = evaluarDesglose(fusion.propuesta, fac)
    const avisos: AvisoLectura[] = [...fusion.avisos]
    if (!ev.cierre.total_igual) {
      avisos.unshift({ campo: 'total', severidad: 'error', codigo: 'TOTAL_DISTINTO',
        mensaje: ev.cierre.total_papel == null
          ? 'No se pudo leer el total del comprobante.'
          : `El comprobante dice un total de ${ev.cierre.total_papel} y la factura está cargada por ${ev.cierre.total_factura}. El desglose no cambia el total: revisalo a mano.` })
    }
    if (!ev.cierre.percepciones_iguales) {
      avisos.unshift({ campo: 'tributos', severidad: 'advertencia', codigo: 'PERCEPCIONES_DISTINTAS',
        mensaje: `El comprobante trae ${ev.cierre.percepciones_papel} de percepciones y la factura tiene ${ev.cierre.percepciones_factura}. Cambiarlas cambia lo imputado a las obras.` })
    }
    return {
      adjunto_id: adj.id,
      nombre_archivo: adj.nombre_archivo,
      estado: fusion.estado,
      modelo: ia.modelo,
      qr_leido: !!qr,
      ...ev,
      fuente_por_campo: fusion.fuente_por_campo,
      avisos,
    }
  },

  async completar(facturaId: number, dto: CompletarDesgloseDto, userId: string, esAdmin: boolean, verPii: boolean) {
    const { forzar, ...desglose } = dto
    if (forzar && !esAdmin) throw new PagosHttpError(403, 'SIN_PERMISO', { campo: 'forzar' })
    const r = await supabase.rpc('pagos_completar_desglose', {
      p_factura_id: facturaId,
      p_desglose:   desglose,
      p_user_id:    userId,
      p_forzar:     !!forzar,
    })
    if (r.error) throw mapRpcError(r.error)
    const res = r.data as { factura: Record<string, unknown>; percepciones_cambiadas: boolean; imputacion_ajustada: boolean }
    return enmascararRespuesta(res, verPii)
  },
}
