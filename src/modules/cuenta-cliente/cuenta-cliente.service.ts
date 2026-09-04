// Cuenta corriente de obras sobre `materiales_a_cuenta_cliente` (MCC): el
// listado de qué salió a cada obra y quién lo paga.
//
// `pagado_por` distingue quién le pagó al proveedor ('cadinc' adelantó, o
// 'cliente' pagó directo: rendición) y `a_cargo_de` (20260904ak) de quién es
// el gasto ('cliente' se cobra, 'cadinc' llave en mano o EPP). La vista
// v_cuenta_corriente los combina en UN estado por renglón (20260904ap).
//
// Cobros con imputación (2026-07-21): cada fila MCC puede quedar vinculada a
// UN cobro (cobro_id + monto_cobrado congelado). El registro/eliminación van
// por RPCs transaccionales (registrar_cobro_cuenta_cliente /
// eliminar_cobro_cuenta_cliente) — SECURITY DEFINER, SIEMPRE con supabaseAdmin
// (CLAUDE.md §9); el scope de obra se valida en las routes ANTES de llamarlas.

import { createHash, randomUUID } from 'node:crypto'
import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import type { CrearCobroDto, EditarCobroDto } from './cuenta-cliente.schema.js'
import { normTxt } from '../../lib/norm-txt.js'

const BUCKET_COBROS = 'cobros-docs'

export class CcHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'CcHttpError'
  }
}

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png')  return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

function pathForUploadCobro(contentType: string): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `cuenta-cliente/${yyyy}/${mm}/${randomUUID()}.${extFromMime(contentType)}`
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

// Pagina de a 1000 (hard cap de PostgREST que NO se bypassea con .range
// grande — CLAUDE.md §5.7). El MCC ya está en ~1000 filas totales: sin esto
// los KPIs del frontend se truncarían en silencio.
async function fetchAllMcc(buildQuery: (from: number, to: number) => any) {
  const PAGE = 1000
  const all: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return all
}

/**
 * Filtros de la cuenta corriente (20260904ap). Los mismos alimentan el listado
 * paginado (PostgREST sobre v_cuenta_corriente) y el resumen (RPC).
 */
export interface CuentaFiltro {
  obra_cod?:     string
  estados?:      string[]
  tipo?:         'material' | 'epp'
  sin_precio?:   boolean
  proveedor_id?: number
  origen?:       'proveedor' | 'deposito'
  desde?:        string
  hasta?:        string
  q?:            string
  archivadas?:   boolean
}

// Palabras del buscador normalizadas igual que `busq` en la vista (norm_txt):
// sin acentos ni signos, así "#634" busca "634" y "cañería" busca "caneria".
function palabras(q?: string): string[] {
  return normTxt(q ?? '').split(' ').filter(Boolean)
}

export const cuentaClienteService = {
  // ── Cuenta corriente (20260904ap) ────────────────────────────────────

  /**
   * Renglones de la cuenta corriente, paginados y filtrados en el server.
   * `allowed` null = alcance global (no se filtra por obra).
   */
  async getRenglones(allowed: string[] | null, f: CuentaFiltro, limit: number, offset: number, token: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase.from('v_cuenta_corriente').select('*', { count: 'exact' })
    if (allowed) q = q.in('obra_cod', allowed)
    if (f.obra_cod) q = q.eq('obra_cod', f.obra_cod)
    else if (!f.archivadas) q = q.eq('obra_archivada', false)
    if (f.estados?.length) q = q.in('estado', f.estados)
    if (f.tipo) q = q.eq('tipo', f.tipo)
    if (f.sin_precio) q = q.eq('precio_unit', 0)
    if (f.proveedor_id) q = q.eq('proveedor_id', f.proveedor_id)
    if (f.origen) q = q.eq('origen', f.origen)
    if (f.desde) q = q.gte('fecha_resolucion', f.desde)
    if (f.hasta) q = q.lte('fecha_resolucion', f.hasta)
    for (const w of palabras(f.q)) q = q.ilike('busq', `%${w}%`)
    const { data, error, count } = await q
      .order('fecha_resolucion', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw new Error(error.message)
    return { items: data ?? [], total: count ?? 0, limit, offset }
  },

  /**
   * Totales del conjunto filtrado por grupo (obra | mes | proveedor) × estado
   * × tipo, más Σ pagos por obra. A propósito NO filtra por estado ni tipo:
   * el frontend recorta esas dos dimensiones sobre el resultado, así los chips
   * muestran cuánto hay en cada una con los demás filtros puestos.
   */
  async getResumen(allowed: string[] | null, f: CuentaFiltro, grupo: 'obra' | 'mes' | 'proveedor', token: string) {
    const supabase = createSupabaseClient(token)
    const pal = palabras(f.q)
    const [g, p] = await Promise.all([
      supabase.rpc('cuenta_corriente_resumen', {
        p_obras:        allowed,
        p_obra_cod:     f.obra_cod ?? null,
        p_grupo:        grupo,
        p_sin_precio:   !!f.sin_precio,
        p_proveedor_id: f.proveedor_id ?? null,
        p_origen:       f.origen ?? null,
        p_desde:        f.desde ?? null,
        p_hasta:        f.hasta ?? null,
        p_palabras:     pal.length ? pal : null,
        p_archivadas:   !!f.archivadas,
      }),
      supabase.rpc('cuenta_corriente_pagos', { p_obras: allowed, p_obra_cod: f.obra_cod ?? null }),
    ])
    if (g.error) throw new Error(g.error.message)
    if (p.error) throw new Error(p.error.message)
    return { grupos: g.data ?? [], pagos: p.data ?? [] }
  },

  /**
   * Conteo de materiales "sin precio" (precio_unit=0, a tasar) por obra, en
   * las obras dadas (null = todas, para admin). Sirve para que Alina/Nicolás
   * vean los pendientes de tasar sin recorrer obra por obra. Devuelve
   * [{ obra_cod, sin_precio }] ordenado de mayor a menor.
   */
  async pendientesDePrecio(obraCods: string[] | null, token: string) {
    const supabase = createSupabaseClient(token)
    // Vista agregada (una fila por obra) para no chocar con el cap de 1000 de
    // PostgREST si crece el backlog de ítems sin tasar (CLAUDE.md §5.7).
    const base = supabase.from('v_cuenta_cliente_pendientes').select('obra_cod, sin_precio')
    const { data, error } = obraCods != null ? await base.in('obra_cod', obraCods) : await base
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<{ obra_cod: string; sin_precio: number }>)
      .sort((a, b) => b.sin_precio - a.sin_precio)
  },

  // ── Cobros (pagos del cliente a cuenta de la obra) ───────────────────

  /** Cobros de una obra, más recientes primero. */
  async getCobros(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    return fetchAllMcc((from, to) => supabase
      .from('cuenta_cliente_cobros')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to))
  },

  /** Cobros de varias obras (para los KPIs de la vista "todas mis obras").
   *  Paginado igual que el MCC: sin esto el KPI Pagado agregado se truncaría
   *  en silencio al pasar 1000 cobros. */
  async getCobrosByObras(obraCods: string[], token: string) {
    if (obraCods.length === 0) return []
    const supabase = createSupabaseClient(token)
    return fetchAllMcc((from, to) => supabase
      .from('cuenta_cliente_cobros')
      .select('*')
      .in('obra_cod', obraCods)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to))
  },

  /** obra_cod de un cobro (para validar scope en PATCH/DELETE). null si no existe. */
  async getCobroObra(id: number, token: string): Promise<string | null> {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros').select('obra_cod').eq('id', id).maybeSingle()
    if (error) throw new Error(error.message)
    return data?.obra_cod ?? null
  },

  /**
   * Registra un cobro imputando (opcionalmente) items del MCC, vía RPC
   * transaccional con advisory lock por obra. Si vino comprobante, primero
   * se descarga del bucket para calcular el sha256 (dedup); si la RPC
   * rebota, el archivo huérfano se borra del bucket.
   */
  async crearCobro(dto: CrearCobroDto, _token: string, userId: string) {
    let comprobanteUrl: string | null = null
    let comprobanteHash: string | null = null
    if (dto.comprobante_path) {
      const dl = await supabaseAdmin.storage.from(BUCKET_COBROS).download(dto.comprobante_path)
      if (dl.error || !dl.data) {
        throw new CcHttpError(400, 'COMPROBANTE_INEXISTENTE', { path: dto.comprobante_path })
      }
      comprobanteUrl = dto.comprobante_path
      comprobanteHash = await sha256OfBlob(dl.data)
    }

    const { data, error } = await supabaseAdmin.rpc('registrar_cobro_cuenta_cliente', {
      p_obra_cod:         dto.obra_cod,
      p_fecha:            dto.fecha,
      p_monto:            dto.monto,
      p_medio:            dto.medio,
      p_obs:              dto.obs ?? null,
      p_comprobante_url:  comprobanteUrl,
      p_comprobante_hash: comprobanteHash,
      p_item_ids:         dto.item_ids ?? [],
      p_user_id:          userId,
    })
    if (error) {
      // La RPC rechazó: el comprobante recién subido queda huérfano → limpiar.
      if (comprobanteUrl) {
        await supabaseAdmin.storage.from(BUCKET_COBROS).remove([comprobanteUrl]).catch(() => undefined)
      }
      const msg = error.message || ''
      if (msg.includes('COMPROBANTE_DUPLICADO')) throw new CcHttpError(409, 'COMPROBANTE_DUPLICADO')
      if (msg.includes('ITEM_INVALIDO'))         throw new CcHttpError(400, 'ITEM_INVALIDO')
      if (msg.includes('MONTO_INSUFICIENTE'))    throw new CcHttpError(400, 'MONTO_INSUFICIENTE')
      throw new Error(msg)
    }
    return data
  },

  async editarCobro(id: number, dto: EditarCobroDto, token: string, userId: string) {
    // Si baja el monto, no puede quedar por debajo de lo imputado a items
    // (el snapshot monto_cobrado congelado al registrar).
    if (dto.monto !== undefined) {
      const { data: imputados, error: eImp } = await supabaseAdmin
        .from('materiales_a_cuenta_cliente')
        .select('monto_cobrado')
        .eq('cobro_id', id)
      if (eImp) throw new Error(eImp.message)
      const totalImputado = (imputados ?? []).reduce((s, m) => s + Number(m.monto_cobrado ?? 0), 0)
      if (dto.monto + 0.01 < totalImputado) {
        throw new CcHttpError(409, 'MONTO_MENOR_IMPUTADO', { monto: dto.monto, imputado: totalImputado })
      }
    }
    const supabase = createSupabaseClient(token)
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros')
      .update({ ...patch, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  /** Elimina el cobro vía RPC: desimputa los items (vuelven a adeudados) y borra. */
  async eliminarCobro(id: number, _token: string, userId: string) {
    // Path del comprobante ANTES de borrar, para limpiar el bucket después.
    const { data: cobro } = await supabaseAdmin
      .from('cuenta_cliente_cobros').select('comprobante_url').eq('id', id).maybeSingle()

    const { data, error } = await supabaseAdmin.rpc('eliminar_cobro_cuenta_cliente', {
      p_cobro_id: id,
      p_user_id:  userId,
    })
    if (error) {
      if ((error.message || '').includes('COBRO_NO_EXISTE')) throw new CcHttpError(404, 'COBRO_NO_EXISTE')
      throw new Error(error.message)
    }
    if (cobro?.comprobante_url) {
      await supabaseAdmin.storage.from(BUCKET_COBROS).remove([cobro.comprobante_url]).catch(() => undefined)
    }
    return data
  },

  // ── Comprobante (bucket privado cobros-docs, flujo signed URL 2 pasos) ──

  async firmarUploadComprobante(contentType: string) {
    const path = pathForUploadCobro(contentType)
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET_COBROS)
      .createSignedUploadUrl(path)
    if (error || !data) throw new CcHttpError(500, 'STORAGE_ERROR', error?.message)
    return { path, signedUrl: data.signedUrl, token: data.token, expiresIn: 300 }
  },

  async getComprobanteUrl(cobroId: number) {
    const { data: cobro, error } = await supabaseAdmin
      .from('cuenta_cliente_cobros').select('comprobante_url').eq('id', cobroId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!cobro?.comprobante_url) throw new CcHttpError(404, 'COMPROBANTE_NO_EXISTE')
    const { data, error: eSign } = await supabaseAdmin.storage
      .from(BUCKET_COBROS)
      .createSignedUrl(cobro.comprobante_url, 300)
    if (eSign || !data) throw new CcHttpError(500, 'STORAGE_ERROR', eSign?.message)
    return { url: data.signedUrl, expiresIn: 300 }
  },
}
