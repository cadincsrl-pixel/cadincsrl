/**
 * «Cargar liquidación» en Ventas › Cobranzas (20260930k): la liquidación que
 * manda el cliente (Casilda Combustibles: «cuenta de venta y líquido
 * producto») se convierte en UN cobro real.
 *
 * `leer()` NO crea nada: lee el PDF (el texto que sacó el navegador con el
 * lector de Casilda; si no alcanza, el archivo del bucket con la IA), busca
 * el cliente por el CUIT, encuentra los comprobantes (CVLP externos o
 * facturas del ERP), reconoce el concepto de cada deducción, mira si los
 * cheques ya están en otro cobro o en la cartera y controla que todo cierre.
 * La persona revisa (puede corregir la fecha y elegir conceptos) y confirma
 * con el `POST /cobros` de siempre, que lleva `gastos`, `liquidacion_numero`
 * y la liquidación como adjunto `liquidacion`.
 *
 * Cheques: el medio `cheque` del cobro entra solo a la cartera
 * (`cheques_recibidos`, trigger de 20260930f/k). Si el cheque ya estaba (lo
 * cargó Logística desde la misma liquidación) no se duplica: se vincula al
 * medio de Ventas y se completa librador/CUIT.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { descargarAdjuntoPendiente } from './cobros.service.js'
import { gastoConceptosService } from './gasto-conceptos.service.js'
import {
  conceptoDeDeduccion, controlesLiquidacion, destinoDe, nombreCorto, parsearLiquidacionCasilda,
  type AvisoCheque, type AvisoComprobante, type ChequeLiquidado, type ComprobanteLiquidado, type ControlesLiquidacion,
  type DeduccionLiquidada, type DestinoComprobante, type FilaExterno, type FilaFactura, type LiquidacionLeida,
} from './liquidacion.js'
import { leerLiquidacionConIA } from './liquidacion-ia.js'
import type { LeerLiquidacionDto } from './facturacion.schema.js'

export interface PropuestaLiquidacion {
  fuente: 'texto' | 'ia'
  modelo: string | null
  liquidacion: Pick<LiquidacionLeida, 'numero' | 'fecha' | 'emisor_nombre' | 'emisor_cuit' | 'subtotal' | 'neto' | 'avisos'>
  cliente: { id: number; razon_social: string; doc_nro: string | null }
  ya_cargada: { cobro_id: number; numero_fmt: string | null } | null
  comprobantes: Array<ComprobanteLiquidado & { numero_fmt: string; destino: DestinoComprobante | null; imputar: number; avisos: AvisoComprobante[] }>
  gastos: Array<DeduccionLiquidada & { concepto_id: number | null; reconocido_por: string | null }>
  cheques: Array<ChequeLiquidado & { librador: string | null; librador_cuit: string | null; avisos: AvisoCheque[]; cobro_existente_id: number | null }>
  controles: ControlesLiquidacion
  /** Σ cheques + Σ gastos: el total del cobro. */
  total_cobro: number
  total_imputar: number
  obs_sugerida: string
  adjunto: { storage_path: string; nombre_archivo: string; mime: string; size: number; hash: string }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const fmtNro = (pto: number, nro: number) => `${String(pto).padStart(5, '0')}-${String(nro).padStart(8, '0')}`
const numNorm = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '') || '0'

async function q<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p
  if (error) throw mapRpcError(error as PgError)
  return (data ?? []) as T[]
}

export const liquidacionService = {
  async leer(dto: LeerLiquidacionDto, db: SupabaseClient = supabase): Promise<PropuestaLiquidacion> {
    const archivo = await descargarAdjuntoPendiente(dto.storage_path)

    // 1) Leer: texto (Casilda) → si no alcanza, IA sobre el archivo.
    let lectura = dto.texto ? parsearLiquidacionCasilda(dto.texto) : null
    let fuente: PropuestaLiquidacion['fuente'] = 'texto'
    let modelo: string | null = null
    if (!lectura) {
      const ia = await leerLiquidacionConIA(archivo.buf, dto.mime)
      if (!ia.ok) throw new FacturacionHttpError(422, 'LIQUIDACION_ILEGIBLE', { motivo: ia.motivo, texto: !!dto.texto })
      lectura = ia.lectura
      fuente = 'ia'
      modelo = ia.modelo
    }

    // 2) Cliente: por el CUIT de quien liquida; si no, el elegido.
    let cliente: { id: number; razon_social: string; doc_nro: string | null } | null = null
    if (lectura.emisor_cuit) {
      const [c] = await q<{ id: number; razon_social: string; doc_nro: string | null }>(
        db.from('ventas_clientes').select('id, razon_social, doc_nro').eq('doc_nro', lectura.emisor_cuit).eq('activo', true).limit(1))
      cliente = c ?? null
    }
    if (!cliente && dto.cliente_id) {
      const [c] = await q<{ id: number; razon_social: string; doc_nro: string | null }>(
        db.from('ventas_clientes').select('id, razon_social, doc_nro').eq('id', dto.cliente_id).limit(1))
      cliente = c ?? null
    }
    if (!cliente) {
      throw new FacturacionHttpError(422, 'LIQUIDACION_SIN_CLIENTE', { cuit: lectura.emisor_cuit, nombre: lectura.emisor_nombre, numero: lectura.numero })
    }

    // 3) ¿Ya se cargó?
    const [ya] = await q<{ id: number; numero: number }>(
      db.from('ventas_cobros').select('id, numero').eq('ambiente', 'prod').eq('cliente_id', cliente.id)
        .eq('estado', 'vigente').eq('liquidacion_numero', lectura.numero).limit(1))
    let yaCargada: PropuestaLiquidacion['ya_cargada'] = null
    if (ya) {
      const [v] = await q<{ numero_fmt: string | null }>(db.from('v_ventas_cobros').select('numero_fmt').eq('id', ya.id).limit(1))
      yaCargada = { cobro_id: ya.id, numero_fmt: v?.numero_fmt ?? null }
    }

    // 4) Comprobantes.
    const numeros = [...new Set(lectura.comprobantes.map((c) => c.numero))]
    const externos = await q<FilaExterno>(db.from('v_ventas_externos')
      .select('id, cbte_tipo, tipo, pto_vta, numero, fecha, total, saldo, comprobante')
      .eq('cliente_id', cliente.id).in('numero', numeros))
    const facturas = await q<FilaFactura>(db.from('v_ventas_facturas')
      .select('id, cbte_tipo, pto_vta, numero, fecha_cbte, imp_total, cobro_saldo, numero_fmt, tipo_nombre')
      .eq('cliente_id', cliente.id).eq('ambiente', 'prod').eq('estado', 'autorizada').in('numero', numeros))
    const comprobantes = lectura.comprobantes.map((c) => ({ ...c, numero_fmt: fmtNro(c.pto_vta, c.numero), ...destinoDe(c, externos, facturas) }))

    // 5) Gastos: el concepto por nombre o sinónimo.
    const conceptos = await gastoConceptosService.listar(false, db)
    const gastos = lectura.deducciones.map((d) => {
      const m = conceptoDeDeduccion(d, conceptos)
      return { ...d, concepto_id: m.concepto_id, reconocido_por: m.por }
    })

    // 6) Cheques: librador (CH/PROP = el cliente), otro cobro, cartera.
    const nums = lectura.cheques.map((c) => c.numero)
    const medios = nums.length
      ? await q<{ cobro_id: number; cheque_numero: string | null; cheque_banco: string | null }>(db.from('ventas_cobro_medios')
          .select('cobro_id, cheque_numero, cheque_banco').in('forma', ['cheque', 'echeq']).in('cheque_numero', nums))
      : []
    const cobrosMed = medios.length
      ? await q<{ id: number; estado: string }>(db.from('ventas_cobros').select('id, estado').in('id', [...new Set(medios.map((m) => m.cobro_id))]))
      : []
    const vigentes = new Set(cobrosMed.filter((c) => c.estado === 'vigente').map((c) => c.id))
    const cartera = nums.length
      ? await q<{ numero_norm: string; importe: number | string }>(db.from('cheques_recibidos')
          .select('numero_norm, importe').in('numero_norm', nums.map(numNorm)))
      : []
    const cheques = lectura.cheques.map((c) => {
      const avisos: AvisoCheque[] = []
      const otro = medios.find((m) => vigentes.has(m.cobro_id) && (m.cheque_numero ?? '').trim().toUpperCase() === c.numero.toUpperCase()
        && (m.cheque_banco ?? '').trim().toUpperCase() === c.banco.toUpperCase())
      if (otro) avisos.push('YA_EN_OTRO_COBRO')
      if (cartera.some((r) => r.numero_norm === numNorm(c.numero) && Math.abs(Number(r.importe) - c.importe) < 0.005)) avisos.push('EN_CARTERA')
      if (!c.fecha_cobro) avisos.push('SIN_FECHA')
      const librador = c.librador ?? (c.propio ? cliente.razon_social : null)
      const librador_cuit = c.librador_cuit ?? (c.propio ? cliente.doc_nro : null)
      if (!librador) avisos.push('LIBRADOR_DESCONOCIDO')
      return { ...c, librador, librador_cuit, avisos, cobro_existente_id: otro?.cobro_id ?? null }
    })

    const controles = controlesLiquidacion(lectura)
    const corto = nombreCorto(cliente.razon_social)
    return {
      fuente, modelo,
      liquidacion: {
        numero: lectura.numero, fecha: lectura.fecha, emisor_nombre: lectura.emisor_nombre, emisor_cuit: lectura.emisor_cuit,
        subtotal: lectura.subtotal, neto: lectura.neto, avisos: lectura.avisos,
      },
      cliente, ya_cargada: yaCargada, comprobantes, gastos, cheques, controles,
      total_cobro: r2(controles.suma_cheques + controles.suma_deducciones),
      total_imputar: r2(comprobantes.reduce((a, c) => a + c.imputar, 0)),
      obs_sugerida: `Liquidación ${corto ? `${corto} ` : ''}N° ${lectura.numero}`,
      adjunto: { storage_path: dto.storage_path.trim(), nombre_archivo: dto.nombre_archivo, mime: dto.mime, size: archivo.size, hash: archivo.hash },
    }
  },
}
