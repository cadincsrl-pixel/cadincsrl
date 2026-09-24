/**
 * Facturas de venta: Factura A/B, NC A/B y FCE MiPyME A 201/203 (fases 1, 5 y 6). Lecturas sobre
 * `v_ventas_facturas` y escrituras SOLO por las RPC `ventas_*` (20260924c):
 * un UPDATE suelto rebota con VENTAS_SOLO_RPC. La emisión contra ARCA vive en
 * `emision.service.ts`.
 *
 * Toda lectura se limita al ambiente del proceso (ARCA_AMBIENTE) salvo
 * `?ambiente=todos`: un backend de homologación no muestra facturas de prod
 * ni al revés.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import { ambienteProceso, leerFJ, rpc, talonarioProceso } from './comun.js'
import {
  TIPOS_HABILITADOS, TOPE_CF_IDENTIFICACION, calcularTotales, esFce, esNC, letraDe, letraDeTipo, requiereIdentificacion,
  resumir, tipoPara, type FJ, type FacturaVista, type FilaParaResumen,
} from './reglas.js'
import { fceService } from './fce.service.js'
import type { GuardarFacturaDto, ListFacturasQuery, ResumenQuery } from './facturacion.schema.js'

export interface Evento {
  id: number
  tipo: string
  estado_antes: string | null
  estado_despues: string | null
  detalle: unknown
  user_id: string | null
  user_nombre: string | null
  created_at: string
}

/** Ambiente a filtrar: el del proceso, uno explícito, o null (= todos). */
function ambienteFiltro(q?: string): string | null {
  if (q === 'todos') return null
  if (q === 'homo' || q === 'prod') return q
  return ambienteProceso()
}

/**
 * El tipo de comprobante lo decide el sistema, no el usuario: la letra sale
 * del cliente (`letraDe`) y, en una NC, de la factura que corrige (una NC de
 * una FCE 201 es 203; de una Factura A, 3). Lo único que el usuario elige es,
 * con letra A, Factura A (1) o FCE MiPyME (201), y eso lo controla
 * `fceService.exigirTipoFce` con WSFECRED. Rechaza ANTES de la RPC (que
 * vuelve a validar todo, igual que al emitir):
 *   - LETRA_INCOMPATIBLE: el cliente no admite ninguna letra (RI o
 *     monotributo sin CUIT) o el tipo pedido es de la otra;
 *   - NC_TIPO_NO_COINCIDE: la NC pedida no es la de su factura (3 ↔ 1, 203 ↔ 201);
 *   - CF_REQUIERE_IDENTIFICACION: B sin documento (99) con total ≥ tope;
 *   - CORRESPONDE_FCE / NO_CORRESPONDE_FCE (fase 6), salvo `forzar`.
 */
export async function resolverTipo(
  f: GuardarFacturaDto['factura'], renglones: GuardarFacturaDto['renglones'], db: SupabaseClient,
  opts: { forzar?: boolean } = {},
): Promise<number> {
  const { data: cli, error } = await db.from('ventas_clientes')
    .select('id, doc_tipo, condicion_iva_id').eq('id', f.cliente_id).maybeSingle()
  if (error) throw mapRpcError(error as PgError)
  if (!cli) throw new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { campo: 'cliente_id', cliente_id: f.cliente_id })
  const c = cli as { doc_tipo: number; condicion_iva_id: number }
  const letraCliente = letraDe(Number(c.doc_tipo), Number(c.condicion_iva_id))
  const nc = f.asociada_id != null || (f.cbte_tipo != null && esNC(Number(f.cbte_tipo)))

  let letra = letraCliente
  let fce = f.cbte_tipo != null && esFce(Number(f.cbte_tipo))
  if (nc && f.asociada_id != null) {
    const { data: a } = await db.from('ventas_facturas').select('cbte_tipo').eq('id', f.asociada_id).maybeSingle()
    // Si la asociada no existe, la RPC contesta NC_FACTURA_NO_EXISTE.
    if (a) {
      const tipoAsoc = Number((a as { cbte_tipo: number }).cbte_tipo)
      letra = letraDeTipo(tipoAsoc) ?? letra
      const fceAsoc = esFce(tipoAsoc)
      if (f.cbte_tipo != null && fceAsoc !== fce) {
        throw new FacturacionHttpError(400, 'NC_TIPO_NO_COINCIDE', { campo: 'cbte_tipo', nc_tipo: Number(f.cbte_tipo), factura_tipo: tipoAsoc })
      }
      fce = fceAsoc
    }
  }
  const pedida = f.cbte_tipo != null ? letraDeTipo(Number(f.cbte_tipo)) : null
  if (!letraCliente || letra !== letraCliente || (f.cbte_tipo != null && pedida !== letra)) {
    throw new FacturacionHttpError(400, 'LETRA_INCOMPATIBLE', {
      campo: 'cliente_id', letra: pedida ?? letra, letra_cliente: letraCliente,
      doc_tipo: Number(c.doc_tipo), condicion_iva_id: Number(c.condicion_iva_id),
    })
  }
  const tipo = tipoPara(letra, nc, fce)
  if (!(TIPOS_HABILITADOS as readonly number[]).includes(tipo)) {
    throw new FacturacionHttpError(400, 'TIPO_NO_HABILITADO', { campo: 'cbte_tipo', cbte_tipo: tipo, habilitados: [...TIPOS_HABILITADOS] })
  }
  const total = calcularTotales(renglones).total
  if (requiereIdentificacion(tipo, Number(c.doc_tipo), total)) {
    throw new FacturacionHttpError(400, 'CF_REQUIERE_IDENTIFICACION', {
      campo: 'cliente_id', tope: TOPE_CF_IDENTIFICACION, total, cliente_id: f.cliente_id,
    })
  }
  if (!nc) await fceService.exigirTipoFce({ clienteId: f.cliente_id, tipo, total, fecha: f.fecha_cbte, forzar: opts.forzar }, db)
  return tipo
}

const lista = (csv?: string) => (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const facturasService = {
  async listar(q: ListFacturasQuery, db: SupabaseClient = supabase): Promise<{ rows: FacturaVista[]; total: number }> {
    const page = q.page ?? 1
    const pageSize = q.pageSize ?? 50
    let s = db.from('v_ventas_facturas').select('*', { count: 'exact' })
    const amb = ambienteFiltro(q.ambiente)
    if (amb) s = s.eq('ambiente', amb)
    const estados = lista(q.estado)
    if (estados.length) s = s.in('estado', estados)
    const tipos = lista(q.cbte_tipo).map(Number).filter(Number.isInteger)
    if (tipos.length) s = s.in('cbte_tipo', tipos)
    if (q.cliente_id) s = s.eq('cliente_id', q.cliente_id)
    if (q.obra_cod) s = s.eq('obra_cod', q.obra_cod.trim())
    if (q.producto) s = s.eq('producto', q.producto)
    if (q.desde) s = s.gte('fecha_cbte', q.desde)
    if (q.hasta) s = s.lte('fecha_cbte', q.hasta)
    if (q.finnegans === 'pendiente') s = s.eq('pendiente_finnegans', true)
    if (q.finnegans === 'registrada') s = s.not('numero_finnegans', 'is', null)
    const busq = normTxt(q.q ?? '')
    if (busq) s = s.ilike('busq', `%${busq}%`)
    const desde = (page - 1) * pageSize
    const { data, error, count } = await s
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(desde, desde + pageSize - 1)
    if (error) throw mapRpcError(error as PgError)
    const rows = (data ?? []) as FacturaVista[]
    // Las descripciones de los renglones, en orden: la bandeja de Finnegans
    // las muestra y las copia sin bajar la ficha de cada factura.
    const ids = rows.map((r) => r.id)
    const desc = new Map<number, string[]>()
    if (ids.length) {
      const rens = await todasLasFilas<{ factura_id: number; orden: number; descripcion: string }>((d, h) =>
        db.from('ventas_factura_renglones').select('factura_id, orden, descripcion')
          .in('factura_id', ids).order('factura_id').order('orden').range(d, h))
      for (const r of rens) desc.set(r.factura_id, [...(desc.get(r.factura_id) ?? []), r.descripcion])
    }
    return { rows: rows.map((r) => ({ ...r, descripciones: desc.get(r.id) ?? [] })), total: count ?? 0 }
  },

  async resumen(q: ResumenQuery, db: SupabaseClient = supabase) {
    const amb = ambienteFiltro(q.ambiente)
    const filas = await todasLasFilas<FilaParaResumen>((d, h) => {
      let s = db.from('v_ventas_facturas')
        .select('id, mes, obra_cod, obra_nom, producto, letra, es_nc, imp_neto, imp_iva, imp_total')
        .eq('estado', 'autorizada')
      if (amb) s = s.eq('ambiente', amb)
      if (q.desde) s = s.gte('fecha_cbte', q.desde)
      if (q.hasta) s = s.lte('fecha_cbte', q.hasta)
      return s.order('id').range(d, h)
    })
    return resumir(filas)
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<FJ & { eventos: Evento[] }> {
    const fj = await leerFJ(db, id)
    const { data, error } = await db.from('ventas_factura_eventos')
      .select('id, tipo, estado_antes, estado_despues, detalle, user_id, created_at')
      .eq('factura_id', id).order('created_at').order('id')
    if (error) throw mapRpcError(error as PgError)
    const evs = (data ?? []) as Array<Omit<Evento, 'user_nombre'>>
    const uids = [...new Set(evs.map((e) => e.user_id).filter((u): u is string => !!u))]
    const nombres = new Map<string, string>()
    if (uids.length) {
      const { data: ps } = await db.from('profiles').select('id, nombre').in('id', uids)
      for (const p of (ps ?? []) as Array<{ id: string; nombre: string | null }>) nombres.set(p.id, p.nombre ?? '')
    }
    return { ...fj, eventos: evs.map((e) => ({ ...e, user_nombre: e.user_id ? nombres.get(e.user_id) ?? null : null })) }
  },

  /**
   * Crea (id ausente) o reemplaza por completo un borrador. El backend pone
   * ambiente y punto de venta del proceso; la RPC recalcula totales y valida
   * letra, obra (el centro de costo, que la RPC deriva), fecha y saldo de la NC.
   */
  async guardar(dto: GuardarFacturaDto, id: number | null, userId: string, esAdmin: boolean, db: SupabaseClient = supabase): Promise<FJ> {
    const pedido = dto.factura.cbte_tipo
    if (pedido != null && !(TIPOS_HABILITADOS as readonly number[]).includes(Number(pedido))) {
      throw new FacturacionHttpError(400, 'TIPO_NO_HABILITADO', { campo: 'cbte_tipo', cbte_tipo: pedido, habilitados: [...TIPOS_HABILITADOS] })
    }
    if (dto.forzar && !esAdmin) throw new FacturacionHttpError(403, 'FORZAR_SOLO_ADMIN')
    const { ambiente, ptoVta } = talonarioProceso()

    if (id != null) {
      const { data, error } = await db.from('ventas_facturas').select('id, ambiente, estado').eq('id', id).maybeSingle()
      if (error) throw mapRpcError(error as PgError)
      if (!data) throw new FacturacionHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: id })
      const f = data as { ambiente: string; estado: string }
      if (f.ambiente !== ambiente) throw new FacturacionHttpError(409, 'AMBIENTE_NO_COINCIDE', { esperado: ambiente, factura: f.ambiente })
      if (f.estado !== 'borrador') throw new FacturacionHttpError(409, 'FACTURA_NO_EDITABLE', { factura_id: id, estado: f.estado })
    }

    const f = dto.factura
    const tipo = await resolverTipo(f, dto.renglones, db, { forzar: !!dto.forzar })
    const pFactura: Record<string, unknown> = {
      ...(id != null ? { id } : {}),
      ambiente, pto_vta: ptoVta, cbte_tipo: tipo,
      cliente_id: f.cliente_id,
      producto: f.producto,
      obra_cod: f.obra_cod?.trim() || null,
      fecha_cbte: f.fecha_cbte || null,
      provincia_origen: f.provincia_origen ?? null,
      provincia_destino: f.provincia_destino ?? null,
      condicion_pago: f.condicion_pago ?? null,
      remitos: f.remitos ?? '',
      observaciones: f.observaciones ?? '',
      ...(f.obs_interna != null ? { obs_interna: f.obs_interna } : {}),
      asociada_id: f.asociada_id ?? null,
      // FCE (fase 6): la RPC solo los usa en la 201 / 203.
      fce_cuenta_id: f.fce_cuenta_id ?? null,
      fch_vto_pago: f.fch_vto_pago || null,
      fce_transmision: f.fce_transmision ?? null,
      fce_referencia: f.fce_referencia?.trim() || null,
      nc_anulacion: f.nc_anulacion ?? null,
    }
    const pRenglones = dto.renglones.map((r) => ({
      descripcion: r.descripcion,
      cantidad: r.cantidad ?? 1,
      unidad: r.unidad?.trim() || 'Unidades',
      precio_unit: r.precio_unit,
      alicuota_id: r.alicuota_id ?? 5,
    }))
    return rpc<FJ>(db, 'ventas_guardar_borrador', {
      p_factura: pFactura, p_renglones: pRenglones, p_user_id: userId, p_forzar: !!dto.forzar,
    })
  },

  /** Solo un borrador que nunca fue a ARCA (lo decide el trigger de la base). */
  async borrar(id: number, db: SupabaseClient = supabase): Promise<void> {
    const { data, error } = await db.from('ventas_facturas').delete().eq('id', id).select('id')
    if (error) {
      const e = mapRpcError(error as PgError)
      // Autorizada o con historia en ARCA (el log la referencia) → no se borra.
      if (e.code === 'FACTURA_AUTORIZADA_INMUTABLE' || e.code === 'FACTURA_NO_BORRABLE' || (error as PgError).code === '23503') {
        throw new FacturacionHttpError(409, 'FACTURA_NO_BORRABLE', typeof e.detail === 'object' && e.detail && !('dbMessage' in e.detail) ? e.detail : { factura_id: id })
      }
      throw e
    }
    if (!data || data.length === 0) throw new FacturacionHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: id })
  },

  async descartar(id: number, motivo: string | null | undefined, userId: string, db: SupabaseClient = supabase): Promise<FJ> {
    return rpc<FJ>(db, 'ventas_descartar', { p_id: id, p_motivo: motivo?.trim() || null, p_user_id: userId })
  },

  /** rechazada → borrador, para corregir y volver a emitir. */
  async volverABorrador(id: number, userId: string, db: SupabaseClient = supabase): Promise<FJ> {
    const fj = await leerFJ(db, id)
    if (fj.factura.estado !== 'rechazada') {
      throw new FacturacionHttpError(409, 'FACTURA_NO_REVERTIBLE', { factura_id: id, estado: fj.factura.estado })
    }
    return rpc<FJ>(db, 'ventas_volver_a_borrador', {
      p_id: id, p_numero_consultado: null, p_motivo: 'corregir rechazo de ARCA', p_user_id: userId,
    })
  },

  async registrarFinnegans(id: number, numero: string, userId: string, db: SupabaseClient = supabase): Promise<FacturaVista> {
    return rpc<FacturaVista>(db, 'ventas_registrar_finnegans', { p_id: id, p_numero_finnegans: numero.trim(), p_user_id: userId })
  },

  async deshacerRegistro(id: number, userId: string, db: SupabaseClient = supabase): Promise<FacturaVista> {
    return rpc<FacturaVista>(db, 'ventas_deshacer_registro', { p_id: id, p_user_id: userId })
  },

  /** cbte_tipo de una factura (para elegir el flag de emisión). */
  async tipoDe(id: number, db: SupabaseClient = supabase): Promise<number> {
    const { data, error } = await db.from('ventas_facturas').select('cbte_tipo').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new FacturacionHttpError(404, 'FACTURA_NO_EXISTE', { factura_id: id })
    return Number((data as { cbte_tipo: number }).cbte_tipo)
  },
}
