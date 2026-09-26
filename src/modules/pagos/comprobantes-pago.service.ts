/**
 * «Soltá acá los comprobantes de pagos» en Compras › Pagos (2026-09-25). Lo
 * que documenta un pago a un proveedor: comprobante de transferencia, de un
 * e-cheq emitido o endosado, foto de un cheque, el RECIBO del proveedor o su
 * resumen de cuenta.
 *
 * `leer()` NO crea nada: lee el archivo ya subido a `ordenes/pendientes/` con
 * la IA (`lectura/comprobante-pago-ia.ts`), sanea la lectura
 * (`documentoPagoDeLectura`, pura), reconoce al proveedor por CUIT o nombre,
 * busca sus facturas (las que nombra el papel y las que siguen con saldo),
 * la cuenta de tesorería de donde salió la plata, y avisa si un cheque o un
 * pago ya están registrados.
 *
 * `reconstruir()` registra un pago QUE YA SE HIZO (la conciliación): OP
 * reconstruida con `pagos_reconstruir_orden` (sin doble firma: la plata ya
 * salió) para facturas marcadas «pago a reconstruir», con los papeles como
 * adjuntos. Es lo que se hacía por SQL en la conciliación del 25/09 (Pizarro,
 * Monteros, Hierronort). Un pago nuevo sigue por «Pagar en lote».
 */
import { supabase } from '../../lib/supabase.js'
import { PagosHttpError, mapRpcError } from './pagos.errors.js'
import { BUCKET, moverPendientesAOrden, procesarPendientes, borrarDelBucket } from './adjuntos.service.js'
import { leerComprobantePagoConIA, type LecturaComprobantePagoIA } from './lectura/comprobante-pago-ia.js'
import { nombreComparable, proveedorDelCheque, type PadronProveedor } from './cheques.service.js'
import { cuitValido } from './pagos.util.js'
import { PREFIJO_COMPROBANTE_PENDIENTE, type LeerComprobantePagoDto, type ReconstruirPagoDto } from './pagos.schema.js'

export type TipoDocumentoPago = 'transferencia' | 'echeq' | 'cheque' | 'recibo' | 'resumen_cuenta' | 'otro'
export type FormaPagoLeida = 'transferencia' | 'echeq' | 'cheque' | 'efectivo' | 'otro'

export interface AvisoPago { severidad: 'error' | 'advertencia' | 'info'; codigo: string; mensaje: string; [k: string]: unknown }

export interface CuentaTesoreria { id: number; nombre: string; banco: string | null; tipo: string }

export interface MedioPagoLeido {
  forma: FormaPagoLeida
  importe: number | null
  numero: string | null
  banco: string | null
  fecha_cobro: string | null
  librador: string | null
  librador_cuit: string | null
  /** false si es un cheque de un tercero endosado; true si es propio; null si no se sabe. */
  es_propio: boolean | null
  cuenta_origen_texto: string | null
  /** A quién se entregó este medio según el papel (un PDF de endosos puede ir a varios). */
  entregado_a: string | null
  entregado_a_cuit: string | null
  /** El proveedor de ESTE medio, si se reconoce (si no, el del documento). */
  proveedor_id: number | null
  avisos: AvisoPago[]
}

export interface ComprobantePagoLeido { tipo: string | null; pto_vta: number; numero: number; numero_fmt: string; importe: number | null }

export interface FacturaDelProveedor {
  id: number
  proveedor_id: number
  numero: string | null
  fecha: string
  total: number
  saldo: number
  estado: string
  pago_a_reconstruir: boolean
  /** La nombra el papel. */
  nombrada: boolean
  /** Lo que el papel dice que se paga de ella (si la nombra). */
  importe_papel: number | null
}

export interface DocumentoPago {
  tipo_documento: TipoDocumentoPago
  fecha: string | null
  proveedor_nombre: string | null
  proveedor_cuit: string | null
  medios: MedioPagoLeido[]
  comprobantes: ComprobantePagoLeido[]
  recibo_numero: string | null
  total: number | null
  avisos: AvisoPago[]
}

export interface LecturaComprobantePago extends DocumentoPago {
  proveedor: { id: number; razon_social: string; por: 'cuit' | 'nombre' } | null
  /** Las del proveedor: primero las que nombra el papel, después las que tienen saldo. */
  facturas: FacturaDelProveedor[]
  /** La cuenta de tesorería de donde salió (transferencia), si se reconoce. */
  cuenta_origen_id: number | null
  modelo: string | null
  storage_path: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const soloDigitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
const numNorm = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '') || '0'
export const fmtNumero = (pto: number, nro: number) => `${String(pto).padStart(5, '0')}-${String(nro).padStart(8, '0')}`

function fechaValida(s: string | null | undefined): string | null {
  const t = (s ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const d = new Date(`${t}T12:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t
}
const txt = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}
const cuitOk = (s: string | null | undefined) => { const d = soloDigitos(s); return d.length === 11 && cuitValido(d) ? d : null }
const importe = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n !== 0 ? r2(Math.abs(n)) : null)

const TIPOS_DOC: readonly TipoDocumentoPago[] = ['transferencia', 'echeq', 'cheque', 'recibo', 'resumen_cuenta', 'otro']

function formaDe(t: string | null, doc: TipoDocumentoPago): FormaPagoLeida {
  const s = (t ?? '').toLowerCase()
  if (/e-?cheq/.test(s)) return 'echeq'
  if (/cheq|valor/.test(s)) return 'cheque'
  if (/transf|dep[oó]s/.test(s)) return 'transferencia'
  if (/efect/.test(s)) return 'efectivo'
  if (doc === 'echeq' || doc === 'cheque' || doc === 'transferencia') return doc
  return 'otro'
}

/** La cuenta de tesorería de CADINC por el texto del papel (banco/nombre). Sólo si hay UNA. */
export function cuentaDeOrigen(texto: string | null, cuentas: readonly CuentaTesoreria[]): number | null {
  const t = nombreComparable(texto ?? '')
  if (t.length < 3) return null
  const bancos = cuentas.filter((c) => c.tipo === 'banco')
  const dig = soloDigitos(texto)
  if (dig.length >= 3) {
    const porNumero = bancos.filter((c) => { const d = soloDigitos(c.nombre); return d.length >= 3 && dig.includes(d) })
    if (porNumero.length === 1) return porNumero[0]!.id
  }
  const porBanco = bancos.filter((c) => {
    const b = nombreComparable(`${c.banco ?? ''} ${c.nombre}`).replace(/\bbanco\b/g, '').replace(/\b(c\/?c|usd|ca)\b.*$/, '').trim().split(' ')[0] ?? ''
    return b.length >= 4 && t.includes(b)
  })
  const pesos = porBanco.filter((c) => !/usd/i.test(c.nombre))
  return pesos.length === 1 ? pesos[0]!.id : null
}

/**
 * El proveedor por la primera palabra del nombre, cuando el papel usa el
 * nombre de fantasía («PIZARRO CLIMATIZACION» es «Pizarro Refrigeración
 * S.R.L.»). Sólo si la palabra tiene 5+ letras y hay UN proveedor que empieza
 * así. Pura.
 */
export function proveedorPorPrimeraPalabra(nombre: string | null, padron: readonly PadronProveedor[]): { id: number; razon_social: string; por: 'nombre' } | null {
  const palabra = nombreComparable(nombre ?? '').split(' ')[0] ?? ''
  if (palabra.length < 5) return null
  const cands = padron.filter((p) => { const n = nombreComparable(p.razon_social); return n === palabra || n.startsWith(`${palabra} `) })
  return cands.length === 1 ? { id: cands[0]!.id, razon_social: cands[0]!.razon_social, por: 'nombre' } : null
}

/** La lectura de la IA → documento saneado + avisos. Pura, para testear. */
export function documentoPagoDeLectura(l: LecturaComprobantePagoIA): DocumentoPago {
  const avisos: AvisoPago[] = []
  const td = (l.tipo_documento ?? '').toLowerCase() as TipoDocumentoPago
  const tipo_documento = TIPOS_DOC.includes(td) ? td : 'otro'
  const medios: MedioPagoLeido[] = l.medios.flatMap((m) => {
    const imp = importe(m.importe)
    if (imp == null && !m.numero) return []
    const forma = formaDe(m.forma, tipo_documento)
    const esCheque = forma === 'cheque' || forma === 'echeq'
    const av: AvisoPago[] = []
    if (imp == null) av.push({ severidad: 'advertencia', codigo: 'IMPORTE_NO_LEIDO', mensaje: 'No se pudo leer el importe: cargalo a mano.' })
    const numero = esCheque ? (soloDigitos(m.numero).slice(0, 40) || null) : txt(m.numero, 60)
    if (esCheque && !numero) av.push({ severidad: 'advertencia', codigo: 'NUMERO_NO_LEIDO', mensaje: 'No se pudo leer el número del cheque: cargalo a mano.' })
    return [{
      forma, importe: imp, numero, banco: txt(m.banco, 80), fecha_cobro: fechaValida(m.fecha_cobro),
      librador: esCheque ? txt(m.librador, 120) : null, librador_cuit: esCheque ? cuitOk(m.librador_cuit) : null,
      es_propio: esCheque ? (m.es_endoso === true ? false : m.es_endoso === false ? true : null) : null,
      cuenta_origen_texto: forma === 'transferencia' ? txt(m.cuenta_origen ?? m.banco, 120) : null,
      entregado_a: txt(m.entregado_a, 160), entregado_a_cuit: cuitOk(m.entregado_a_cuit), proveedor_id: null,
      avisos: av,
    }]
  })
  const comprobantes: ComprobantePagoLeido[] = l.comprobantes.flatMap((c) =>
    c.pto_vta != null && c.numero != null && c.pto_vta > 0 && c.numero > 0
      ? [{ tipo: txt(c.tipo, 20), pto_vta: Math.trunc(c.pto_vta), numero: Math.trunc(c.numero), numero_fmt: fmtNumero(Math.trunc(c.pto_vta), Math.trunc(c.numero)), importe: importe(c.importe) }]
      : [])
  const total = importe(l.total)
  const suma = r2(medios.reduce((s, m) => s + (m.importe ?? 0), 0))
  if (total != null && medios.length > 0 && Math.abs(suma - total) > 0.01 && tipo_documento !== 'resumen_cuenta') {
    avisos.push({ severidad: 'advertencia', codigo: 'TOTAL_NO_CIERRA', mensaje: `Los medios leídos suman ${suma.toFixed(2)} y el documento dice ${total.toFixed(2)}: revisalo contra el papel.` })
  }
  if (tipo_documento === 'resumen_cuenta') {
    avisos.push({ severidad: 'info', codigo: 'ES_RESUMEN', mensaje: 'Es un resumen de cuenta: sirve de respaldo. Las facturas que muestra abiertas no se pagan con él.' })
  }
  if (l.notas?.trim()) avisos.push({ severidad: 'info', codigo: 'NOTA_LECTURA', mensaje: l.notas.trim().slice(0, 300) })
  return {
    tipo_documento, fecha: fechaValida(l.fecha), proveedor_nombre: txt(l.proveedor_nombre, 160), proveedor_cuit: cuitOk(l.proveedor_cuit),
    medios, comprobantes, recibo_numero: txt(l.recibo_numero, 40), total, avisos,
  }
}

function validarPathPendiente(path: string) {
  if (!path.startsWith(PREFIJO_COMPROBANTE_PENDIENTE) || path.includes('..')) {
    throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: path })
  }
}

async function q<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p
  if (error) throw mapRpcError(error as { message?: string })
  return (data ?? []) as T[]
}

export const comprobantesPagoService = {
  async leer(dto: LeerComprobantePagoDto): Promise<LecturaComprobantePago> {
    validarPathPendiente(dto.storage_path)
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) throw new PagosHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: dto.storage_path })
    const ia = await leerComprobantePagoConIA(Buffer.from(await dl.data.arrayBuffer()), dto.mime_type)
    if (!ia.ok || !ia.lectura.legible) {
      throw new PagosHttpError(422, 'COMPROBANTE_ILEGIBLE', { storage_path: dto.storage_path, motivo: ia.ok ? (ia.lectura.notas ?? 'NO_LEGIBLE') : ia.motivo })
    }
    const doc = documentoPagoDeLectura(ia.lectura)

    // Proveedor: por el CUIT o el nombre de quien cobra.
    const padron = await q<PadronProveedor>(supabase.from('pagos_proveedores').select('id, razon_social, cuit').eq('activo', true))
    const proveedor = proveedorDelCheque({ entregado_a: doc.proveedor_nombre, entregado_a_cuit: doc.proveedor_cuit }, padron)
      ?? proveedorPorPrimeraPalabra(doc.proveedor_nombre, padron)
    // Cada medio con su proveedor: un PDF del banco con endosos a varios.
    for (const m of doc.medios) {
      const p = m.entregado_a || m.entregado_a_cuit ? proveedorDelCheque({ entregado_a: m.entregado_a, entregado_a_cuit: m.entregado_a_cuit }, padron) : null
      m.proveedor_id = p?.id ?? proveedor?.id ?? null
    }
    const provIds = [...new Set([proveedor?.id, ...doc.medios.map((m) => m.proveedor_id)].filter((x): x is number => x != null))]

    // Sus facturas: las que nombra el papel y las que tienen saldo.
    let facturas: FacturaDelProveedor[] = []
    if (provIds.length) {
      const filas = await q<{ id: number; proveedor_id: number; numero: string | null; fecha: string; total: number | string; saldo: number | string; estado: string; pago_a_reconstruir: boolean | null; clase: string }>(
        supabase.from('v_pagos_facturas').select('id, proveedor_id, numero, fecha, total, saldo, estado, pago_a_reconstruir, clase')
          .in('proveedor_id', provIds).neq('estado', 'anulada').order('fecha').limit(1000))
      const papel = new Map(doc.comprobantes.map((c) => [c.numero_fmt, c.importe]))
      facturas = filas.filter((f) => f.clase !== 'nota_credito').map((f) => {
        const nombrada = !!f.numero && papel.has(f.numero) && f.proveedor_id === (proveedor?.id ?? f.proveedor_id)
        return {
          id: f.id, proveedor_id: f.proveedor_id, numero: f.numero, fecha: f.fecha, total: Number(f.total), saldo: Number(f.saldo), estado: f.estado,
          pago_a_reconstruir: !!f.pago_a_reconstruir, nombrada, importe_papel: nombrada ? (papel.get(f.numero!) ?? null) : null,
        }
      }).filter((f) => f.nombrada || f.saldo > 0.005)
        .sort((a, b) => Number(b.nombrada) - Number(a.nombrada) || a.fecha.localeCompare(b.fecha))
    }
    if (proveedor) {
      const faltan = doc.comprobantes.filter((c) => !facturas.some((f) => f.numero === c.numero_fmt))
      if (faltan.length) {
        doc.avisos.push({ severidad: 'advertencia', codigo: 'FACTURA_NO_CARGADA',
          mensaje: `El papel nombra ${faltan.map((c) => c.numero_fmt).join(', ')}, que no ${faltan.length === 1 ? 'está cargada' : 'están cargadas'} en Compras para este proveedor.` })
      }
      const yaPagas = facturas.filter((f) => f.nombrada && f.saldo <= 0.005)
      if (yaPagas.length && doc.tipo_documento !== 'resumen_cuenta') {
        doc.avisos.push({ severidad: 'info', codigo: 'FACTURA_YA_PAGADA',
          mensaje: `${yaPagas.map((f) => f.numero).join(', ')} ya ${yaPagas.length === 1 ? 'figura pagada' : 'figuran pagadas'} en el ERP.` })
      }
    }

    // ¿El cheque ya está en una OP emitida? ¿Ya hay un pago igual?
    const cheques = doc.medios.filter((m) => (m.forma === 'cheque' || m.forma === 'echeq') && m.numero)
    if (cheques.length) {
      const emitidos = await q<{ numero: string | null; monto: number | string; pagos_ordenes: { numero: number; estado: string } | { numero: number; estado: string }[] }>(
        supabase.from('pagos_cheques').select('numero, monto, pagos_ordenes!inner(numero, estado)')
          .in('numero', [...new Set(cheques.flatMap((m) => [m.numero!, numNorm(m.numero!)]))]).eq('pagos_ordenes.estado', 'emitida'))
      for (const m of cheques) {
        const hit = emitidos.find((c) => numNorm(c.numero ?? '') === numNorm(m.numero!) && m.importe != null && Math.abs(Number(c.monto) - m.importe) < 0.01)
        if (hit) {
          const op = Array.isArray(hit.pagos_ordenes) ? hit.pagos_ordenes[0] : hit.pagos_ordenes
          m.avisos.unshift({ severidad: 'error', codigo: 'CHEQUE_YA_REGISTRADO',
            mensaje: `El cheque N° ${m.numero} ya figura en la OP-${String(op?.numero ?? '').padStart(4, '0')}.` })
        }
      }
    }
    if (proveedor && doc.fecha) {
      const importes = doc.medios.map((m) => m.importe).filter((n): n is number => n != null)
      if (importes.length) {
        const ops = await q<{ numero: number; monto_pagado: number | string }>(supabase.from('pagos_ordenes')
          .select('numero, monto_pagado').eq('proveedor_id', proveedor.id).eq('estado', 'emitida').eq('fecha', doc.fecha))
        const suma = r2(importes.reduce((s, n) => s + n, 0))
        const igual = ops.find((o) => Math.abs(Number(o.monto_pagado) - suma) < 0.01)
        if (igual) {
          doc.avisos.unshift({ severidad: 'error', codigo: 'PAGO_YA_REGISTRADO',
            mensaje: `Ya hay una OP de este proveedor del mismo día y por el mismo importe: OP-${String(igual.numero).padStart(4, '0')}.` })
        }
      }
    }

    // De qué cuenta salió (transferencia).
    const cuentas = await q<CuentaTesoreria>(supabase.from('tesoreria_cuentas').select('id, nombre, banco, tipo').eq('activo', true))
    const transf = doc.medios.find((m) => m.forma === 'transferencia')
    const cuenta_origen_id = transf ? cuentaDeOrigen(transf.cuenta_origen_texto, cuentas) : null

    return { ...doc, proveedor, facturas, cuenta_origen_id, modelo: ia.modelo, storage_path: dto.storage_path }
  },

  /**
   * Registra un pago que YA SE HIZO: OP reconstruida (`pagos_reconstruir_orden`,
   * que pide `registrar_pagos` o admin y facturas «pago a reconstruir»), y
   * después los papeles como adjuntos de la OP. Si los adjuntos fallan, la OP
   * queda igual y se informa.
   */
  async reconstruir(dto: ReconstruirPagoDto, userId: string) {
    for (const a of dto.adjuntos) validarPathPendiente(a.storage_path)
    const lineas = [
      ...dto.lineas.map((l) => ({ tipo: 'factura', factura_id: l.factura_id, monto: l.monto })),
      ...(dto.a_cuenta && dto.a_cuenta > 0 ? [{ tipo: 'a_cuenta', monto: dto.a_cuenta }] : []),
    ]
    const orden = {
      fecha: dto.fecha, forma_pago: dto.forma_pago, monto_pagado: dto.monto_pagado,
      cuenta_origen_id: dto.cuenta_origen_id ?? null, referencia: dto.referencia, obs: dto.obs ?? '',
      ...(dto.cheques?.length ? { cheques: dto.cheques } : {}),
    }
    const { data, error } = await supabase.rpc('pagos_reconstruir_orden', {
      p_proveedor_id: dto.proveedor_id, p_orden: orden, p_lineas: lineas, p_user_id: userId,
    })
    if (error) {
      await borrarDelBucket(dto.adjuntos.map((a) => a.storage_path))
      throw mapRpcError(error)
    }
    const ordenId = Number(data)
    const { data: op } = await supabase.from('pagos_ordenes').select('id, numero').eq('id', ordenId).maybeSingle()

    let adjuntosError: string | null = null
    if (dto.adjuntos.length) {
      try {
        const procesados = await procesarPendientes(dto.adjuntos)
        const { error: e2 } = await supabase.from('pagos_ordenes_adjuntos').insert(procesados.map((a) => ({
          orden_id: ordenId, tipo: a.tipo, storage_path: a.storage_path, nombre_archivo: a.nombre_archivo,
          hash_sha256: a.hash_sha256, mime_type: a.mime_type, size_bytes: a.size_bytes, obs: a.obs ?? '',
          created_by: userId, updated_by: userId,
        })))
        if (e2) throw new Error(e2.message)
        await moverPendientesAOrden(ordenId, procesados)
      } catch (e) {
        adjuntosError = e instanceof Error ? e.message.slice(0, 200) : 'ERROR'
        console.error(`[pagos] OP ${ordenId} reconstruida, pero los adjuntos fallaron: ${adjuntosError}`)
      }
    }
    return { orden_id: ordenId, numero: (op as { numero?: number } | null)?.numero ?? null, adjuntos_error: adjuntosError }
  },
}
