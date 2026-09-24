/**
 * Cheques físicos con foto (20260925p).
 *
 * Flujo:
 *   1. POST /ordenes/upload-comprobante { tipo: 'cheque', … } → signed URL a
 *      `ordenes/pendientes/<uuid>.<ext>` (el mismo mecanismo que el
 *      comprobante de la OP: la OP todavía no existe).
 *   2. El navegador sube la foto.
 *   3. POST /cheques/leer { storage_path, mime_type } → propuesta + avisos,
 *      SIN crear nada. Si la IA no puede leer, 422 CHEQUE_ILEGIBLE (la foto
 *      sigue en pendientes: se puede adjuntar igual y tipear los datos).
 *   4. POST /ordenes con `cheques[].foto_path` = ese path: la foto se
 *      adjunta a la OP como tipo `cheque` con obs «Cheque N° X»
 *      (`adjuntosDeCheques`), con el mismo hash y dedupe que los demás.
 */
import { supabase } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'
import { PagosHttpError } from './pagos.errors.js'
import { BUCKET, extFromMime } from './adjuntos.service.js'
import { MIME_PERMITIDOS, PREFIJO_COMPROBANTE_PENDIENTE, type AdjuntoPendienteDto, type ChequeDto, type LeerChequeDto } from './pagos.schema.js'
import { cuitValido, normCuit } from './pagos.util.js'
import { leerChequeConIA, type LecturaChequeIA } from './lectura/cheque-ia.js'

export const CUIT_CADINC = '33717191949'

export interface AvisoCheque {
  campo: string
  severidad: 'error' | 'advertencia' | 'info'
  codigo: string
  mensaje: string
  [k: string]: unknown
}

export interface PropuestaCheque {
  numero: string | null
  banco: string | null
  /** YYYY-MM-DD: la fecha de pago (en uno común, la de emisión). */
  fecha_cobro: string | null
  fecha_emision: string | null
  importe: number | null
  librador: string | null
  librador_cuit: string | null
  es_echeq: boolean
  es_diferido: boolean
  /** true si el librador es CADINC; false si es de un tercero; null si no se sabe. */
  es_propio: boolean | null
}

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

/**
 * La lectura de la IA → propuesta saneada + avisos. Pura (sin base ni IA),
 * para testear. Lo que no pasa el control queda null y avisa: nada de esto
 * se guarda sin que una persona lo vea.
 */
export function propuestaDeCheque(l: LecturaChequeIA): { propuesta: PropuestaCheque; avisos: AvisoCheque[] } {
  const avisos: AvisoCheque[] = []
  const av = (campo: string, severidad: AvisoCheque['severidad'], codigo: string, mensaje: string) =>
    avisos.push({ campo, severidad, codigo, mensaje })

  const digitos = (l.numero ?? '').replace(/\D+/g, '')
  const numero = digitos ? digitos.slice(0, 40) : null
  if (!numero) av('numero', 'advertencia', 'NUMERO_NO_LEIDO', 'No se pudo leer el número del cheque: cargalo a mano.')

  const fecha_emision = fechaValida(l.fecha_emision)
  let fecha_cobro = fechaValida(l.fecha_pago) ?? fecha_emision
  if (fecha_cobro && fecha_emision && fecha_cobro < fecha_emision) {
    av('fecha_cobro', 'advertencia', 'FECHA_PAGO_ANTERIOR_A_EMISION',
      `La fecha de pago leída (${fecha_cobro}) es anterior a la de emisión (${fecha_emision}): revisala.`)
    fecha_cobro = fecha_emision
  }
  if (!fecha_cobro) av('fecha_cobro', 'advertencia', 'FECHA_NO_LEIDA', 'No se pudo leer la fecha de pago del cheque: cargala a mano.')

  const imp = typeof l.importe === 'number' && Number.isFinite(l.importe) && l.importe > 0
    ? Math.round(l.importe * 100) / 100 : null
  if (imp == null) av('importe', 'advertencia', 'IMPORTE_NO_LEIDO', 'No se pudo leer el importe del cheque: cargalo a mano.')
  if (imp != null && l.importe_letras_coincide === false) {
    av('importe', 'advertencia', 'IMPORTE_LETRAS_NO_COINCIDE',
      `El importe en números no coincide con el escrito en letras${l.importe_en_letras ? ` («${txt(l.importe_en_letras, 200)}»)` : ''}: revisalo contra el papel.`)
  }

  let librador_cuit = normCuit(l.librador_cuit ?? null)
  if (librador_cuit && !(/^\d{11}$/.test(librador_cuit) && cuitValido(librador_cuit))) {
    av('librador_cuit', 'advertencia', 'CUIT_LIBRADOR_INVALIDO', `El CUIT del librador leído (${librador_cuit}) no es válido.`)
    librador_cuit = null
  }
  const librador = txt(l.librador, 120)
  const es_propio: boolean | null = librador_cuit ? librador_cuit === CUIT_CADINC
    : librador ? /\bcadinc\b/i.test(librador)
    : null

  const es_diferido = l.es_diferido === true || (!!fecha_cobro && !!fecha_emision && fecha_cobro > fecha_emision)
  if (l.notas?.trim()) av('cheque', 'info', 'NOTA_LECTURA', l.notas.trim().slice(0, 300))

  return {
    propuesta: {
      numero,
      banco: txt(l.banco, 80),
      fecha_cobro,
      fecha_emision,
      importe: imp,
      librador,
      librador_cuit,
      es_echeq: l.es_echeq === true,
      es_diferido,
      es_propio,
    },
    avisos,
  }
}

function validarPathPendiente(path: string) {
  if (!path.startsWith(PREFIJO_COMPROBANTE_PENDIENTE) || path.includes('..')) {
    throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: path })
  }
}

const MIME_POR_EXT: Record<string, AdjuntoPendienteDto['mime_type']> = Object.fromEntries(
  (MIME_PERMITIDOS as readonly AdjuntoPendienteDto['mime_type'][]).map((m) => [extFromMime(m), m]),
) as Record<string, AdjuntoPendienteDto['mime_type']>

/**
 * Las fotos de los cheques como adjuntos pendientes de la OP: tipo `cheque`,
 * obs «Cheque N° X». Dos cheques con la misma foto (una foto de los dos) →
 * un solo adjunto con los dos números. Un path que ya viene en `adjuntos`
 * no se repite. El hash y el dedupe los hace `procesarPendientes`.
 */
export function adjuntosDeCheques(
  cheques: readonly Pick<ChequeDto, 'numero' | 'foto_path'>[] | undefined,
  yaAdjuntos: readonly { storage_path: string }[] = [],
): (AdjuntoPendienteDto & { obs: string })[] {
  const vistos = new Set(yaAdjuntos.map((a) => a.storage_path))
  const porPath = new Map<string, string[]>()
  for (const c of cheques ?? []) {
    const path = c.foto_path?.trim()
    if (!path) continue
    validarPathPendiente(path)
    if (vistos.has(path)) continue
    porPath.set(path, [...(porPath.get(path) ?? []), c.numero])
  }
  return [...porPath.entries()].map(([path, numeros]) => {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const mime = MIME_POR_EXT[ext]
    if (!mime) throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: path, campo: 'cheques' })
    return {
      tipo: 'cheque' as const,
      storage_path: path,
      nombre_archivo: `cheque-${numeros.join('-').replace(/[^\w-]+/g, '')}.${ext}`,
      mime_type: mime,
      obs: numeros.length === 1 ? `Cheque N° ${numeros[0]}` : `Cheques N° ${numeros.join(', ')}`,
    }
  })
}

/** Los cheques como los recibe la RPC: sin la foto (va como adjunto). */
export function chequesParaRpc<T extends { foto_path?: string | null }>(cheques: readonly T[] | undefined): Omit<T, 'foto_path'>[] {
  return (cheques ?? []).map(({ foto_path: _f, ...resto }) => resto)
}

export const chequesService = {
  async leer(dto: LeerChequeDto) {
    validarPathPendiente(dto.storage_path)
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) throw new PagosHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: dto.storage_path })
    const ia = await leerChequeConIA(Buffer.from(await dl.data.arrayBuffer()), dto.mime_type)
    if (!ia.ok || !ia.lectura.legible) {
      throw new PagosHttpError(422, 'CHEQUE_ILEGIBLE', {
        storage_path: dto.storage_path,
        motivo: ia.ok ? (ia.lectura.notas ?? 'NO_LEGIBLE') : ia.motivo,
      })
    }
    const { propuesta, avisos } = propuestaDeCheque(ia.lectura)

    // ¿Ya se entregó este cheque en otra OP emitida? Mismo criterio que el
    // trigger trg_pagos_cheque_unico (número + banco normalizados); acá sólo
    // avisa, el trigger es el que frena al emitir.
    if (propuesta.numero) {
      const { data } = await supabase.from('pagos_cheques')
        .select('orden_id, numero, banco, pagos_ordenes!inner(numero, estado)')
        .eq('numero', propuesta.numero).eq('pagos_ordenes.estado', 'emitida').limit(10)
      const bancoNorm = normTxt(propuesta.banco ?? '')
      const iguales = ((data ?? []) as { orden_id: number; banco: string | null; pagos_ordenes: { numero: number } | { numero: number }[] }[])
        .filter((c) => !bancoNorm || !c.banco || normTxt(c.banco) === bancoNorm)
      if (iguales.length > 0) {
        const op = iguales[0]!.pagos_ordenes
        const numOp = Array.isArray(op) ? op[0]?.numero : op?.numero
        avisos.unshift({
          campo: 'numero', severidad: 'error', codigo: 'CHEQUE_YA_ENTREGADO',
          mensaje: `El cheque N° ${propuesta.numero} ya figura entregado en la OP-${String(numOp ?? '').padStart(4, '0')}.`,
          orden_ids: [...new Set(iguales.map((c) => c.orden_id))],
        })
      }
    }

    const orden = { error: 0, advertencia: 1, info: 2 } as const
    return {
      propuesta,
      avisos: avisos.sort((a, b) => orden[a.severidad] - orden[b.severidad]),
      storage_path: dto.storage_path,
      modelo: ia.modelo,
    }
  },
}
