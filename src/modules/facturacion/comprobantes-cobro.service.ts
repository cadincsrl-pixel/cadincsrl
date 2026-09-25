/**
 * «Soltá acá los comprobantes del cobro» en Ventas › Cobranzas (2026-09-25).
 * Lo que un cliente manda cuando paga: foto de un cheque, comprobante de un
 * e-cheq, de una transferencia o un depósito, o su orden de pago (qué
 * facturas paga, con qué medios y qué retiene). El cobro se arma solo.
 *
 * `leer()` NO crea nada: lee el archivo ya subido a `cobros/pendientes/` con
 * la IA (`comprobante-cobro-ia.ts`), sanea la lectura (`documentoDeLectura`,
 * pura), reconoce al cliente por el CUIT o el nombre del pagador, la cuenta
 * de CADINC de una transferencia por CBU/alias/banco, y avisa si un cheque ya
 * está en otro cobro vigente o en la cartera. La persona revisa y confirma
 * con el `POST /cobros` de siempre: cada medio entra como medio del cobro
 * (los cheques, solos a la cartera), las retenciones con su tipo, y la
 * aplicación va a las facturas que nombra la orden de pago (o, si no nombra
 * ninguna, a las más viejas).
 *
 * Un cheque endosado por el cliente trae el librador de un tercero: el
 * pagador es quien lo endosó; si la IA no lo sabe, la persona elige el cliente.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { descargarAdjuntoPendiente } from './cobros.service.js'
import { leerComprobanteCobroConIA, type LecturaComprobanteCobroIA } from './comprobante-cobro-ia.js'
import { nombreComparable } from '../pagos/cheques.service.js'
import { cuitValido } from '../pagos/pagos.util.js'
import type { LeerComprobanteCobroDto } from './facturacion.schema.js'

export type TipoDocumentoCobro = 'cheque' | 'echeq' | 'transferencia' | 'deposito' | 'orden_pago' | 'otro'
export type FormaMedio = 'cheque' | 'echeq' | 'transferencia' | 'efectivo'
export type TipoRetencion = 'iibb' | 'ganancias' | 'suss' | 'iva' | 'tem' | 'otra'

export interface AvisoCobro { severidad: 'error' | 'advertencia' | 'info'; codigo: string; mensaje: string; [k: string]: unknown }

export interface ClienteVentas { id: number; razon_social: string; doc_nro: string | null }
export interface CuentaVentas { id: number; banco: string; cbu: string | null; alias: string | null }

export interface MedioLeido {
  forma: FormaMedio
  importe: number | null
  numero: string | null
  banco: string | null
  fecha_cobro: string | null
  librador: string | null
  librador_cuit: string | null
  /** Transferencia/depósito: la cuenta de CADINC reconocida, o null. */
  cuenta_bancaria_id: number | null
  cuenta_texto: string | null
  avisos: AvisoCobro[]
  /** Cheque que ya es medio de un cobro vigente. */
  cobro_existente_id: number | null
}

export interface RetencionLeida {
  tipo: TipoRetencion
  jurisdiccion: string | null
  certificado_numero: string | null
  fecha: string | null
  importe: number
}

export interface ComprobanteLeido { tipo: string | null; pto_vta: number; numero: number; importe: number | null }

export interface DocumentoCobro {
  tipo_documento: TipoDocumentoCobro
  fecha: string | null
  pagador_nombre: string | null
  pagador_cuit: string | null
  cliente: { id: number; razon_social: string; por: 'cuit' | 'nombre' } | null
  medios: MedioLeido[]
  retenciones: RetencionLeida[]
  comprobantes: ComprobanteLeido[]
  total: number | null
  avisos: AvisoCobro[]
}

export interface LecturaComprobanteCobro extends DocumentoCobro {
  modelo: string | null
  adjunto: { storage_path: string; nombre_archivo: string; mime: string; size: number; hash: string }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const numNorm = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '') || '0'
const soloDigitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

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

function cuitOk(s: string | null | undefined): string | null {
  const d = soloDigitos(s)
  return d.length === 11 && cuitValido(d) ? d : null
}

const importe = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n !== 0 ? r2(Math.abs(n)) : null)

const TIPOS_DOC: readonly TipoDocumentoCobro[] = ['cheque', 'echeq', 'transferencia', 'deposito', 'orden_pago', 'otro']
const TIPOS_RET: readonly TipoRetencion[] = ['iibb', 'ganancias', 'suss', 'iva', 'tem', 'otra']

function formaDe(t: string | null): FormaMedio | null {
  const s = (t ?? '').toLowerCase()
  if (/e-?cheq/.test(s)) return 'echeq'
  if (/cheq/.test(s)) return 'cheque'
  if (/transf|dep[oó]s/.test(s)) return 'transferencia'
  if (/efect/.test(s)) return 'efectivo'
  return null
}

function tipoRetencionDe(t: string | null): TipoRetencion {
  const s = (t ?? '').toLowerCase()
  if (TIPOS_RET.includes(s as TipoRetencion)) return s as TipoRetencion
  if (/brut|iibb/.test(s)) return 'iibb'
  if (/ganan/.test(s)) return 'ganancias'
  if (/suss|segur/.test(s)) return 'suss'
  if (/iva/.test(s)) return 'iva'
  if (/tem|munic|tasa/.test(s)) return 'tem'
  return 'otra'
}

/**
 * El cliente por el pagador: primero por CUIT (`doc_nro`); si no, por el
 * nombre sin la forma societaria (igual, o uno contenido en el otro con al
 * menos 5 letras). Sólo si hay UNO: con dos candidatos no se adivina.
 */
export function clienteDelPagador(
  nombre: string | null, cuit: string | null, clientes: readonly ClienteVentas[],
): DocumentoCobro['cliente'] {
  if (cuit) {
    const porCuit = clientes.filter((c) => soloDigitos(c.doc_nro) === cuit)
    if (porCuit.length === 1) return { id: porCuit[0]!.id, razon_social: porCuit[0]!.razon_social, por: 'cuit' }
  }
  const nom = nombreComparable(nombre ?? '')
  if (nom.length < 3) return null
  const iguales = clientes.filter((c) => nombreComparable(c.razon_social) === nom)
  const cands = iguales.length > 0 ? iguales : nom.length >= 5
    ? clientes.filter((c) => { const x = nombreComparable(c.razon_social); return x.length >= 5 && (x.includes(nom) || nom.includes(x)) })
    : []
  return cands.length === 1 ? { id: cands[0]!.id, razon_social: cands[0]!.razon_social, por: 'nombre' } : null
}

/** La cuenta de CADINC de una transferencia: por CBU (22 dígitos), alias o banco (si hay una sola de ese banco). */
export function cuentaDeTransferencia(texto: string | null, cuentas: readonly CuentaVentas[]): number | null {
  const t = (texto ?? '').trim()
  if (!t) return null
  const dig = soloDigitos(t)
  if (dig.length >= 22) {
    const c = cuentas.find((x) => soloDigitos(x.cbu) && dig.includes(soloDigitos(x.cbu)))
    if (c) return c.id
  }
  const up = t.toUpperCase()
  const porAlias = cuentas.find((x) => x.alias && up.includes(x.alias.toUpperCase()))
  if (porAlias) return porAlias.id
  const nom = nombreComparable(t)
  const porBanco = cuentas.filter((x) => { const b = nombreComparable(x.banco).replace(/^banco /, ''); return b.length >= 4 && nom.includes(b) })
  return porBanco.length === 1 ? porBanco[0]!.id : null
}

/**
 * La lectura de la IA → documento saneado + avisos. Pura (sin base ni IA),
 * para testear. Lo que no pasa el control queda null y avisa: nada de esto se
 * guarda sin que una persona lo vea.
 */
export function documentoDeLectura(
  l: LecturaComprobanteCobroIA, clientes: readonly ClienteVentas[], cuentas: readonly CuentaVentas[],
): DocumentoCobro {
  const avisos: AvisoCobro[] = []
  const td = (l.tipo_documento ?? '').toLowerCase() as TipoDocumentoCobro
  const tipo_documento = TIPOS_DOC.includes(td) ? td : 'otro'
  const pagador_cuit = cuitOk(l.pagador_cuit)
  const pagador_nombre = txt(l.pagador_nombre, 160)

  const medios: MedioLeido[] = l.medios.flatMap((m) => {
    const forma = formaDe(m.forma) ?? (tipo_documento === 'echeq' ? 'echeq' : tipo_documento === 'cheque' ? 'cheque'
      : tipo_documento === 'transferencia' || tipo_documento === 'deposito' ? 'transferencia' : null)
    if (!forma) return []
    const av: AvisoCobro[] = []
    const imp = importe(m.importe)
    if (imp == null) av.push({ severidad: 'advertencia', codigo: 'IMPORTE_NO_LEIDO', mensaje: 'No se pudo leer el importe: cargalo a mano.' })
    const esCheque = forma === 'cheque' || forma === 'echeq'
    const numero = esCheque ? (soloDigitos(m.numero).slice(0, 40) || null) : txt(m.numero, 60)
    const fecha = fechaValida(m.fecha_cobro)
    if (esCheque && !numero) av.push({ severidad: 'advertencia', codigo: 'NUMERO_NO_LEIDO', mensaje: 'No se pudo leer el número del cheque: cargalo a mano.' })
    if (esCheque && !fecha) av.push({ severidad: 'advertencia', codigo: 'FECHA_NO_LEIDA', mensaje: 'No se pudo leer la fecha de pago del cheque: cargala a mano.' })
    const cuentaTexto = forma === 'transferencia' ? txt(m.cuenta_destino, 120) : null
    const cuenta = forma === 'transferencia' ? cuentaDeTransferencia(cuentaTexto, cuentas) : null
    if (forma === 'transferencia' && !cuenta) {
      av.push(cuentaTexto
        ? { severidad: 'advertencia', codigo: 'CUENTA_NO_RECONOCIDA',
            mensaje: `No se reconoció la cuenta de CADINC donde entró («${cuentaTexto}»): elegila en el cobro.` }
        : { severidad: 'info', codigo: 'CUENTA_NO_INFORMADA',
            mensaje: 'El comprobante no dice a qué cuenta de CADINC entró: el cobro arranca con la cuenta por defecto; revisala.' })
    }
    return [{
      forma, importe: imp, numero, banco: txt(m.banco, 80), fecha_cobro: fecha,
      librador: esCheque ? txt(m.librador, 120) : null,
      librador_cuit: esCheque ? cuitOk(m.librador_cuit) : null,
      cuenta_bancaria_id: cuenta, cuenta_texto: cuentaTexto, avisos: av, cobro_existente_id: null,
    }]
  })

  const retenciones: RetencionLeida[] = l.retenciones.flatMap((r) => {
    const imp = importe(r.importe)
    if (imp == null) return []
    return [{ tipo: tipoRetencionDe(r.tipo), jurisdiccion: txt(r.jurisdiccion, 80), certificado_numero: txt(r.certificado_numero, 60), fecha: fechaValida(r.fecha), importe: imp }]
  })

  const comprobantes: ComprobanteLeido[] = l.comprobantes.flatMap((c) =>
    c.pto_vta != null && c.numero != null && c.pto_vta > 0 && c.numero > 0
      ? [{ tipo: txt(c.tipo, 20), pto_vta: Math.trunc(c.pto_vta), numero: Math.trunc(c.numero), importe: importe(c.importe) }]
      : [])

  // El total de una orden de pago puede ser el neto pagado (sólo medios) o el
  // bruto (medios + retenciones = lo que se cancela de las facturas): cierra
  // con cualquiera de los dos, o si medios + retenciones = Σ facturas pagadas.
  const total = importe(l.total)
  const sumaMedios = r2(medios.reduce((s, m) => s + (m.importe ?? 0), 0))
  const suma = r2(sumaMedios + retenciones.reduce((s, r) => s + r.importe, 0))
  const sumaFacturas = comprobantes.every((c) => c.importe != null) && comprobantes.length > 0
    ? r2(comprobantes.reduce((s, c) => s + (c.importe ?? 0), 0)) : null
  const cierra = (a: number, b: number | null) => b != null && Math.abs(a - b) <= 0.01
  if (medios.length + retenciones.length > 0 && (total != null || sumaFacturas != null)
      && !cierra(suma, total) && !cierra(sumaMedios, total) && !cierra(suma, sumaFacturas)) {
    avisos.push({ severidad: 'advertencia', codigo: 'TOTAL_NO_CIERRA',
      mensaje: `Los medios y retenciones leídos suman ${suma.toFixed(2)}${total != null ? ` y el documento dice ${total.toFixed(2)}` : ''}${sumaFacturas != null ? ` (las facturas que paga suman ${sumaFacturas.toFixed(2)})` : ''}: revisalo contra el papel.` })
  }
  if (medios.length === 0 && retenciones.length === 0) {
    avisos.push({ severidad: 'advertencia', codigo: 'SIN_MEDIOS', mensaje: 'No se leyó ningún medio de pago ni retención: cargalos a mano en el cobro.' })
  }
  if (l.notas?.trim()) avisos.push({ severidad: 'info', codigo: 'NOTA_LECTURA', mensaje: l.notas.trim().slice(0, 300) })

  // El cliente: el pagador; en una foto de cheque sin pagador, el librador.
  const cheque0 = medios.find((m) => m.forma === 'cheque' || m.forma === 'echeq')
  const cliente = clienteDelPagador(pagador_nombre, pagador_cuit, clientes)
    ?? (cheque0 ? clienteDelPagador(cheque0.librador, cheque0.librador_cuit, clientes) : null)

  return {
    tipo_documento, fecha: fechaValida(l.fecha), pagador_nombre, pagador_cuit, cliente,
    medios, retenciones, comprobantes, total, avisos,
  }
}

async function q<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p
  if (error) throw mapRpcError(error as PgError)
  return (data ?? []) as T[]
}

export const comprobantesCobroService = {
  async leer(dto: LeerComprobanteCobroDto, db: SupabaseClient = supabase): Promise<LecturaComprobanteCobro> {
    const archivo = await descargarAdjuntoPendiente(dto.storage_path)
    const ia = await leerComprobanteCobroConIA(archivo.buf, dto.mime)
    if (!ia.ok || !ia.lectura.legible) {
      throw new FacturacionHttpError(422, 'COMPROBANTE_ILEGIBLE', {
        storage_path: dto.storage_path,
        motivo: ia.ok ? (ia.lectura.notas ?? 'NO_LEGIBLE') : ia.motivo,
      })
    }

    const [clientes, cuentas] = await Promise.all([
      q<ClienteVentas>(db.from('ventas_clientes').select('id, razon_social, doc_nro').eq('activo', true)),
      q<CuentaVentas>(db.from('ventas_cuentas_bancarias').select('id, banco, cbu, alias').eq('activo', true)),
    ])
    const doc = documentoDeLectura(ia.lectura, clientes, cuentas)

    // Cheques: ¿ya son medio de un cobro vigente? ¿ya están en la cartera?
    const cheques = doc.medios.filter((m) => (m.forma === 'cheque' || m.forma === 'echeq') && m.numero)
    if (cheques.length > 0) {
      const nums = cheques.map((m) => m.numero!)
      const medios = await q<{ cobro_id: number; cheque_numero: string | null; importe: number | string }>(db.from('ventas_cobro_medios')
        .select('cobro_id, cheque_numero, importe').in('forma', ['cheque', 'echeq'])
        .in('cheque_numero', [...new Set([...nums, ...nums.map(numNorm)])]))
      const vigentes = medios.length
        ? new Set((await q<{ id: number }>(db.from('ventas_cobros').select('id')
            .in('id', [...new Set(medios.map((m) => m.cobro_id))]).eq('estado', 'vigente'))).map((c) => c.id))
        : new Set<number>()
      const cartera = await q<{ numero_norm: string; importe: number | string }>(db.from('cheques_recibidos')
        .select('numero_norm, importe').in('numero_norm', nums.map(numNorm)))
      for (const m of cheques) {
        const corto = numNorm(m.numero!)
        const igual = (v: number | string) => m.importe != null && Math.abs(Number(v) - m.importe) < 0.005
        const otro = medios.find((x) => vigentes.has(x.cobro_id) && numNorm(x.cheque_numero ?? '') === corto && igual(x.importe))
        if (otro) {
          m.cobro_existente_id = otro.cobro_id
          m.avisos.unshift({ severidad: 'error', codigo: 'CHEQUE_YA_COBRADO', mensaje: `El cheque N° ${m.numero} ya figura en otro cobro vigente.`, cobro_id: otro.cobro_id })
        } else if (cartera.some((r) => r.numero_norm === corto && igual(r.importe))) {
          m.avisos.push({ severidad: 'info', codigo: 'CHEQUE_EN_CARTERA',
            mensaje: 'Ya está en la cartera de cheques recibidos (lo cargó otro circuito): al registrar el cobro se vincula, no se duplica.' })
        }
      }
    }

    return {
      ...doc,
      modelo: ia.modelo,
      adjunto: { storage_path: dto.storage_path.trim(), nombre_archivo: dto.nombre_archivo, mime: dto.mime, size: archivo.size, hash: archivo.hash },
    }
  },
}
