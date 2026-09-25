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

// Única fuente del CUIT: lib/empresa.ts (ARCA_CUIT o el default).
import { CUIT_EMPRESA as CUIT_CADINC } from '../../lib/empresa.js'
export { CUIT_CADINC }

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
  /** A quién se le entrega: el beneficiario, o el endosatario si es un endoso (2026-09-25). */
  entregado_a: string | null
  entregado_a_cuit: string | null
}

/** El proveedor de Compras al que va el cheque, si se reconoce. */
export interface ProveedorDelCheque { id: number; razon_social: string; por: 'cuit' | 'nombre' }

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
  // Un cheque endosado lo libró OTRO: CADINC lo recibió y lo transfiere
  // (2026-09-25). El comprobante del Galicia sólo trae endosante y
  // endosatario, así que el librador suele venir vacío.
  const es_propio: boolean | null = l.es_endoso === true ? false
    : librador_cuit ? librador_cuit === CUIT_CADINC
    : librador ? /\bcadinc\b/i.test(librador)
    : null

  // El CUIT de a quién se entrega: si no es válido se descarta sin aviso (el
  // proveedor se busca igual por el nombre).
  const cuitEnt = normCuit(l.entregado_a_cuit ?? null)
  const entregadoACuit = cuitEnt && /^\d{11}$/.test(cuitEnt) && cuitValido(cuitEnt) ? cuitEnt : null

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
      entregado_a: txt(l.entregado_a, 160),
      entregado_a_cuit: entregadoACuit,
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

/**
 * Los cheques como los recibe la RPC. La foto va como adjunto aparte; en el
 * cheque queda sólo su `foto_path` (el path que sobrevivió al dedupe de
 * `procesarPendientes`, vía `reemplazos`), para que `_pagos_emitir_orden`
 * sepa si CADA echeq trae su archivo (20260929u). La RPC no lo guarda en
 * `pagos_cheques`: sólo lo mira.
 */
export function chequesParaRpc<T extends { foto_path?: string | null }>(
  cheques: readonly T[] | undefined, reemplazos?: ReadonlyMap<string, string>,
): (Omit<T, 'foto_path'> & { foto_path: string | null })[] {
  return (cheques ?? []).map(({ foto_path, ...resto }) => {
    const path = foto_path?.trim() || null
    return { ...resto, foto_path: path ? (reemplazos?.get(path) ?? path) : null }
  })
}

/**
 * El librador como lo guarda la pantalla si el cheque queda «de tercero»:
 * «Nombre · CUIT n» (ver `leerFotoCheque` en el editor de cheques). Si es
 * propio, la pantalla guarda ''.
 */
export function libradorComoSeGuarda(p: Pick<PropuestaCheque, 'librador' | 'librador_cuit'>): string {
  return [p.librador?.trim(), p.librador_cuit ? `CUIT ${p.librador_cuit}` : null].filter(Boolean).join(' · ')
}

export interface ChequeEmitido {
  orden_id: number
  numero: string | null
  banco: string | null
  librador: string | null
  pagos_ordenes: { numero: number } | { numero: number }[]
}

/**
 * ¿El trigger `fn_pagos_cheque_unico` frenaría este cheque contra `c` (un
 * cheque de una OP emitida)? Mismo criterio: norm_txt(número), norm_txt(banco)
 * y norm_txt(librador) iguales (`normTxt` es su espejo exacto; null → '').
 *
 * El librador depende de cómo se cargue: propio → '' y de tercero → el leído
 * (`libradorComoSeGuarda`). Si la foto dice de quién es, se usa ése; si no se
 * sabe (`es_propio` null), se avisa si choca de cualquiera de las dos formas.
 */
export function chocaConEmitido(
  p: Pick<PropuestaCheque, 'numero' | 'banco' | 'librador' | 'librador_cuit' | 'es_propio'>, c: Pick<ChequeEmitido, 'numero' | 'banco' | 'librador'>,
): boolean {
  if (!p.numero) return false
  if (normTxt(c.numero ?? '') !== normTxt(p.numero)) return false
  if (normTxt(c.banco ?? '') !== normTxt(p.banco ?? '')) return false
  const deTercero = libradorComoSeGuarda(p)
  const posibles = p.es_propio === true ? [''] : p.es_propio === false ? [deTercero] : ['', deTercero]
  return posibles.map(normTxt).includes(normTxt(c.librador ?? ''))
}

export const chequesService = {
  async leer(dto: LeerChequeDto) {
    validarPathPendiente(dto.storage_path)
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) throw new PagosHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: dto.storage_path })
    const ia = await leerChequeConIA(Buffer.from(await dl.data.arrayBuffer()), dto.mime_type)
    const legibles = ia.ok ? ia.lecturas.filter((l) => l.legible) : []
    if (!ia.ok || legibles.length === 0) {
      throw new PagosHttpError(422, 'CHEQUE_ILEGIBLE', {
        storage_path: dto.storage_path,
        motivo: ia.ok ? (ia.lecturas[0]?.notas ?? 'NO_LEGIBLE') : ia.motivo,
      })
    }

    // Un archivo puede traer varios cheques (el PDF del Galicia con la
    // emisión y los endosos, 2026-09-25): uno por cheque, cada uno con su
    // control. `propuesta`/`avisos` sueltos son el primero, para quien lee
    // un solo cheque.
    // A qué proveedor va cada cheque (para «Soltá los cheques» de Compras ›
    // Pagos, 2026-09-25): por CUIT y, si no, por el nombre.
    const { data: padron } = await supabase.from('pagos_proveedores').select('id, razon_social, cuit').eq('activo', true)
    const provs = (padron ?? []) as PadronProveedor[]
    const cheques = await Promise.all(legibles.map(async (l) => {
      const { propuesta, avisos } = propuestaDeCheque(l)
      if (l.es_endoso === true && !propuesta.librador) await libradorDelEndoso(propuesta, avisos)
      await avisarSiYaEntregado(propuesta, avisos)
      const orden = { error: 0, advertencia: 1, info: 2 } as const
      return {
        propuesta,
        avisos: avisos.sort((a, b) => orden[a.severidad] - orden[b.severidad]),
        proveedor: proveedorDelCheque(propuesta, provs),
      }
    }))
    return {
      ...cheques[0]!,
      cheques,
      storage_path: dto.storage_path,
      modelo: ia.modelo,
    }
  },
}

/** Lo que se pone cuando el comprobante del endoso no dice quién libró el cheque (así se cargaron los de la OP-0241). */
export const LIBRADOR_NO_INFORMADO = 'No informado en el detalle del endoso'

/**
 * El librador de un cheque endosado, que el comprobante del banco no trae:
 * se busca entre los cheques RECIBIDOS en los cobros de Ventas por el número
 * (sin ceros a la izquierda). Si no está, queda «No informado…» y un aviso
 * para completarlo a mano. (2026-09-25; los cobros de Logística todavía no
 * registran cheques.)
 */
async function libradorDelEndoso(p: PropuestaCheque, avisos: AvisoCheque[]): Promise<void> {
  const corto = (p.numero ?? '').replace(/^0+/, '')
  if (corto) {
    const { data } = await supabase.from('ventas_cobro_medios')
      .select('cheque_numero, cheque_banco, cheque_librador').ilike('cheque_numero', `%${corto}%`).limit(20)
    const r = ((data ?? []) as { cheque_numero: string | null; cheque_banco: string | null; cheque_librador: string | null }[])
      .find((x) => (x.cheque_numero ?? '').replace(/\D/g, '').replace(/^0+/, '') === corto && x.cheque_librador?.trim())
    if (r) {
      p.librador = r.cheque_librador!.trim()
      if (!p.banco && r.cheque_banco?.trim()) p.banco = r.cheque_banco.trim()
      avisos.push({ campo: 'librador', severidad: 'info', codigo: 'LIBRADOR_DEL_COBRO',
        mensaje: `Librador tomado del cobro donde se recibió el cheque: ${p.librador}.` })
      return
    }
  }
  p.librador = LIBRADOR_NO_INFORMADO
  avisos.push({ campo: 'librador', severidad: 'advertencia', codigo: 'LIBRADOR_NO_INFORMADO',
    mensaje: 'Es un endoso y el comprobante no dice quién libró el cheque: si lo sabés, completalo.' })
}

export interface PadronProveedor { id: number; razon_social: string; cuit: string | null }

/** El nombre sin la forma societaria, para comparar «SUPERMAT CENTRAL S.A.S.» con «Supermat Central SAS». */
export function nombreComparable(t: string): string {
  return normTxt(t)
    .replace(/[.,]/g, ' ')
    .replace(/\b(s\s*a\s*s|s\s*r\s*l|s\s*a\s*u|s\s*a|s\s*h|s\s*c\s*a|sociedad anonima|sociedad de responsabilidad limitada)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

/**
 * El proveedor al que se entrega el cheque: primero por CUIT; si no, por el
 * nombre (igual sin la forma societaria, o uno contenido en el otro con al
 * menos 5 letras). Sólo si hay UNO: con dos candidatos no se adivina.
 */
export function proveedorDelCheque(
  p: Pick<PropuestaCheque, 'entregado_a' | 'entregado_a_cuit'>, provs: readonly PadronProveedor[],
): ProveedorDelCheque | null {
  if (p.entregado_a_cuit) {
    const porCuit = provs.filter((x) => normCuit(x.cuit ?? null) === p.entregado_a_cuit)
    if (porCuit.length === 1) return { id: porCuit[0]!.id, razon_social: porCuit[0]!.razon_social, por: 'cuit' }
  }
  const nom = nombreComparable(p.entregado_a ?? '')
  if (nom.length < 3) return null
  const iguales = provs.filter((x) => nombreComparable(x.razon_social) === nom)
  const cands = iguales.length > 0 ? iguales : nom.length >= 5
    ? provs.filter((x) => { const c = nombreComparable(x.razon_social); return c.length >= 5 && (c.includes(nom) || nom.includes(c)) })
    : []
  return cands.length === 1 ? { id: cands[0]!.id, razon_social: cands[0]!.razon_social, por: 'nombre' } : null
}

/**
 * ¿Ya se entregó este cheque en otra OP emitida? EXACTAMENTE el criterio del
 * trigger trg_pagos_cheque_unico (20260929u): número + banco + librador
 * normalizados con norm_txt, sólo contra OPs 'emitida'. Antes miraba sólo el
 * número y avisaba de más: el echeq N° 3080 del Galicia «chocaba» con el
 * cheque de TERCERO N° 3080 (sin banco, otro librador) endosado en la
 * OP-0240, que el trigger no frena. Acá sólo avisa; el trigger es el que
 * frena al emitir.
 */
async function avisarSiYaEntregado(propuesta: PropuestaCheque, avisos: AvisoCheque[]): Promise<void> {
  if (!propuesta.numero) return
  // El número sin ceros a la izquierda: el PDF del banco dice «00000344» y
  // la carga a mano, «344» (2026-09-25).
  const corto = propuesta.numero.replace(/^0+/, '') || '0'
  const { data } = await supabase.from('pagos_cheques')
    .select('orden_id, numero, banco, librador, monto, pagos_ordenes!inner(numero, estado)')
    .ilike('numero', `%${corto}%`).eq('pagos_ordenes.estado', 'emitida').limit(50)
  const filas = (data ?? []) as (ChequeEmitido & { monto: number | string | null })[]
  const iguales = filas.filter((c) => chocaConEmitido(propuesta, c))
  // Mismo número y mismo importe, aunque el banco o el librador se hayan
  // cargado distinto: el trigger no lo frena, pero es casi seguro el mismo
  // cheque (los endosos del Galicia vs. la carga a mano de la OP-0244).
  const parecidos = iguales.length > 0 ? [] : filas.filter((c) =>
    (c.numero ?? '').replace(/\D/g, '').replace(/^0+/, '') === corto
    && propuesta.importe != null && Math.abs(Number(c.monto) - propuesta.importe) < 0.01)
  const choques = iguales.length > 0 ? iguales : parecidos
  if (choques.length === 0) return
  const op = choques[0]!.pagos_ordenes
  const numOp = Array.isArray(op) ? op[0]?.numero : op?.numero
  avisos.unshift({
    campo: 'numero', severidad: 'error', codigo: 'CHEQUE_YA_ENTREGADO',
    mensaje: iguales.length > 0
      ? `El cheque N° ${propuesta.numero} ya figura entregado en la OP-${String(numOp ?? '').padStart(4, '0')}.`
      : `Un cheque N° ${corto} por el mismo importe ya figura entregado en la OP-${String(numOp ?? '').padStart(4, '0')}: casi seguro es éste.`,
    orden_ids: [...new Set(choques.map((c) => c.orden_id))],
  })
}
