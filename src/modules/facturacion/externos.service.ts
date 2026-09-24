/**
 * Saldos iniciales de Cobranzas: comprobantes emitidos FUERA del ERP
 * (Finnegans, portal de ARCA) que siguen abiertos, y el libro de ventas
 * histórico jul–sep 2026 (`ventas_comprobantes_externos`, 20260924k/l).
 *
 *   - ABM directo desde el backend (la tabla no es de solo-RPC). Los triggers
 *     de la base frenan EXTERNO_DUPLICA_FACTURA_ERP, EXTERNO_CON_IMPUTACIONES
 *     y EXTERNO_SALDO_MENOR_QUE_IMPUTADO.
 *   - Importador: `ventas_importar_externos` (TODO O NADA). Acepta las filas
 *     del Excel «Mis Comprobantes — Emitidos» de ARCA tal cual (con sus
 *     encabezados) o ya con las claves de la RPC, o un CSV. Con
 *     `confirmar=false` es vista previa y no escribe nada.
 *   - Marcar (cobrada / impaga / revisar): `ventas_externos_marcar`.
 *
 * Los externos son siempre de ambiente 'prod'.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { rpc } from './comun.js'
import type {
  CreateExternoDto, ImportarExternosDto, ListExternosQuery, MarcarExternosDto, UpdateExternoDto,
} from './facturacion.schema.js'

type Celda = string | number | boolean | null
type Fila = Record<string, Celda>

/** tipo + letra → código de ARCA (para el alta manual sin código). */
export function cbteTipoDe(tipo: 'FC' | 'ND' | 'NC', letra: 'A' | 'B'): number {
  const t: Record<string, number> = { 'FC-A': 1, 'ND-A': 2, 'NC-A': 3, 'FC-B': 6, 'ND-B': 7, 'NC-B': 8 }
  return t[`${tipo}-${letra}`]!
}

// ── Normalización de filas del importador ───────────────────────────────────

/** Encabezado normalizado del Excel de ARCA (o de un CSV) → clave de la RPC. */
const ALIAS_COLUMNAS: Record<string, string> = {
  'fecha': 'fecha', 'fecha de emision': 'fecha', 'fecha emision': 'fecha',
  'tipo': 'cbte_tipo', 'tipo de comprobante': 'cbte_tipo', 'cbte tipo': 'cbte_tipo', 'cbte_tipo': 'cbte_tipo',
  'punto de venta': 'pto_vta', 'pto vta': 'pto_vta', 'pto_vta': 'pto_vta', 'pv': 'pto_vta',
  'numero desde': 'numero', 'numero': 'numero', 'nro': 'numero', 'numero_desde': 'numero',
  'numero hasta': '_numero_hasta',
  'tipo doc. comprador': 'rec_doc_tipo', 'tipo doc comprador': 'rec_doc_tipo', 'rec_doc_tipo': 'rec_doc_tipo',
  'nro. doc. comprador': 'rec_doc_nro', 'nro doc comprador': 'rec_doc_nro', 'rec_doc_nro': 'rec_doc_nro',
  'cuit': 'rec_doc_nro', 'cliente cuit': 'rec_doc_nro', 'cuit cliente': 'rec_doc_nro',
  'denominacion comprador': 'rec_razon_social', 'rec_razon_social': 'rec_razon_social', 'razon social': 'rec_razon_social',
  'cliente': 'rec_razon_social',
  'tipo cambio': 'tipo_cambio', 'tipo_cambio': 'tipo_cambio', 'moneda': 'moneda',
  'neto gravado': 'neto', 'neto': 'neto', 'imp. neto gravado': 'neto',
  'no gravado': 'no_gravado', 'no_gravado': 'no_gravado', 'imp. neto no gravado': 'no_gravado',
  'exento': 'exento', 'imp. op. exentas': 'exento', 'iva': 'iva',
  'total': 'total', 'imp. total': 'total',
  'saldo': 'saldo', 'saldo inicial': 'saldo', 'saldo_inicial': 'saldo',
  'vencimiento': 'vence_el', 'vence': 'vence_el', 'vence_el': 'vence_el', 'fecha de vencimiento': 'vence_el',
  'obs': 'obs', 'observaciones': 'obs',
}

const claveCol = (h: string) => normTxt(h).replace(/\s+/g, ' ').trim()

/** Excel: número de serie de fecha (días desde 1899-12-30) → YYYY-MM-DD. */
function fechaDeSerie(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000)
  return new Date(ms).toISOString().slice(0, 10)
}

function normFecha(v: Celda): Celda {
  if (typeof v === 'number' && v > 20000 && v < 80000) return fechaDeSerie(v)
  if (typeof v === 'string') {
    const s = v.trim()
    const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
    if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
    return s
  }
  return v
}

/**
 * Importe en texto: acepta "1.218.409,50" (AR), "1218409.50" y "$ 1.234".
 * Los números ya vienen bien.
 */
export function normImporte(v: Celda): Celda {
  if (v == null || typeof v === 'number') return v
  let s = String(v).replace(/[$\s]/g, '')
  if (!s) return null
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  else if (s.includes(',')) s = s.replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : String(v)
}

function normMoneda(v: Celda): Celda {
  if (v == null) return v
  const s = String(v).trim().toUpperCase()
  if (s === '$' || s === 'ARS' || s === 'PESOS' || s === '') return 'PES'
  if (s === 'USD' || s === 'U$S' || s === 'US$' || s === 'DOLARES' || s === 'DÓLARES') return 'DOL'
  return s
}

/** Una fila (Excel de ARCA, CSV o claves de la RPC) → forma de `ventas_importar_externos`. */
export function normalizarFila(f: Fila): Fila {
  const out: Fila = {}
  for (const [k, v] of Object.entries(f)) {
    const clave = ALIAS_COLUMNAS[claveCol(k)] ?? k
    if (clave.startsWith('_')) continue
    if (out[clave] != null && out[clave] !== '' && (v == null || v === '')) continue
    out[clave] = typeof v === 'string' ? v.trim() : v
  }
  if ('fecha' in out) out.fecha = normFecha(out.fecha ?? null)
  if ('vence_el' in out) out.vence_el = out.vence_el === '' ? null : normFecha(out.vence_el ?? null)
  for (const k of ['neto', 'no_gravado', 'exento', 'iva', 'total', 'tipo_cambio']) if (k in out) out[k] = normImporte(out[k] ?? null)
  if ('saldo' in out) out.saldo = out.saldo === '' || out.saldo == null ? null : normImporte(out.saldo)
  if ('moneda' in out) out.moneda = normMoneda(out.moneda ?? null)
  if (typeof out.rec_doc_nro === 'number') out.rec_doc_nro = String(Math.round(out.rec_doc_nro))
  for (const k of ['pto_vta', 'numero']) if (typeof out[k] === 'number') out[k] = String(Math.round(out[k] as number))
  return out
}

/** CSV con encabezado; separador `,` `;` o tab (el que más aparezca en la 1ª línea). Soporta comillas. */
export function parsearCsv(csv: string): Fila[] {
  const texto = csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const primera = texto.slice(0, texto.indexOf('\n') === -1 ? texto.length : texto.indexOf('\n'))
  const sep = [';', '\t', ','].map((s) => ({ s, n: primera.split(s).length })).sort((a, b) => b.n - a.n)[0]!.s
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ''
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++ } else if (ch === '"') comillas = false
      else campo += ch
    } else if (ch === '"') comillas = true
    else if (ch === sep) { fila.push(campo); campo = '' }
    else if (ch === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = '' }
    else campo += ch
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila) }
  const utiles = filas.filter((r) => r.some((c) => c.trim() !== ''))
  // El Excel de ARCA exportado a CSV trae una fila de título antes del encabezado.
  const iHdr = utiles.findIndex((r) => r.some((c) => ['tipo', 'cbte_tipo', 'tipo de comprobante'].includes(claveCol(c))))
  if (iHdr < 0) return []
  const hdr = utiles[iHdr]!
  return utiles.slice(iHdr + 1).map((r) => Object.fromEntries(hdr.map((h, i) => [h.trim(), r[i] ?? null])))
}

// ── Service ─────────────────────────────────────────────────────────────────

const lista = (csv?: string) => (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const esSi = (v?: string) => v === '1' || v === 'true'

function errorEscritura(error: PgError): FacturacionHttpError {
  if (error.code === '23505') return new FacturacionHttpError(409, 'EXTERNO_DUPLICADO', { campo: 'numero' })
  if (error.code === '23514') return new FacturacionHttpError(400, 'EXTERNO_INVALIDO', { dbMessage: error.message })
  if (error.code === '23503') return new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { campo: 'cliente_id' })
  return mapRpcError(error)
}

async function clienteDe(db: SupabaseClient, id: number): Promise<{ id: number; razon_social: string; doc_tipo: number; doc_nro: string; plazo_pago_dias: number }> {
  const { data, error } = await db.from('ventas_clientes').select('id, razon_social, doc_tipo, doc_nro, plazo_pago_dias').eq('id', id).maybeSingle()
  if (error) throw mapRpcError(error as PgError)
  if (!data) throw new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { campo: 'cliente_id', cliente_id: id })
  return data as { id: number; razon_social: string; doc_tipo: number; doc_nro: string; plazo_pago_dias: number }
}

function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

const sinBusq = (r: Record<string, unknown>) => {
  const { busq: _b, ...resto } = r
  return resto
}

export const externosService = {
  async listar(q: ListExternosQuery, db: SupabaseClient = supabase): Promise<{ rows: unknown[]; total: number }> {
    const page = q.page ?? 1
    const pageSize = q.pageSize ?? 100
    let s = db.from('v_ventas_externos').select('*', { count: 'exact' })
    if (q.cliente_id) s = s.eq('cliente_id', q.cliente_id)
    const tipos = lista(q.cbte_tipo).map(Number).filter(Number.isInteger)
    if (tipos.length) s = s.in('cbte_tipo', tipos)
    if (q.tipo) s = s.eq('tipo', q.tipo)
    if (q.a_revisar !== undefined) s = s.eq('saldo_a_revisar', esSi(q.a_revisar))
    if (esSi(q.con_saldo)) s = s.gt('saldo', 0)
    if (q.origen) s = s.eq('origen', q.origen)
    if (q.desde) s = s.gte('fecha', q.desde)
    if (q.hasta) s = s.lte('fecha', q.hasta)
    const t = normTxt(q.q ?? '')
    if (t) for (const w of t.split(/\s+/).filter(Boolean).slice(0, 6)) s = s.ilike('busq', `%${w}%`)
    const { data, error, count } = await s
      .order('fecha', { ascending: false }).order('cbte_tipo').order('pto_vta').order('numero', { ascending: false }).order('id')
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error) throw mapRpcError(error as PgError)
    return { rows: (data ?? []).map((r) => sinBusq(r as Record<string, unknown>)), total: count ?? 0 }
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<{ externo: unknown; imputaciones: unknown[] }> {
    const { data, error } = await db.from('v_ventas_externos').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new FacturacionHttpError(404, 'EXTERNO_NO_EXISTE', { externo_id: id })
    const { data: imps, error: e2 } = await db.from('v_ventas_imputaciones').select('*')
      .or(`externo_id.eq.${id},nc_externo_id.eq.${id}`).order('fecha').order('id')
    if (e2) throw mapRpcError(e2 as PgError)
    return { externo: sinBusq(data as Record<string, unknown>), imputaciones: imps ?? [] }
  },

  async crear(dto: CreateExternoDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const cli = await clienteDe(db, dto.cliente_id)
    const cbteTipo = dto.cbte_tipo ?? cbteTipoDe(dto.tipo!, dto.letra!)
    const saldo = dto.saldo_inicial ?? dto.total
    if (saldo > dto.total) throw new FacturacionHttpError(400, 'SALDO_INVALIDO', { campo: 'saldo_inicial', saldo, total: dto.total })
    const vence = dto.vence_el ?? sumarDias(dto.fecha, cli.plazo_pago_dias ?? 30)
    if (vence < dto.fecha) throw new FacturacionHttpError(400, 'VENCE_ANTERIOR_A_FECHA', { campo: 'vence_el', vence_el: vence, fecha: dto.fecha })
    const revisar = dto.saldo_a_revisar ?? false
    const { data, error } = await db.from('ventas_comprobantes_externos').insert({
      cliente_id: cli.id, cbte_tipo: cbteTipo, pto_vta: dto.pto_vta, numero: dto.numero,
      fecha: dto.fecha, vence_el: vence,
      neto: dto.neto ?? 0, no_gravado: dto.no_gravado ?? 0, exento: dto.exento ?? 0, iva: dto.iva ?? 0, total: dto.total,
      rec_doc_tipo: cli.doc_tipo, rec_doc_nro: cli.doc_nro, rec_razon_social: cli.razon_social,
      saldo_inicial: saldo, saldo_a_revisar: revisar,
      saldo_motivo: dto.saldo_motivo ?? (revisar ? '' : 'carga manual'),
      saldo_confirmado_por: revisar ? null : userId, saldo_confirmado_el: revisar ? null : new Date().toISOString(),
      origen: dto.origen ?? 'finnegans', obs: dto.obs ?? '', created_by: userId, updated_by: userId,
    }).select('id').single()
    if (error) throw errorEscritura(error as PgError)
    const id = Number((data as { id: number }).id)
    return (await this.detalle(id, db)).externo
  },

  async editar(id: number, dto: UpdateExternoDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const { data: act, error: e0 } = await db.from('ventas_comprobantes_externos').select('id, cliente_id, fecha, total, saldo_inicial').eq('id', id).maybeSingle()
    if (e0) throw mapRpcError(e0 as PgError)
    if (!act) throw new FacturacionHttpError(404, 'EXTERNO_NO_EXISTE', { externo_id: id })
    const cambios: Record<string, unknown> = { updated_by: userId }
    for (const k of ['cbte_tipo', 'pto_vta', 'numero', 'fecha', 'vence_el', 'neto', 'no_gravado', 'exento', 'iva', 'total', 'origen'] as const) {
      if (dto[k] !== undefined) cambios[k] = dto[k]
    }
    if (dto.obs !== undefined) cambios.obs = dto.obs ?? ''
    if (dto.cliente_id !== undefined && dto.cliente_id !== (act as { cliente_id: number }).cliente_id) {
      const cli = await clienteDe(db, dto.cliente_id)
      Object.assign(cambios, { cliente_id: cli.id, rec_doc_tipo: cli.doc_tipo, rec_doc_nro: cli.doc_nro, rec_razon_social: cli.razon_social })
    }
    // Tocar el saldo a mano es confirmarlo: sale de «a revisar» y queda firmado.
    if (dto.saldo_inicial !== undefined) {
      const total = Number(dto.total ?? (act as { total: number }).total)
      if (dto.saldo_inicial > total) throw new FacturacionHttpError(400, 'SALDO_INVALIDO', { campo: 'saldo_inicial', saldo: dto.saldo_inicial, total })
      Object.assign(cambios, {
        saldo_inicial: dto.saldo_inicial, saldo_a_revisar: false, saldo_confirmado_por: userId,
        saldo_confirmado_el: new Date().toISOString(), saldo_motivo: dto.saldo_motivo ?? 'editado a mano',
        saldo_cobrado_el: dto.saldo_inicial === 0 ? undefined : null,
      })
      if (cambios.saldo_cobrado_el === undefined) delete cambios.saldo_cobrado_el
    } else if (dto.saldo_motivo !== undefined) {
      cambios.saldo_motivo = dto.saldo_motivo ?? ''
    }
    const { error } = await db.from('ventas_comprobantes_externos').update(cambios).eq('id', id)
    if (error) throw errorEscritura(error as PgError)
    return (await this.detalle(id, db)).externo
  },

  /**
   * PATCH /externos/:id/liquido (20260927d): solo CVLP (060/061), 0 < líquido
   * ≤ total. Lo lee el motor de asientos (`cvlp_modo='neto_liquidado'`); el
   * saldo del externo en Ventas sigue siendo el total del papel.
   */
  async liquido(id: number, liquido: number | null, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const { data: act, error: e0 } = await db.from('ventas_comprobantes_externos').select('id, cbte_tipo, total').eq('id', id).maybeSingle()
    if (e0) throw mapRpcError(e0 as PgError)
    if (!act) throw new FacturacionHttpError(404, 'EXTERNO_NO_EXISTE', { externo_id: id })
    const a = act as { cbte_tipo: number; total: number | string }
    if (![60, 61].includes(Number(a.cbte_tipo))) throw new FacturacionHttpError(400, 'NO_ES_CVLP', { campo: 'liquido', cbte_tipo: a.cbte_tipo })
    const valor = liquido == null ? null : Math.round(liquido * 100) / 100
    if (valor != null && (valor <= 0 || valor > Number(a.total))) {
      throw new FacturacionHttpError(400, 'LIQUIDO_INVALIDO', { campo: 'liquido', liquido: valor, total: Number(a.total) })
    }
    const { error } = await db.from('ventas_comprobantes_externos').update({ liquido: valor, updated_by: userId }).eq('id', id)
    if (error) throw errorEscritura(error as PgError)
    console.info(`[facturacion] externo ${id}: líquido CVLP ${valor ?? 'borrado'} por ${userId}`)
    return (await this.detalle(id, db)).externo
  },

  async borrar(id: number, db: SupabaseClient = supabase): Promise<void> {
    const { data, error } = await db.from('ventas_comprobantes_externos').delete().eq('id', id).select('id')
    if (error) throw errorEscritura(error as PgError)
    if (!data || data.length === 0) throw new FacturacionHttpError(404, 'EXTERNO_NO_EXISTE', { externo_id: id })
  },

  /** Vista previa (confirmar=false) o importación TODO O NADA (confirmar=true). */
  async importar(dto: ImportarExternosDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const crudas: Fila[] = dto.filas?.length ? dto.filas : parsearCsv(dto.csv ?? '')
    if (crudas.length === 0) throw new FacturacionHttpError(400, 'SIN_FILAS', { campo: 'filas' })
    if (crudas.length > 2000) throw new FacturacionHttpError(400, 'DEMASIADAS_FILAS', { max: 2000, filas: crudas.length })
    const filas = crudas.map(normalizarFila)
    const r = await rpc<Record<string, unknown>>(db, 'ventas_importar_externos', {
      p_filas: filas, p_user_id: userId, p_confirmar: dto.confirmar ?? false, p_origen: dto.origen ?? 'portal',
    })
    console.info(`[facturacion] importar externos ${dto.confirmar ? 'CONFIRMADO' : 'vista previa'} por ${userId}: `
      + `${String(r.total_filas)} filas, ${String(r.nuevas)} nuevas, ${String(r.duplicadas)} duplicadas, ${String(r.errores)} con error`)
    return r
  },

  async marcar(dto: MarcarExternosDto, userId: string, db: SupabaseClient = supabase): Promise<unknown> {
    const r = await rpc<unknown>(db, 'ventas_externos_marcar', {
      p_ids: dto.ids, p_accion: dto.accion, p_user_id: userId, p_motivo: dto.motivo ?? null, p_fecha: dto.fecha ?? null,
    })
    console.info(`[facturacion] ${dto.ids.length} externo(s) marcados «${dto.accion}» por ${userId}`)
    return r
  },
}
