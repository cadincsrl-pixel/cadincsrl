/**
 * Catálogos compartidos entre módulos (tanda 6). Por ahora: jurisdicciones
 * (base 20260929f), que usan Compras (tributos de la factura) y Ventas
 * (retenciones sufridas en cobros).
 *
 * Todo pasa por las RPC: `jurisdicciones_json`, `jurisdicciones_sin_normalizar`
 * y `jurisdiccion_guardar` (única puerta de escritura; vuelve a chequear el
 * flag `configurar` en pagos o en facturacion). Sin DELETE: se desactivan.
 *
 * Cache de las activas: 60 s, invalidada en cada escritura de este proceso.
 * La usa la lectura IA para proponer el id sin ir a la base por cada factura.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from '../../lib/supabase.js'
import { TIPOS_JURISDICCION, resolverJurisdiccion, type Jurisdiccion } from './jurisdicciones.js'

export class CatalogosHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'CatalogosHttpError'
  }
}

export const STATUS_CATALOGOS: Readonly<Record<string, number>> = {
  USUARIO_REQUERIDO: 400, JURISDICCION_INVALIDA: 400,
  SIN_PERMISO: 403,
  JURISDICCION_NO_EXISTE: 404,
  JURISDICCION_DUPLICADA: 409, JURISDICCION_POR_DEFECTO: 409,
}

function parseDetail(d: unknown): unknown {
  if (d == null || d === '') return undefined
  if (typeof d !== 'string') return d
  try { return JSON.parse(d) } catch { return d }
}

export function mapRpcErrorCatalogos(error: { message?: string; details?: string | null; code?: string }): CatalogosHttpError {
  const msg = error.message || ''
  const code = msg.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)?.[1]
  if (code && STATUS_CATALOGOS[code] !== undefined) {
    return new CatalogosHttpError(STATUS_CATALOGOS[code]!, code, parseDetail(error.details))
  }
  return new CatalogosHttpError(500, 'DB_ERROR', { dbMessage: msg, code: error.code })
}

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw mapRpcErrorCatalogos(error)
  return data as T
}

// ── Schemas ──────────────────────────────────────────────────────────────
const Alias = z.array(z.string().trim().min(1).max(60)).max(20)
const Base = {
  nombre:        z.string().trim().min(2).max(80),
  tipo:          z.enum(TIPOS_JURISDICCION),
  provincia_id:  z.number().int().positive().nullable(),
  codigo_comarb: z.string().trim().regex(/^\d{3}$/).nullable(),
  codigo_arca:   z.number().int().min(0).max(99).nullable(),
  alias:         Alias,
  activo:        z.boolean(),
}
export const JurisdiccionCreateSchema = z.object({
  nombre: Base.nombre,
  tipo: Base.tipo,
  provincia_id: Base.provincia_id.optional(),
  codigo_comarb: Base.codigo_comarb.optional(),
  codigo_arca: Base.codigo_arca.optional(),
  alias: Base.alias.optional(),
}).strict()
export const JurisdiccionUpdateSchema = z.object({
  nombre: Base.nombre.optional(),
  tipo: Base.tipo.optional(),
  provincia_id: Base.provincia_id.optional(),
  codigo_comarb: Base.codigo_comarb.optional(),
  codigo_arca: Base.codigo_arca.optional(),
  alias: Base.alias.optional(),
  activo: Base.activo.optional(),
}).strict().refine((o) => Object.keys(o).length > 0, { message: 'SIN_CAMBIOS' })
export type JurisdiccionCreateDto = z.infer<typeof JurisdiccionCreateSchema>
export type JurisdiccionUpdateDto = z.infer<typeof JurisdiccionUpdateSchema>

export interface TextoSinNormalizar { texto: string; tabla: 'pagos_factura_tributos' | 'ventas_cobro_retenciones'; filas: number }
export type JurisdiccionGuardada = Jurisdiccion & { normalizadas?: { tributos: number; retenciones: number } }

// ── Service ──────────────────────────────────────────────────────────────
const TTL_MS = 60_000
let cacheActivas: { at: number; lista: Jurisdiccion[] } | null = null

export const jurisdiccionesService = {
  async listar(incluirInactivas: boolean, db: SupabaseClient = supabase): Promise<Jurisdiccion[]> {
    return (await rpc<Jurisdiccion[] | null>(db, 'jurisdicciones_json', { p_incluir_inactivas: incluirInactivas })) ?? []
  },

  async sinNormalizar(db: SupabaseClient = supabase): Promise<TextoSinNormalizar[]> {
    return (await rpc<TextoSinNormalizar[] | null>(db, 'jurisdicciones_sin_normalizar', {})) ?? []
  },

  async crear(dto: JurisdiccionCreateDto, userId: string, db: SupabaseClient = supabase): Promise<JurisdiccionGuardada> {
    const r = await rpc<JurisdiccionGuardada>(db, 'jurisdiccion_guardar', { p: dto, p_user_id: userId })
    this.olvidarCache()
    return r
  },

  async editar(id: number, dto: JurisdiccionUpdateDto, userId: string, db: SupabaseClient = supabase): Promise<JurisdiccionGuardada> {
    const r = await rpc<JurisdiccionGuardada>(db, 'jurisdiccion_guardar', { p: { ...dto, id }, p_user_id: userId })
    this.olvidarCache()
    return r
  },

  /** Activas, con cache de 60 s. Nunca lanza: ante un error, lista vacía (y no cachea). */
  async activas(db: SupabaseClient = supabase): Promise<Jurisdiccion[]> {
    if (cacheActivas && Date.now() - cacheActivas.at < TTL_MS) return cacheActivas.lista
    try {
      const lista = await this.listar(false, db)
      cacheActivas = { at: Date.now(), lista }
      return lista
    } catch (e) {
      console.error('[catalogos] no se pudieron leer las jurisdicciones:', e instanceof Error ? e.message : e)
      return []
    }
  },

  /** Texto libre (lectura IA, backend viejo) → la jurisdicción, si resuelve sin ambigüedad. */
  async resolver(texto: string | null | undefined, db: SupabaseClient = supabase): Promise<Jurisdiccion | null> {
    if (!texto?.trim()) return null
    return resolverJurisdiccion(texto, await this.activas(db))
  },

  olvidarCache(): void {
    cacheActivas = null
  },
}
