/**
 * «Archivo primero» (20260924u): subir la factura, leerla y proponer la carga.
 *
 * Flujo:
 *   1. POST /facturas/lectura/upload-url → signed URL a `facturas/lecturas/<uuid>.<ext>`
 *      (la factura todavía no existe, como el comprobante de una OP).
 *   2. El navegador sube el archivo y, si puede, decodifica el QR de ARCA.
 *   3. POST /facturas/leer { storage_path, qr_texto } → propuesta + avisos,
 *      SIN crear la factura. Lo leído se guarda en `pagos_facturas_lecturas`
 *      para que, al cargar, la factura tome su lectura de ahí y no de lo que
 *      diga el navegador.
 *   4. POST /facturas con `lectura_id`: la factura se crea con lo que la
 *      persona dejó en el formulario, el archivo pasa a `facturas/<id>/` como
 *      adjunto y el control del papel sale de la lectura (sin volver a
 *      llamar al modelo).
 *
 * ¿Por qué el QR se decodifica en el NAVEGADOR y no acá? Para sacar el QR de
 * un PDF hay que rasterizar la página. En Node eso pide pdfjs + un canvas
 * nativo (@napi-rs/canvas o node-canvas): binarios por plataforma que en
 * Render son un riesgo de build y de memoria (el plan es chico), y el día que
 * fallen se cae la lectura entera. El navegador ya tiene canvas: pdfjs dibuja
 * la primera página, jsQR la barre y acá llega sólo el texto del QR, que se
 * valida y se decodifica en `parsearQrArca`. Si el navegador no lo encuentra,
 * la lectura sigue con la IA y avisa.
 */
import { randomUUID } from 'node:crypto'
import { supabase } from '../../lib/supabase.js'
import { PagosHttpError } from './pagos.errors.js'
import { BUCKET, sha256OfBlob, extFromMime, borrarDelBucket } from './adjuntos.service.js'
import { MAX_ADJUNTO_BYTES, MIME_PERMITIDOS, PREFIJO_LECTURA, type LeerFacturaDto } from './pagos.schema.js'
import { hoyAR, normNumeroFactura } from './pagos.util.js'
import { parsearQrArca, type QrArca } from './lectura/arca.js'
import { leerFacturaConIA, type ConceptoOfrecido, type ResultadoIA } from './lectura/ia.js'
import { avisoLetraCondicion } from './condicion-iva.js'
import { fusionar, controlesDeContexto, type AvisoLectura, type Propuesta, type TributoPropuesto } from './lectura/fusion.js'
import { jurisdiccionesService } from '../catalogos/catalogos.service.js'

const MIME_SET = new Set<string>(MIME_PERMITIDOS)

/** Una aplicación propuesta: la NC menciona esta factura y la factura tiene saldo pagable. */
export interface AplicacionSugerida {
  factura_id: number
  monto: number
  tipo_comprobante: string
  numero: string | null
  saldo_pagable: number
}

/**
 * NC leída → a qué facturas abiertas del proveedor acredita (20260925a). Cruza
 * los comprobantes asociados del papel contra `numero_norm` de las facturas
 * (clase factura, no anuladas) del proveedor, y reparte el total de la NC en
 * el orden del papel con tope en `saldo_pagable`. Es una SUGERENCIA: la
 * persona la ve y la confirma en el formulario; lo que no se encuentra avisa.
 */
export async function sugerirAplicaA(proveedorId: number, p: Propuesta): Promise<{ aplica_a: AplicacionSugerida[]; avisos: AvisoLectura[] }> {
  const asociados = p.comprobantes_asociados ?? []
  const avisos: AvisoLectura[] = []
  if (asociados.length === 0) {
    avisos.push({ campo: 'aplica_a', severidad: 'info', codigo: 'NC_SIN_ASOCIADOS',
      mensaje: 'La nota de crédito no dice a qué factura se refiere: elegila a mano o dejala como crédito a favor.' })
    return { aplica_a: [], avisos }
  }
  const normas = [...new Set(asociados.map((a) => normNumeroFactura(`${a.punto_venta ?? ''}-${a.numero ?? ''}`)).filter((x): x is string => !!x))]
  const { data } = await supabase.from('v_pagos_facturas')
    .select('id, tipo_comprobante, numero, numero_norm, estado, saldo_pagable')
    .eq('proveedor_id', proveedorId).eq('clase', 'factura').neq('estado', 'anulada')
    .in('numero_norm', normas).limit(50)
  const facturas = (data ?? []) as { id: number; tipo_comprobante: string; numero: string | null; numero_norm: string; estado: string; saldo_pagable: number | string | null }[]
  let resto = Math.round(Number(p.total ?? 0) * 100)
  const out: AplicacionSugerida[] = []
  for (const a of asociados) {
    const norm = normNumeroFactura(`${a.punto_venta ?? ''}-${a.numero ?? ''}`)
    const etiqueta = `${a.letra ?? ''} ${a.punto_venta ?? ''}-${a.numero ?? ''}`.trim()
    const candidatas = facturas.filter((f) => f.numero_norm === norm && (!a.letra || !['A', 'B', 'C'].includes(a.letra) || f.tipo_comprobante === a.letra))
    const f = candidatas[0]
    if (!f) {
      avisos.push({ campo: 'aplica_a', severidad: 'advertencia', codigo: 'NC_ASOCIADO_NO_ENCONTRADO',
        mensaje: `La NC menciona la factura ${etiqueta}, que no está cargada para este proveedor.` })
      continue
    }
    if (out.some((x) => x.factura_id === f.id)) continue
    const pagable = Math.round(Number(f.saldo_pagable ?? 0) * 100)
    if (pagable <= 0) {
      avisos.push({ campo: 'aplica_a', severidad: 'advertencia', codigo: 'NC_ASOCIADO_SIN_SALDO',
        mensaje: `La factura ${etiqueta} (#${f.id}, ${f.estado}) no tiene saldo para acreditar: lo que corresponda queda como crédito a favor.` })
      continue
    }
    if (resto <= 0) break
    const monto = Math.min(resto, pagable)
    resto -= monto
    out.push({ factura_id: f.id, monto: monto / 100, tipo_comprobante: f.tipo_comprobante, numero: f.numero, saldo_pagable: pagable / 100 })
  }
  if (out.length && resto > 0) {
    avisos.push({ campo: 'aplica_a', severidad: 'info', codigo: 'NC_SOBRANTE',
      mensaje: `La NC supera el saldo de las facturas que menciona: $${(resto / 100).toFixed(2)} quedan como crédito a favor.` })
  }
  return { aplica_a: out, avisos }
}

export interface LecturaGuardada {
  id: number
  storage_path: string
  nombre_archivo: string
  mime_type: string
  hash_sha256: string
  qr: QrArca | null
  ia: unknown
  propuesta: Propuesta
  avisos: AvisoLectura[]
  fuente_por_campo: Record<string, string>
  estado: 'manual' | 'qr' | 'qr+ia' | 'ia'
  modelo: string | null
  factura_id: number | null
  created_by: string | null
}

function validarPath(path: string) {
  if (!path.startsWith(PREFIJO_LECTURA) || path.includes('..')) {
    throw new PagosHttpError(400, 'PATH_INVALIDO', { storage_path: path })
  }
}

/**
 * Los conceptos activos, en el orden de la pantalla, para ofrecérselos a la
 * IA. Si la consulta falla la lectura sigue sin sugerencia: nunca se cae una
 * lectura por esto.
 */
export async function conceptosActivos(): Promise<ConceptoOfrecido[]> {
  const { data, error } = await supabase.from('pagos_conceptos').select('id, nombre')
    .eq('activo', true).order('orden', { ascending: true, nullsFirst: false }).order('id')
  if (error || !Array.isArray(data)) return []
  return (data as { id: number; nombre: string }[]).map((c) => ({ id: Number(c.id), nombre: c.nombre }))
}

/** Lo que devolvió la IA, sólo si es uno de los conceptos ofrecidos. */
export function conceptoSugerido(ia: ResultadoIA, conceptos: readonly ConceptoOfrecido[]): { id: number; nombre: string } | null {
  if (!ia.ok || ia.lectura.concepto_id == null) return null
  return conceptos.find((c) => c.id === ia.lectura.concepto_id) ?? null
}

/**
 * La jurisdicción que leyó la IA («TUCUMAN», «Pcia. de Tucumán»…) → id del
 * catálogo (20260929f), con el nombre canónico. Si no resuelve sin
 * ambigüedad, queda el texto con id null: al guardar, la base intenta de
 * nuevo y, si tampoco, el asiento cae al mapeo por tipo. Nunca falla.
 */
export async function resolverJurisdiccionesTributos(tributos: TributoPropuesto[] | null | undefined): Promise<void> {
  if (!tributos?.length || !tributos.some((t) => t.jurisdiccion)) return
  for (const t of tributos) {
    const j = await jurisdiccionesService.resolver(t.jurisdiccion)
    t.jurisdiccion_id = j?.id ?? null
    if (j) t.jurisdiccion = j.nombre
  }
}

/**
 * Lo común de las dos lecturas (archivo nuevo y adjunto ya guardado): QR que
 * mandó el navegador + IA + fusión. Nunca falla por la IA: sin key o con la
 * API caída devuelve lo del QR (o nada) y avisa.
 */
export async function analizarComprobante(buffer: Buffer, mime: string, qrTexto: string | null) {
  const qr = parsearQrArca(qrTexto)
  const qrIlegible = !!qrTexto && !qr
  const conceptos = await conceptosActivos()
  const ia: ResultadoIA = await leerFacturaConIA(buffer, mime, conceptos)
  const fusion = fusionar(qr, ia.ok ? ia.lectura : null, { hoy: hoyAR() })
  const concepto = conceptoSugerido(ia, conceptos)
  fusion.propuesta.concepto_id_sugerido = concepto?.id ?? null
  fusion.propuesta.concepto_sugerido = concepto?.nombre ?? null
  await resolverJurisdiccionesTributos(fusion.propuesta.tributos)
  if (qrIlegible) {
    fusion.avisos.push({ campo: 'qr', severidad: 'advertencia', codigo: 'QR_NO_ES_DE_ARCA',
      mensaje: 'El QR del comprobante no es un QR de factura de ARCA válido: se usó sólo la lectura del papel.' })
  }
  if (!ia.ok && ia.motivo !== 'SIN_API_KEY') {
    fusion.avisos.push({ campo: 'ia', severidad: 'advertencia', codigo: 'IA_FALLO',
      mensaje: `No se pudo leer el detalle del comprobante (${ia.motivo}).` })
  }
  return { qr, ia, fusion }
}

export const lecturaService = {

  /** Paso 1: dónde subir el archivo antes de que exista la factura. */
  async uploadUrl(dto: { nombre_archivo: string; mime_type: string; size_bytes: number }) {
    if (!MIME_SET.has(dto.mime_type)) throw new PagosHttpError(400, 'MIME_NO_PERMITIDO', { mime: dto.mime_type })
    if (dto.size_bytes <= 0 || dto.size_bytes > MAX_ADJUNTO_BYTES) {
      throw new PagosHttpError(400, 'TAMANO_INVALIDO', { size: dto.size_bytes, max: MAX_ADJUNTO_BYTES })
    }
    const path = `${PREFIJO_LECTURA}${randomUUID()}.${extFromMime(dto.mime_type)}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) throw new PagosHttpError(500, 'UPLOAD_URL_ERROR', error.message)
    return { storage_path: path, signed_url: data.signedUrl, token: data.token }
  },

  /** Se cerró el modal sin cargar: el archivo y su lectura se van. */
  async descartar(storagePath: string) {
    validarPath(storagePath)
    await supabase.from('pagos_facturas_lecturas').delete().eq('storage_path', storagePath).is('factura_id', null)
    await borrarDelBucket([storagePath])
    return { success: true }
  },

  /**
   * Paso 3: leer. No crea la factura; sí guarda la lectura. Nunca falla por
   * la IA: sin key o con la API caída devuelve lo del QR (o nada) y avisa.
   */
  async leer(dto: LeerFacturaDto, userId: string) {
    validarPath(dto.storage_path)
    const dl = await supabase.storage.from(BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) throw new PagosHttpError(400, 'ARCHIVO_NO_SUBIDO', { storage_path: dto.storage_path })
    const hash = await sha256OfBlob(dl.data)
    const { qr, ia, fusion } = await analizarComprobante(Buffer.from(await dl.data.arrayBuffer()), dto.mime_type, dto.qr_texto ?? null)
    const p = fusion.propuesta

    // Contexto: proveedor por CUIT, factura repetida, archivo repetido.
    const [prov, adjRep] = await Promise.all([
      p.emisor_cuit
        ? supabase.from('pagos_proveedores').select('id, razon_social, activo, condicion_iva_id').eq('cuit', p.emisor_cuit).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('pagos_facturas_adjuntos').select('factura_id')
        .eq('hash_sha256', hash).eq('tipo', 'factura').is('deleted_at', null).limit(1).maybeSingle(),
    ])
    const proveedor = (prov.data as { id: number; razon_social: string; activo: boolean; condicion_iva_id?: number | null } | null) ?? null
    let duplicadas: { id: number; numero: string | null; estado: string }[] = []
    if (proveedor && p.tipo_comprobante && p.numero_comprobante) {
      const norm = normNumeroFactura(`${p.punto_venta ?? ''}-${p.numero_comprobante}`)
      // Por clase, igual que el índice único (20260925a): la NC 0001-00000045
      // no choca con la factura 0001-00000045 del mismo proveedor.
      const { data } = await supabase.from('pagos_facturas').select('id, numero, estado')
        .eq('proveedor_id', proveedor.id).eq('clase', p.clase).eq('tipo_comprobante', p.tipo_comprobante)
        .eq('numero_norm', norm).neq('estado', 'anulada').limit(3)
      duplicadas = (data ?? []) as typeof duplicadas
    }
    const sugerencia = proveedor && p.clase === 'nota_credito'
      ? await sugerirAplicaA(proveedor.id, p)
      : { aplica_a: [] as AplicacionSugerida[], avisos: [] as AvisoLectura[] }
    const avisos = [
      ...sugerencia.avisos,
      ...controlesDeContexto(p, {
        proveedor, duplicadas,
        archivoRepetido: adjRep.data ? { factura_id: (adjRep.data as { factura_id: number }).factura_id } : null,
      }),
      ...fusion.avisos,
    ]
    // Letra vs condición frente al IVA del proveedor (20260925o). NO bloquea.
    const letra = proveedor ? avisoLetraCondicion(proveedor.condicion_iva_id, p.tipo_comprobante) : null
    if (letra) {
      avisos.push({
        campo: 'tipo_comprobante', severidad: 'advertencia', codigo: letra.code, mensaje: letra.mensaje,
        code: letra.code, condicion: letra.condicion, condicion_nombre: letra.condicion_nombre, letra: letra.letra,
      })
    }

    const fila = {
      storage_path: dto.storage_path,
      nombre_archivo: dto.nombre_archivo,
      mime_type: dto.mime_type,
      hash_sha256: hash,
      qr,
      ia: ia.ok ? ia.lectura : { error: ia.motivo },
      propuesta: p,
      avisos,
      fuente_por_campo: fusion.fuente_por_campo,
      estado: fusion.estado,
      modelo: ia.modelo,
      created_by: userId,
      factura_id: null,
    }
    const { data: guardada, error } = await supabase
      .from('pagos_facturas_lecturas').upsert(fila, { onConflict: 'storage_path' }).select('id').single()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)

    const orden = { error: 0, advertencia: 1, info: 2 } as const
    return {
      lectura_id: (guardada as { id: number }).id,
      estado: fusion.estado,
      modelo: ia.modelo,
      propuesta: {
        ...p,
        proveedor_id: proveedor?.activo ? proveedor.id : null,
        proveedor_nombre: proveedor?.razon_social ?? null,
        // Alta propuesta: lo que se leyó, para precargar el alta rápida.
        proveedor_nuevo: !proveedor && p.emisor_cuit
          ? { razon_social: p.emisor_razon_social, cuit: p.emisor_cuit } : null,
        aplica_a_sugerida: sugerencia.aplica_a,
      },
      // También arriba, para quien no mire dentro de la propuesta.
      aplica_a_sugerida: sugerencia.aplica_a,
      fuente_por_campo: fusion.fuente_por_campo,
      avisos: avisos.sort((a, b) => orden[a.severidad] - orden[b.severidad]),
    }
  },

  /** La lectura para cargar la factura: tiene que existir y no estar usada. */
  async tomar(lecturaId: number): Promise<LecturaGuardada> {
    const { data, error } = await supabase.from('pagos_facturas_lecturas').select('*').eq('id', lecturaId).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'LECTURA_NO_EXISTE', { campo: 'lectura_id' })
    const l = data as LecturaGuardada
    if (l.factura_id != null) throw new PagosHttpError(409, 'LECTURA_YA_USADA', { factura_id: l.factura_id })
    return l
  },
}

/**
 * Qué campos de la propuesta cambió la persona antes de guardar. Va a
 * `lectura_json.editados`: es lo que permite medir, con el tiempo, qué lee
 * bien la lectura y qué no.
 */
export function camposEditados(p: Propuesta, final: {
  numero: string; fecha: string; total: number; tipo_comprobante: string; vence_el?: string | null
  neto?: number | null; no_gravado?: number | null; exento?: number | null; cae?: string | null
  iva?: { alicuota_id: number; base_imp: number; importe: number }[] | null
  tributos?: { tipo: string; importe: number }[] | null
  concepto_id?: number | null
}): string[] {
  const out: string[] = []
  const numProp = normNumeroFactura(`${p.punto_venta ?? ''}-${p.numero_comprobante ?? ''}`)
  if (p.numero_comprobante && numProp !== normNumeroFactura(final.numero)) out.push('numero')
  if (p.fecha && p.fecha !== final.fecha) out.push('fecha')
  if (p.total != null && Math.abs(p.total - final.total) > 0.005) out.push('total')
  if (p.tipo_comprobante && p.tipo_comprobante !== final.tipo_comprobante) out.push('tipo_comprobante')
  if (p.vence_el && final.vence_el !== undefined && p.vence_el !== final.vence_el) out.push('vence_el')
  if (p.cae && final.cae !== undefined && p.cae !== final.cae) out.push('cae')
  const n = (v: number | null | undefined) => Math.round(Number(v ?? 0) * 100)
  if (final.neto !== undefined && n(p.neto) !== n(final.neto)) out.push('neto')
  if (final.no_gravado !== undefined && n(p.no_gravado) !== n(final.no_gravado)) out.push('no_gravado')
  if (final.exento !== undefined && n(p.exento) !== n(final.exento)) out.push('exento')
  const firmaIva = (xs: { alicuota_id: number; base_imp: number; importe: number }[]) =>
    xs.map((x) => `${x.alicuota_id}:${n(x.base_imp)}:${n(x.importe)}`).sort().join('|')
  if (final.iva && firmaIva(p.iva) !== firmaIva(final.iva)) out.push('iva')
  const firmaTrib = (xs: { tipo: string; importe: number }[]) => xs.map((x) => `${x.tipo}:${n(x.importe)}`).sort().join('|')
  if (final.tributos && firmaTrib(p.tributos) !== firmaTrib(final.tributos)) out.push('tributos')
  if (p.concepto_id_sugerido != null && final.concepto_id !== undefined && p.concepto_id_sugerido !== final.concepto_id) out.push('concepto_id')
  return out
}
