/**
 * «Soltá acá los cheques» en Ventas › Cobranzas (2026-09-25): el espejo, en
 * cobros, del de Compras › Pagos. El dueño suelta las fotos o PDFs de los
 * cheques que le dio un cliente y el cobro se arma solo.
 *
 * `leer()` NO crea nada: lee el archivo ya subido a `cobros/pendientes/` con
 * la IA de cheques de Compras (un archivo puede traer varios), sanea cada
 * lectura con el mismo control (`propuestaDeCheque`), reconoce al cliente por
 * el CUIT o el nombre del librador y mira si el cheque ya está en otro cobro
 * o en la cartera. La persona revisa y confirma con el `POST /cobros` de
 * siempre: cada cheque es un medio `cheque`/`echeq` (entra solo a la cartera,
 * trigger de 20260930f/k) y el archivo va como adjunto `comprobante_pago`.
 *
 * Un cheque endosado por el cliente trae el librador de un tercero: no se
 * reconoce el cliente por él y la persona lo elige.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { descargarAdjuntoPendiente } from './cobros.service.js'
import { leerChequeConIA } from '../pagos/lectura/cheque-ia.js'
import { MODELO_LECTURA_DEFAULT } from '../pagos/lectura/ia.js'
import { nombreComparable, propuestaDeCheque, type AvisoCheque, type PropuestaCheque } from '../pagos/cheques.service.js'
import type { LeerChequesCobroDto } from './facturacion.schema.js'

/** Mismo modelo que la cartera de Logística (el dueño eligió Sonnet el 25/09). */
const MODELO = process.env.CARTERA_LECTURA_MODEL ?? process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT

export interface ClienteVentas { id: number; razon_social: string; doc_nro: string | null }

/** El cliente que dio el cheque, si se reconoce; `por` dice cómo. */
export interface ClienteDelCheque { id: number; razon_social: string; por: 'cuit' | 'nombre' }

export interface ChequeLeidoCobro {
  propuesta: PropuestaCheque
  avisos: AvisoCheque[]
  cliente: ClienteDelCheque | null
  /** El cheque ya es un medio de un cobro vigente de Ventas. */
  cobro_existente_id: number | null
}

export interface LecturaChequesCobro {
  cheques: ChequeLeidoCobro[]
  modelo: string | null
  adjunto: { storage_path: string; nombre_archivo: string; mime: string; size: number; hash: string }
}

const numNorm = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '') || '0'

/**
 * El cliente por el librador: primero por CUIT (`doc_nro`); si no, por el
 * nombre sin la forma societaria (igual, o uno contenido en el otro con al
 * menos 5 letras). Sólo si hay UNO: con dos candidatos no se adivina. Pura,
 * para testear.
 */
export function clienteDelCheque(
  p: Pick<PropuestaCheque, 'librador' | 'librador_cuit'>, clientes: readonly ClienteVentas[],
): ClienteDelCheque | null {
  if (p.librador_cuit) {
    const porCuit = clientes.filter((c) => (c.doc_nro ?? '').replace(/\D/g, '') === p.librador_cuit)
    if (porCuit.length === 1) return { id: porCuit[0]!.id, razon_social: porCuit[0]!.razon_social, por: 'cuit' }
  }
  const nom = nombreComparable(p.librador ?? '')
  if (nom.length < 3) return null
  const iguales = clientes.filter((c) => nombreComparable(c.razon_social) === nom)
  const cands = iguales.length > 0 ? iguales : nom.length >= 5
    ? clientes.filter((c) => { const x = nombreComparable(c.razon_social); return x.length >= 5 && (x.includes(nom) || nom.includes(x)) })
    : []
  return cands.length === 1 ? { id: cands[0]!.id, razon_social: cands[0]!.razon_social, por: 'nombre' } : null
}

async function q<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p
  if (error) throw mapRpcError(error as PgError)
  return (data ?? []) as T[]
}

export const chequesCobroService = {
  async leer(dto: LeerChequesCobroDto, db: SupabaseClient = supabase): Promise<LecturaChequesCobro> {
    const archivo = await descargarAdjuntoPendiente(dto.storage_path)
    const ia = await leerChequeConIA(archivo.buf, dto.mime, MODELO)
    const legibles = ia.ok ? ia.lecturas.filter((l) => l.legible) : []
    if (!ia.ok || legibles.length === 0) {
      throw new FacturacionHttpError(422, 'CHEQUE_ILEGIBLE', {
        storage_path: dto.storage_path,
        motivo: ia.ok ? (ia.lecturas[0]?.notas ?? 'NO_LEGIBLE') : ia.motivo,
      })
    }

    const clientes = await q<ClienteVentas>(db.from('ventas_clientes').select('id, razon_social, doc_nro').eq('activo', true))
    const leidos = legibles.map((l) => propuestaDeCheque(l))

    // ¿Ya es un medio de un cobro vigente? ¿Ya está en la cartera?
    const nums = leidos.map((x) => x.propuesta.numero).filter((n): n is string => !!n)
    // El número se guarda como se tipeó («00000344» o «344»): se busca de las dos formas.
    const medios = nums.length
      ? await q<{ cobro_id: number; cheque_numero: string | null; importe: number | string }>(db.from('ventas_cobro_medios')
          .select('cobro_id, cheque_numero, importe').in('forma', ['cheque', 'echeq'])
          .in('cheque_numero', [...new Set([...nums, ...nums.map(numNorm)])]))
      : []
    const deEstos = medios.filter((m) => nums.some((n) => numNorm(m.cheque_numero ?? '') === numNorm(n)))
    const vigentes = deEstos.length
      ? new Set((await q<{ id: number }>(db.from('ventas_cobros').select('id')
          .in('id', [...new Set(deEstos.map((m) => m.cobro_id))]).eq('estado', 'vigente'))).map((c) => c.id))
      : new Set<number>()
    const cartera = nums.length
      ? await q<{ numero_norm: string; importe: number | string; estado: string }>(db.from('cheques_recibidos')
          .select('numero_norm, importe, estado').in('numero_norm', nums.map(numNorm)))
      : []

    const cheques = leidos.map(({ propuesta, avisos }) => {
      const corto = propuesta.numero ? numNorm(propuesta.numero) : null
      const mismoImporte = (v: number | string) => propuesta.importe != null && Math.abs(Number(v) - propuesta.importe) < 0.005
      const otro = corto
        ? deEstos.find((m) => vigentes.has(m.cobro_id) && numNorm(m.cheque_numero ?? '') === corto && mismoImporte(m.importe))
        : undefined
      if (otro) {
        avisos.unshift({ campo: 'numero', severidad: 'error', codigo: 'CHEQUE_YA_COBRADO',
          mensaje: `El cheque N° ${propuesta.numero} ya figura en otro cobro vigente.`, cobro_id: otro.cobro_id })
      } else if (corto && cartera.some((r) => r.numero_norm === corto && mismoImporte(r.importe))) {
        avisos.push({ campo: 'numero', severidad: 'info', codigo: 'CHEQUE_EN_CARTERA',
          mensaje: 'Ya está en la cartera de cheques recibidos (lo cargó otro circuito): al registrar el cobro se vincula, no se duplica.' })
      }
      const orden = { error: 0, advertencia: 1, info: 2 } as const
      return {
        propuesta,
        avisos: avisos.sort((a, b) => orden[a.severidad] - orden[b.severidad]),
        cliente: clienteDelCheque(propuesta, clientes),
        cobro_existente_id: otro?.cobro_id ?? null,
      }
    })

    return {
      cheques,
      modelo: ia.modelo,
      adjunto: { storage_path: dto.storage_path.trim(), nombre_archivo: dto.nombre_archivo, mime: dto.mime, size: archivo.size, hash: archivo.hash },
    }
  },
}
