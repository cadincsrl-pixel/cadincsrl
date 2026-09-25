/**
 * Identidad de la empresa (tanda 6, 20260929a).
 *
 * - `CUIT_EMPRESA` es SINCRÓNICO y es la única fuente del CUIT en el backend:
 *   sale de `ARCA_CUIT` (va atado al certificado y al Auth de WSFE) o del
 *   default. No se edita desde la pantalla.
 * - `getEmpresa()` lee `empresa_config` (una fila) vía `empresa_config_json()`
 *   con caché en memoria de 60 s; si la base no responde, devuelve los
 *   defaults (los mismos valores que la semilla), nunca tira.
 *
 * Este archivo NO importa `lib/supabase.ts` arriba de todo: lo importan
 * reglas puras (facturación, lectura de facturas) que corren en los tests sin
 * variables de entorno, y ese módulo explota al importarse sin ellas.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const CUIT_EMPRESA_DEFAULT = '33717191949'

/** CUIT de la empresa (11 dígitos, sin guiones). */
export const CUIT_EMPRESA: string = (process.env.ARCA_CUIT ?? '').trim() || CUIT_EMPRESA_DEFAULT

/** 33717191949 → 33-71719194-9. Si no son 11 dígitos, lo devuelve igual. */
export function cuitFmt(cuit: string): string {
  const d = String(cuit ?? '').replace(/\D/g, '')
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : String(cuit ?? '')
}

export interface Empresa {
  razon_social: string
  nombre_fantasia: string
  cuit: string
  cuit_fmt: string
  condicion_iva: string
  iibb: string
  /** YYYY-MM-DD o null. */
  inicio_actividades: string | null
  domicilio_calle: string
  /** Calle como se imprime en la factura; '' = domicilio_calle. */
  calle_factura: string
  localidad: string
  provincia: string
  codigo_postal: string
  telefono: string
  email: string
  /** Derivados (los arma `empresa_config_json`). */
  domicilio: string
  domicilio_factura_1: string
  domicilio_factura_2: string
  updated_at: string | null
  updated_by: string | null
}

export interface EmpresaConSistema extends Empresa {
  cuit_sistema: { arca_cuit: string; coincide: boolean }
}

/** Lo que imprimen hoy los PDF: idéntico a la semilla de 20260929a. */
export function empresaDefault(): Empresa {
  return {
    razon_social: 'CADINC S.R.L.',
    nombre_fantasia: (process.env.EMPRESA_NOMBRE ?? '').trim() || 'CADINC SRL',
    cuit: CUIT_EMPRESA,
    cuit_fmt: cuitFmt(CUIT_EMPRESA),
    condicion_iva: 'Responsable Inscripto',
    iibb: '33-71719194-9',
    inicio_actividades: '2021-07-01',
    domicilio_calle: 'Maipú 396, Dpto. 3',
    calle_factura: 'Maipú 396 3',
    localidad: 'San Miguel de Tucumán',
    provincia: 'Tucumán',
    codigo_postal: '4000',
    telefono: '3815 02-5772',
    email: '',
    domicilio: 'Maipú 396, Dpto. 3 — San Miguel de Tucumán, Tucumán',
    domicilio_factura_1: 'Maipú 396 3 – San Miguel de Tucumán',
    domicilio_factura_2: '(4000) Tucumán Argentina',
    updated_at: null,
    updated_by: null,
  }
}

/** Le suma la comparación con el CUIT del sistema (ARCA_CUIT). */
export function conSistema(e: Empresa): EmpresaConSistema {
  return { ...e, cuit_sistema: { arca_cuit: CUIT_EMPRESA, coincide: e.cuit === CUIT_EMPRESA } }
}

const TTL_MS = 60_000
let cache: { valor: Empresa; hasta: number } | null = null

/** Normaliza lo que devuelve la RPC sobre los defaults (campos faltantes = default). */
export function empresaDesdeJson(j: unknown): Empresa {
  const base = empresaDefault()
  if (!j || typeof j !== 'object') return base
  const o = j as Record<string, unknown>
  const txt = (k: keyof Empresa) => (typeof o[k] === 'string' ? (o[k] as string) : (base[k] as string))
  return {
    razon_social: txt('razon_social'),
    nombre_fantasia: txt('nombre_fantasia'),
    cuit: txt('cuit'),
    cuit_fmt: typeof o.cuit_fmt === 'string' ? o.cuit_fmt : cuitFmt(txt('cuit')),
    condicion_iva: txt('condicion_iva'),
    iibb: txt('iibb'),
    inicio_actividades: typeof o.inicio_actividades === 'string' ? o.inicio_actividades : null,
    domicilio_calle: txt('domicilio_calle'),
    calle_factura: txt('calle_factura'),
    localidad: txt('localidad'),
    provincia: txt('provincia'),
    codigo_postal: txt('codigo_postal'),
    telefono: txt('telefono'),
    email: txt('email'),
    domicilio: txt('domicilio'),
    domicilio_factura_1: txt('domicilio_factura_1'),
    domicilio_factura_2: txt('domicilio_factura_2'),
    updated_at: typeof o.updated_at === 'string' ? o.updated_at : null,
    updated_by: typeof o.updated_by === 'string' ? o.updated_by : null,
  }
}

/**
 * Datos de la empresa, con caché de 60 s. Con varias instancias, un cambio
 * tarda hasta un minuto en verse en las otras (aceptado en la spec).
 */
export async function getEmpresa(db?: SupabaseClient): Promise<Empresa> {
  const ahora = Date.now()
  if (cache && cache.hasta > ahora) return cache.valor
  try {
    const cli = db ?? (await import('./supabase.js')).supabase
    const { data, error } = await cli.rpc('empresa_config_json')
    if (error || !data) throw error ?? new Error('sin fila')
    const valor = empresaDesdeJson(data)
    cache = { valor, hasta: ahora + TTL_MS }
    return valor
  } catch (e) {
    console.warn('[empresa] no se pudo leer empresa_config, uso los defaults:', (e as Error)?.message ?? e)
    return empresaDefault()
  }
}

/** Se llama después de cada escritura. */
export function invalidarEmpresa(): void {
  cache = null
}

/** Para los tests. */
export function _fijarEmpresaEnCache(e: Empresa | null): void {
  cache = e ? { valor: e, hasta: Date.now() + TTL_MS } : null
}
