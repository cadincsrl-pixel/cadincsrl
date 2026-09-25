/**
 * Configuración de Compras (tanda 6; base 20260929f + 20260929i, `pagos_config`).
 *
 * Claves:
 *   · `tributo_jurisdiccion_default_id` — la jurisdicción que propone el alta
 *     de un tributo (IIBB de Tucumán). 20260929f.
 *   · avisos de pago (20260929i): `aviso_contador_email`, `aviso_responder_a`,
 *     `aviso_nombre_remitente`, `aviso_pie_texto`.
 *   · `aviso_compras_email` (20260929x): copia a Compras del aviso de pago;
 *     recibe el mismo paquete que el contador. Sin fallback a env ni perfil.
 *   · `plazos_cheque` (20260929i): los días que ofrece el alta de un cheque.
 *   · `tolerancia_saldo` (20260930e): montos menores no cuentan como deuda ni
 *     como saldo a favor en «Deuda por proveedor» ni como vencidos. La aplican
 *     las vistas (`v_pagos_proveedor_saldo`, `v_pagos_facturas.vencida`); acá
 *     solo se lee y se guarda. 0 a 100, dos decimales, default 1.
 *
 * La API habla con nombres cortos (`contador_email`, `plazos_cheque`…) y este
 * archivo los traduce a las claves de la base. La respuesta de GET conserva
 * `tributos.jurisdiccion_default_id` tal cual estaba (lo lee el alta de la
 * factura) y suma `aviso` y `cheques`.
 *
 * Escritura: SOLO `pagos_guardar_config` (vuelve a chequear el flag
 * `pagos.configurar` y valida cada clave). Cache de 60 s, invalidada en cada
 * escritura. Con varias instancias, otra tarda hasta 60 s en ver el cambio.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from '../../lib/supabase.js'
import { esEmailValido, estaConfigurado, loQueFalta, remitenteEfectivo } from '../../lib/mail.js'
import { getEmpresa } from '../../lib/empresa.js'
import { mapRpcError, PagosHttpError } from './pagos.errors.js'
import { pieConCbu } from './aviso-pago.cuerpo.js'

/** Los plazos de hoy: fallback si la base no trae la lista. */
export const PLAZOS_CHEQUE_DEFAULT = [0, 7, 15, 30, 45, 60, 90] as const
/** Tolerancia de saldo si la base no la trae (mismo default que la RPC). */
export const TOLERANCIA_SALDO_DEFAULT = 1
export const TOLERANCIA_SALDO_MAX = 100

/** A lo sumo dos decimales (la base rechaza 0,005). */
const dosDecimales = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6

// ── Validación de la API (la base repite todo; esto da el error lindo) ────
const emailONull = z.string().trim().max(254)
  .transform((s) => s.toLowerCase())
  .refine((s) => s === '' || esEmailValido(s), { message: 'EMAIL_INVALIDO' })
  .transform((s) => (s === '' ? null : s))
  .nullable()

export const PagosConfigPatchSchema = z.object({
  tributo_jurisdiccion_default_id: z.number().int().positive().nullable().optional(),
  contador_email: emailONull.optional(),
  compras_email: emailONull.optional(),
  responder_a: emailONull.optional(),
  nombre_remitente: z.string().trim()
    .max(60, { message: 'TEXTO_LARGO' })
    .refine((s) => !/[<>"\u0000-\u001f\u007f]/.test(s), { message: 'CARACTERES_INVALIDOS' })
    .transform((s) => (s === '' ? null : s))
    .nullable().optional(),
  pie_texto: z.string().trim()
    .max(500, { message: 'TEXTO_LARGO' })
    .refine((s) => !pieConCbu(s), { message: 'PIE_CON_CBU' })
    .transform((s) => (s === '' ? null : s))
    .nullable().optional(),
  plazos_cheque: z.array(z.number().int().min(0).max(365))
    .min(1).max(12)
    .refine((a) => new Set(a).size === a.length, { message: 'PLAZOS_REPETIDOS' })
    .optional(),
  tolerancia_saldo: z.number({ message: 'TOLERANCIA_INVALIDA' })
    .min(0, { message: 'TOLERANCIA_INVALIDA' }).max(TOLERANCIA_SALDO_MAX, { message: 'TOLERANCIA_INVALIDA' })
    .refine(dosDecimales, { message: 'TOLERANCIA_INVALIDA' })
    .optional(),
}).strict().refine((o) => Object.keys(o).length > 0, { message: 'SIN_CAMBIOS' })
export type PagosConfigPatch = z.infer<typeof PagosConfigPatchSchema>

/** Nombre de la API → clave de `pagos_config`. */
const CLAVE_DB: Record<keyof PagosConfigPatch, string> = {
  tributo_jurisdiccion_default_id: 'tributo_jurisdiccion_default_id',
  contador_email: 'aviso_contador_email',
  compras_email: 'aviso_compras_email',
  responder_a: 'aviso_responder_a',
  nombre_remitente: 'aviso_nombre_remitente',
  pie_texto: 'aviso_pie_texto',
  plazos_cheque: 'plazos_cheque',
  tolerancia_saldo: 'tolerancia_saldo',
}
const CLAVE_API: Record<string, string> = Object.fromEntries(Object.entries(CLAVE_DB).map(([a, d]) => [d, a]))

/** Pura: el body validado → `p_cambios` de la RPC. */
export function cambiosParaDb(p: PagosConfigPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue
    const clave = CLAVE_DB[k as keyof PagosConfigPatch]
    if (clave) out[clave] = v
  }
  return out
}

/** Lo que guarda la base, ya tipado. */
export interface PagosConfigBase {
  tributo_jurisdiccion_default_id: number | null
  aviso_contador_email: string | null
  aviso_compras_email: string | null
  aviso_responder_a: string | null
  aviso_nombre_remitente: string | null
  aviso_pie_texto: string | null
  plazos_cheque: number[]
  tolerancia_saldo: number
}

export type FuenteContador = 'config' | 'env' | 'perfil' | null

export interface PagosConfig {
  aviso: {
    contador_email: string | null
    contador_email_efectivo: string | null
    contador_fuente: FuenteContador
    /** Copia a Compras (20260929x): mismo paquete que el contador. null = no se manda. */
    compras_email: string | null
    responder_a: string | null
    /** El Reply-To que sale de verdad: el de la pantalla o SMTP_REPLY_TO. */
    responder_a_efectivo: string | null
    nombre_remitente: string | null
    remitente_efectivo: string
    pie_texto: string | null
    smtp: { configurado: boolean; falta: string[] }
  }
  cheques: { plazos: number[] }
  /** «Deuda por proveedor» (20260930e): por debajo, ni deuda ni saldo a favor. */
  saldos: { tolerancia: number }
  tributos: { jurisdiccion_default_id: number | null }
}

const texto = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s : null
}

/** Pura: la fila de `pagos_config_json()` → lo guardado, tipado. */
export function baseDesdeJson(raw: unknown): PagosConfigBase {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = Number(r.tributo_jurisdiccion_default_id)
  const plazos = Array.isArray(r.plazos_cheque)
    ? [...new Set(r.plazos_cheque.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => a - b)
    : []
  const tol = Number(r.tolerancia_saldo)
  return {
    tributo_jurisdiccion_default_id: Number.isInteger(id) && id > 0 ? id : null,
    aviso_contador_email: texto(r.aviso_contador_email),
    aviso_compras_email: texto(r.aviso_compras_email),
    aviso_responder_a: texto(r.aviso_responder_a),
    aviso_nombre_remitente: texto(r.aviso_nombre_remitente),
    aviso_pie_texto: texto(r.aviso_pie_texto),
    plazos_cheque: plazos.length ? plazos : [...PLAZOS_CHEQUE_DEFAULT],
    tolerancia_saldo: r.tolerancia_saldo != null && Number.isFinite(tol) && tol >= 0 && tol <= TOLERANCIA_SALDO_MAX
      ? tol : TOLERANCIA_SALDO_DEFAULT,
  }
}

/**
 * A quién le llega el aviso del contador, en este orden:
 *   1. `aviso_contador_email` de la pantalla;
 *   2. `CONTADOR_EMAIL` del env;
 *   3. el usuario activo con rol contador (solo si hace falta: es una
 *      consulta a Auth).
 */
export async function resolverEmailContador(
  deConfig: string | null | undefined,
  deps: { env?: string | null; delPerfil?: () => Promise<string | null> } = {},
): Promise<{ email: string | null; fuente: FuenteContador }> {
  const c = (deConfig ?? '').trim()
  if (esEmailValido(c)) return { email: c, fuente: 'config' }
  const e = (deps.env ?? process.env.CONTADOR_EMAIL ?? '').trim()
  if (esEmailValido(e)) return { email: e, fuente: 'env' }
  try {
    const p = ((await (deps.delPerfil ?? emailDelPerfilContador)()) ?? '').trim()
    if (esEmailValido(p)) return { email: p, fuente: 'perfil' }
  } catch {
    // Best-effort: sin Auth, el aviso dice «no hay dirección», no se cae.
  }
  return { email: null, fuente: null }
}

/** La casilla del usuario activo con rol contador, o null. */
export async function emailDelPerfilContador(): Promise<string | null> {
  const { data } = await supabase
    .from('profiles').select('id').eq('rol_key', 'contador').eq('activo', true).limit(1).maybeSingle()
  if (!data) return null
  const { data: u } = await supabase.auth.admin.getUserById((data as { id: string }).id)
  return u?.user?.email ?? null
}

/** Reply-To: el de la pantalla; si no, `SMTP_REPLY_TO` del env. */
export function responderAEfectivo(deConfig: string | null | undefined, env = process.env.SMTP_REPLY_TO): string | null {
  return texto(deConfig) ?? texto(env)
}

/**
 * Nombre del From: el de la pantalla; si no, el nombre de fantasía de la
 * empresa. La dirección siempre sale del env (lib/mail).
 */
export function nombreRemitenteEfectivo(deConfig: string | null | undefined, nombreFantasia: string | null | undefined): string | null {
  return texto(deConfig) ?? texto(nombreFantasia)
}

async function armar(base: PagosConfigBase): Promise<PagosConfig> {
  const contador = await resolverEmailContador(base.aviso_contador_email)
  let fantasia: string | null = null
  try { fantasia = (await getEmpresa()).nombre_fantasia } catch { fantasia = null }
  return {
    aviso: {
      contador_email: base.aviso_contador_email,
      contador_email_efectivo: contador.email,
      contador_fuente: contador.fuente,
      compras_email: base.aviso_compras_email,
      responder_a: base.aviso_responder_a,
      responder_a_efectivo: responderAEfectivo(base.aviso_responder_a),
      nombre_remitente: base.aviso_nombre_remitente,
      remitente_efectivo: remitenteEfectivo(nombreRemitenteEfectivo(base.aviso_nombre_remitente, fantasia)),
      pie_texto: base.aviso_pie_texto,
      smtp: { configurado: estaConfigurado(), falta: loQueFalta() },
    },
    cheques: { plazos: base.plazos_cheque },
    saldos: { tolerancia: base.tolerancia_saldo },
    tributos: { jurisdiccion_default_id: base.tributo_jurisdiccion_default_id },
  }
}

/**
 * Un CONFIG_INVALIDA de la base con motivo conocido se devuelve con el
 * código que la pantalla ya sabe traducir (EMAIL_INVALIDO, PIE_CON_CBU…),
 * con la clave en el nombre de la API.
 */
function traducirError(e: PagosHttpError): PagosHttpError {
  if (e.code !== 'CONFIG_INVALIDA') return e
  const d = (e.detail && typeof e.detail === 'object' ? e.detail : {}) as Record<string, unknown>
  const clave = typeof d.clave === 'string' ? (CLAVE_API[d.clave] ?? d.clave) : null
  const motivo = typeof d.motivo === 'string' ? d.motivo : null
  const codigo = motivo === 'email_invalido' ? 'EMAIL_INVALIDO' : motivo === 'pie_con_cbu' ? 'PIE_CON_CBU' : 'CONFIG_INVALIDA'
  return new PagosHttpError(400, codigo, { ...d, clave, campo: clave, motivo })
}

const TTL_MS = 60_000
let cache: { at: number; valor: PagosConfig } | null = null

export const pagosConfigService = {
  async obtener(db: SupabaseClient = supabase): Promise<PagosConfig> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.valor
    const { data, error } = await db.rpc('pagos_config_json')
    if (error) throw mapRpcError(error)
    const valor = await armar(baseDesdeJson(data))
    cache = { at: Date.now(), valor }
    return valor
  },

  async guardar(cambios: PagosConfigPatch, userId: string, db: SupabaseClient = supabase): Promise<PagosConfig> {
    const { data, error } = await db.rpc('pagos_guardar_config', { p_cambios: cambiosParaDb(cambios), p_user_id: userId })
    if (error) throw traducirError(mapRpcError(error))
    const valor = await armar(baseDesdeJson(data))
    cache = { at: Date.now(), valor }
    return valor
  },

  olvidarCache(): void {
    cache = null
  },
}
