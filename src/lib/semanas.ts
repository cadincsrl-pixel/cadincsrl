import { HTTPException } from 'hono/http-exception'
import type { SupabaseClient } from '@supabase/supabase-js'
import { viernesISO } from '../modules/horas/costo-obra.js'

/**
 * Semanas de tarja (viernes → jueves) y su estado de cierre.
 *
 * Regla (decisión del user, 2026-09-06, "opción 1"): una semana está CERRADA
 * si tiene una fila en `cierres` con estado 'cerrado', o si NO tiene fila y su
 * jueves ya pasó. Una fila con estado 'pendiente' es una semana reabierta (o
 * abierta a mano) y se puede editar. Es la misma regla que muestra la
 * pantalla de Cierres desde siempre ("Cerrada · Automática"); hasta hoy el
 * backend solo bloqueaba las que tenían fila 'cerrado', así que casi ninguna
 * semana pagada estaba protegida de verdad.
 */

/** Hoy en Argentina como YYYY-MM-DD (el server corre en UTC). */
export function hoyArgentinaISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Jueves (último día) de la semana cuyo viernes es `semKey`. */
export function juevesISO(semKey: string): string {
  const d = new Date(semKey + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

export type EstadoCierre = 'cerrado' | 'pendiente'

export function semanaCerrada(estado: string | null | undefined, semKey: string, hoyISO: string = hoyArgentinaISO()): boolean {
  if (estado === 'cerrado') return true
  if (estado === 'pendiente') return false
  return hoyISO > juevesISO(semKey)
}

/** Viernes consecutivos desde `desde` (inclusive) hasta `hasta` (inclusive). */
export function viernesEntre(desde: string, hasta: string): string[] {
  const out: string[] = []
  const d = new Date(desde + 'T12:00:00Z')
  while (d.toISOString().slice(0, 10) <= hasta) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return out
}

/** Estado en `cierres` de cada semana pedida (undefined = sin fila). */
export async function estadosDeCierre(
  supabase: SupabaseClient,
  obraCod: string,
  semKeys: string[],
): Promise<Map<string, string | undefined>> {
  const unicos = [...new Set(semKeys)]
  const estados = new Map<string, string | undefined>(unicos.map(k => [k, undefined]))
  if (unicos.length === 0) return estados
  const { data, error } = await supabase
    .from('cierres')
    .select('sem_key, estado')
    .eq('obra_cod', obraCod)
    .in('sem_key', unicos)
  if (error) throw new Error(error.message)
  for (const r of (data ?? []) as Array<{ sem_key: string; estado: string }>) {
    estados.set(String(r.sem_key).slice(0, 10), r.estado)
  }
  return estados
}

export async function semanasCerradas(
  supabase: SupabaseClient,
  obraCod: string,
  semKeys: string[],
  hoyISO: string = hoyArgentinaISO(),
): Promise<string[]> {
  const estados = await estadosDeCierre(supabase, obraCod, semKeys)
  return [...estados.entries()].filter(([k, e]) => semanaCerrada(e, k, hoyISO)).map(([k]) => k).sort()
}

/**
 * 409 SEMANA_CERRADA si alguna de las semanas está cerrada. `que` es lo que
 * se intentaba modificar, para el mensaje ("horas", "horas extras").
 */
export async function ensureSemanasAbiertas(
  supabase: SupabaseClient,
  obraCod: string,
  semKeys: string[],
  que = 'horas',
): Promise<void> {
  const cerradas = await semanasCerradas(supabase, obraCod, semKeys)
  if (cerradas.length > 0) {
    throw new HTTPException(409, {
      message: `SEMANA_CERRADA: la semana ${cerradas[0]} de ${obraCod} está cerrada — reabrila en Cierres antes de modificar ${que}`,
    })
  }
}

/**
 * Un cambio de precio/categoría con vigencia `desde` recalcula todas las
 * semanas desde ese viernes. Si alguna de las semanas anteriores a la actual
 * está cerrada, se exige `confirmar` explícito (la UI pregunta y reintenta).
 * `obraCod` null = cambio global (precio de categoría): afecta a todas las
 * obras, así que toda semana pasada cuenta como cerrada.
 */
export async function ensureNoAfectaSemanasCerradas(
  supabase: SupabaseClient,
  obraCod: string | null,
  desde: string,
  confirmar: boolean | undefined,
  hoyISO: string = hoyArgentinaISO(),
): Promise<void> {
  if (confirmar) return
  const viernesDesde = viernesISO(desde)
  const viernesActual = viernesISO(hoyISO)
  if (viernesDesde >= viernesActual) return
  const ultimaPasada = new Date(viernesActual + 'T12:00:00Z')
  ultimaPasada.setUTCDate(ultimaPasada.getUTCDate() - 7)
  const pasadas = viernesEntre(viernesDesde, ultimaPasada.toISOString().slice(0, 10))
  const cerradas = obraCod
    ? await semanasCerradas(supabase, obraCod, pasadas, hoyISO)
    : pasadas
  if (cerradas.length === 0) return
  const rango = cerradas.length === 1 ? cerradas[0] : `${cerradas[0]} a ${cerradas[cerradas.length - 1]}`
  throw new HTTPException(409, {
    message: `AFECTA_SEMANAS_CERRADAS: el cambio rige desde ${desde} y recalcula ${cerradas.length} semana${cerradas.length === 1 ? '' : 's'} ya cerrada${cerradas.length === 1 ? '' : 's'} (${rango}). Confirmá para aplicarlo igual.`,
  })
}
