/**
 * Puntos de venta de Ventas (tanda 6, ítem 3; base 20260929d).
 *
 * La tabla `ventas_puntos_venta` dice con qué PV se puede emitir en cada
 * ambiente y cuál es el por defecto. Si un ambiente no tiene filas, todo cae
 * a ARCA_PTO_VTA (el comportamiento de antes; ver `talonario()` en comun.ts).
 *
 * Al dar de alta un PV se verifica contra ARCA (FEParamGetPtosVenta). En
 * homologación ARCA suele no listar ninguno (error 602): eso NO bloquea del
 * todo, sale 409 PV_NO_VERIFICADO y el usuario puede guardar igual con
 * `forzar`. Lo que ARCA sí dice que está mal (no existe, no es webservice,
 * bloqueado, dado de baja) es 422 y no se fuerza.
 *
 * Escritura solo por `ventas_guardar_punto_venta` (vuelve a chequear el flag
 * facturacion.configurar). El ambiente es SIEMPRE el del proceso.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import {
  arcaConfig, arcaEstaConfigurado, paramPuntosVenta,
  type ArcaAmbiente, type PuntoVentaArca,
} from '../../lib/arca/index.js'
import { ambienteProceso, rpc } from './comun.js'
import { FacturacionHttpError, mapRpcError, type PgError } from './facturacion.errors.js'
import type { PuntoVentaCreateDto, PuntoVentaUpdateDto } from './facturacion.schema.js'

export interface PuntoVenta {
  id: number
  ambiente: ArcaAmbiente
  numero: number
  nombre: string
  activo: boolean
  por_defecto: boolean
  producto_ids: number[]
  arca_emision_tipo: string | null
  arca_bloqueado: boolean | null
  arca_fch_baja: string | null
  verificado_arca_at: string | null
  /** Facturas (no descartadas) de ese ambiente con ese PV. */
  facturas: number
  created_at?: string
  updated_at?: string
  created_by?: string | null
  updated_by?: string | null
}

/** Lo que se guarda en `p.arca` para la RPC. */
export interface ArcaPv { emision_tipo: string; bloqueado: boolean; fch_baja: string | null }

export type Verificacion =
  | { estado: 'ok'; arca: ArcaPv }
  /** ARCA contestó y el PV no sirve: 422 al dar de alta. */
  | { estado: 'rechazado'; codigo: 'PV_NO_EXISTE_EN_ARCA' | 'PV_NO_ES_WEBSERVICE' | 'PV_BLOQUEADO' | 'PV_DADO_DE_BAJA'; arca: ArcaPv | null; disponibles: number[] }
  /** No se pudo preguntar, o ARCA no lista ningún PV (homologación). */
  | { estado: 'no_verificado'; motivo: string }

/** ¿El tipo de emisión es CAE por webservice? («CAE - Ws» sí; «CAEA - Ws» o factura en línea no). */
export function esCaeWebservice(emisionTipo: string): boolean {
  const t = emisionTipo.toUpperCase()
  return /\bCAE\b/.test(t) && !t.includes('CAEA')
}

/** Pura: qué dice la lista de ARCA sobre un número de PV. */
export function evaluarPvArca(numero: number, lista: PuntoVentaArca[]): Verificacion {
  if (!lista.length) {
    return { estado: 'no_verificado', motivo: 'ARCA no devolvió ningún punto de venta (en homologación es lo normal)' }
  }
  const disponibles = lista.map((p) => p.nro).sort((a, b) => a - b)
  const pv = lista.find((p) => p.nro === numero)
  if (!pv) return { estado: 'rechazado', codigo: 'PV_NO_EXISTE_EN_ARCA', arca: null, disponibles }
  const arca: ArcaPv = { emision_tipo: pv.emisionTipo, bloqueado: pv.bloqueado, fch_baja: pv.fchBaja }
  if (!esCaeWebservice(pv.emisionTipo)) return { estado: 'rechazado', codigo: 'PV_NO_ES_WEBSERVICE', arca, disponibles }
  if (pv.bloqueado) return { estado: 'rechazado', codigo: 'PV_BLOQUEADO', arca, disponibles }
  if (pv.fchBaja) return { estado: 'rechazado', codigo: 'PV_DADO_DE_BAJA', arca, disponibles }
  return { estado: 'ok', arca }
}

function mensajeDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function ambienteOr503(): ArcaAmbiente {
  const amb = ambienteProceso()
  if (!amb) throw new FacturacionHttpError(503, 'ARCA_NO_CONFIGURADO', { falta: ['ARCA_AMBIENTE'] })
  return amb
}

// Cache corto de la lista (la lee `/arca/ambiente`, que llama la campana).
// Se invalida en cada escritura de este proceso; otra instancia tarda ≤ 60 s.
const TTL_MS = 60_000
const cache = new Map<string, { at: number; valor: PuntoVenta[] }>()

export const puntosVentaService = {
  async listar(ambiente: ArcaAmbiente | null, db: SupabaseClient = supabase): Promise<PuntoVenta[]> {
    return (await rpc<PuntoVenta[] | null>(db, 'ventas_puntos_venta_json', { p_ambiente: ambiente })) ?? []
  },

  /** Igual que `listar` pero con cache de 60 s. Nunca lanza: ante un error, []. */
  async listarCache(ambiente: ArcaAmbiente, db: SupabaseClient = supabase): Promise<PuntoVenta[]> {
    const c = cache.get(ambiente)
    if (c && Date.now() - c.at < TTL_MS) return c.valor
    try {
      const valor = await this.listar(ambiente, db)
      cache.set(ambiente, { at: Date.now(), valor })
      return valor
    } catch {
      return []
    }
  },

  olvidarCache(): void {
    cache.clear()
  },

  /** Pregunta a ARCA. Nunca lanza: un error de conexión es `no_verificado`. */
  async verificarEnArca(numero: number, ambiente: ArcaAmbiente): Promise<Verificacion> {
    if (!arcaEstaConfigurado()) return { estado: 'no_verificado', motivo: 'la conexión con ARCA no está configurada en este servidor' }
    let lista: PuntoVentaArca[]
    try {
      const cfg = arcaConfig()
      if (cfg.ambiente !== ambiente) return { estado: 'no_verificado', motivo: `el servidor está en ${cfg.ambiente}, no en ${ambiente}` }
      lista = await paramPuntosVenta({ config: cfg })
    } catch (e) {
      return { estado: 'no_verificado', motivo: `ARCA no respondió: ${mensajeDe(e)}` }
    }
    return evaluarPvArca(numero, lista)
  },

  async crear(dto: PuntoVentaCreateDto, userId: string, db: SupabaseClient = supabase): Promise<PuntoVenta> {
    const ambiente = ambienteOr503()
    const v = await this.verificarEnArca(dto.numero, ambiente)
    if (v.estado === 'rechazado') {
      throw new FacturacionHttpError(422, v.codigo, { campo: 'numero', numero: dto.numero, disponibles: v.disponibles, arca: v.arca })
    }
    if (v.estado === 'no_verificado' && !dto.forzar) {
      throw new FacturacionHttpError(409, 'PV_NO_VERIFICADO', { campo: 'numero', numero: dto.numero, motivo: v.motivo })
    }
    const { forzar: _f, ...resto } = dto
    const p: Record<string, unknown> = { ...resto, ambiente }
    if (v.estado === 'ok') p.arca = v.arca
    const r = await rpc<PuntoVenta>(db, 'ventas_guardar_punto_venta', { p, p_user_id: userId })
    this.olvidarCache()
    return r
  },

  async editar(id: number, dto: PuntoVentaUpdateDto, userId: string, db: SupabaseClient = supabase): Promise<PuntoVenta> {
    const r = await rpc<PuntoVenta>(db, 'ventas_guardar_punto_venta', { p: { ...dto, id }, p_user_id: userId })
    this.olvidarCache()
    return r
  },

  /**
   * Vuelve a consultar ARCA. Si ARCA encontró el PV guarda lo que dijo
   * (aunque esté bloqueado o dado de baja: es la foto). 200 siempre que se
   * haya podido leer la fila; el resultado va en `verificacion`.
   */
  async verificar(id: number, userId: string, db: SupabaseClient = supabase): Promise<{ punto_venta: PuntoVenta; verificacion: Verificacion }> {
    const { data, error } = await db.from('ventas_puntos_venta').select('id, ambiente, numero').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new FacturacionHttpError(404, 'PV_NO_EXISTE', { id })
    const fila = data as { id: number; ambiente: ArcaAmbiente; numero: number }
    const v = await this.verificarEnArca(Number(fila.numero), fila.ambiente)
    const arca = v.estado === 'ok' ? v.arca : v.estado === 'rechazado' ? v.arca : null
    let pv: PuntoVenta
    if (arca) {
      pv = await rpc<PuntoVenta>(db, 'ventas_guardar_punto_venta', { p: { id, arca }, p_user_id: userId })
      this.olvidarCache()
    } else {
      pv = await rpc<PuntoVenta>(db, '_ventas_punto_venta_json', { p_id: id })
    }
    return { punto_venta: pv, verificacion: v }
  },
}
