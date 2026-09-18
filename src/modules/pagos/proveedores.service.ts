/**
 * Padrón propio de proveedores de Pagos (`pagos_proveedores`, diseño v3 §4.1).
 *
 * NO se cruza con `public.proveedores` (el padrón de Compras): sin FK, sin
 * sincronización, sin lectura. Decisión del dueño (§11.37): se carga de nuevo
 * con CUIT, alias o CBU.
 *
 * Reglas que viven acá y en la base:
 *   - CUIT opcional pero único, con dígito verificador (`cuitValido`).
 *   - CBU de 22 dígitos con los DOS verificadores (`cbuValido` ↔ `cbu_valido()`).
 *   - Alias en minúsculas, formato `^[a-z0-9.-]{6,20}$`.
 *   - Dedup GLOBAL por índice (cuit / cbu / alias): un dado de baja no se
 *     duplica, se reactiva. El 409 trae `activo` y NUNCA el CBU ajeno.
 *   - Cambiar `cbu`/`alias_cbu` de un proveedor con aprobadas sin pagar las
 *     devuelve a `pendiente` (trigger fn_pagos_proveedor_cuenta_cambiada);
 *     el backend devuelve `avisos: [{ code: 'APROBACION_RETIRADA', factura_ids }]`.
 *   - CBU y alias son PII: sin `ver_pii` se ven `***1234`.
 */
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { PagosHttpError, errorDeCampo } from './pagos.errors.js'
import { normCuit, cuitValido, normCbu, cbuValido, normAlias, aliasValido, enmascarar, enmascararTexto } from './pagos.util.js'
import { esBoolQ, type CreateProveedorDto, type UpdateProveedorDto, type DatosPagoDto, type ListProveedoresQuery } from './pagos.schema.js'

const COLS_PADRON = 'id, razon_social, razon_social_norm, cuit, alias_cbu, cbu, banco, plazo_pago_dias, contacto, telefono, email, obs, activo, baja_motivo, baja_por, baja_at, datos_pago_actualizados_at, datos_pago_actualizados_por, created_at, updated_at, created_by, updated_by'

export interface Aviso { code: string; [k: string]: unknown }

/** Enmascara CBU y alias de una fila del padrón (o de cualquier fila con esas claves). */
export function enmascararProveedor<T extends Record<string, unknown>>(row: T, verPii: boolean): T {
  const out: Record<string, unknown> = { ...row }
  for (const k of ['cbu', 'alias_cbu']) {
    if (k in out) out[k] = enmascarar(out[k] as string | null, verPii)
  }
  if ('cbu' in row && !('cbu_ultimos4' in out)) out.cbu_ultimos4 = row.cbu ? String(row.cbu).slice(-4) : null
  return out as T
}

function palabras(q?: string): string[] {
  return normTxt(q ?? '').split(' ').filter(Boolean).slice(0, 6)
}

/** Normaliza y valida lo que entra (400 { error, campo }). Devuelve solo las claves presentes. */
function normalizar(dto: Partial<CreateProveedorDto>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (dto.razon_social !== undefined) {
    out.razon_social = dto.razon_social
    out.razon_social_norm = normTxt(dto.razon_social)
  }
  if (dto.cuit !== undefined) {
    const cuit = normCuit(dto.cuit)
    if (cuit !== null && !cuitValido(cuit)) throw errorDeCampo('CUIT_INVALIDO', 'cuit')
    out.cuit = cuit
  }
  if (dto.cbu !== undefined) {
    const cbu = normCbu(dto.cbu)
    if (cbu !== null && !cbuValido(cbu)) throw errorDeCampo('CBU_INVALIDO', 'cbu')
    out.cbu = cbu
  }
  if (dto.alias_cbu !== undefined) {
    const alias = normAlias(dto.alias_cbu)
    if (alias !== null && !aliasValido(alias)) throw errorDeCampo('ALIAS_INVALIDO', 'alias_cbu')
    out.alias_cbu = alias
  }
  for (const k of ['banco', 'plazo_pago_dias', 'contacto', 'telefono', 'email', 'obs'] as const) {
    if (dto[k] !== undefined) out[k] = dto[k]
  }
  return out
}

/**
 * 23505 → 409 PROVEEDOR_DUPLICADO { id, razon_social, activo, campo } por
 * nombre de índice. Se busca al existente por el valor que chocó, así la UI
 * ofrece «Usar este» o «Reactivar». Nunca se devuelve el CBU ajeno.
 */
async function mapDuplicado(error: { code?: string; message?: string; details?: string | null }, valores: Record<string, unknown>): Promise<PagosHttpError | null> {
  const es23505 = error.code === '23505' || /unique/i.test(error.message ?? '')
  if (!es23505) return null
  const txt = `${error.message ?? ''} ${error.details ?? ''}`
  const campo: 'cuit' | 'cbu' | 'alias_cbu' | null =
    /cuit/i.test(txt) ? 'cuit' : /alias/i.test(txt) ? 'alias_cbu' : /cbu/i.test(txt) ? 'cbu' : null
  if (!campo) return new PagosHttpError(409, 'PROVEEDOR_DUPLICADO', { campo: null })
  const valor = valores[campo]
  type Existente = { id: number; razon_social: string; activo: boolean }
  let existente: Existente | null = null
  if (valor != null) {
    const { data } = await supabase.from('pagos_proveedores').select('id, razon_social, activo').eq(campo, valor as string).maybeSingle()
    existente = (data as Existente | null) ?? null
  }
  return new PagosHttpError(409, 'PROVEEDOR_DUPLICADO', {
    campo, id: existente?.id ?? null, razon_social: existente?.razon_social ?? null, activo: existente?.activo ?? null,
  })
}

/** Ids de facturas `aprobada` del proveedor: las que el trigger va a desaprobar si cambia la cuenta. */
async function aprobadasDe(proveedorId: number): Promise<number[]> {
  const { data } = await supabase.from('pagos_facturas').select('id').eq('proveedor_id', proveedorId).eq('estado', 'aprobada').order('id')
  return ((data ?? []) as { id: number }[]).map((r) => r.id)
}

async function actualizar(id: number, dto: Partial<CreateProveedorDto>, userId: string, token: string) {
  const cambios = normalizar(dto)
  const sb = createSupabaseClient(token)
  const { data: actual, error: e0 } = await sb.from('pagos_proveedores').select('id, cbu, alias_cbu, activo').eq('id', id).maybeSingle()
  if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
  if (!actual) throw new PagosHttpError(404, 'PROVEEDOR_NO_EXISTE')
  const a = actual as { cbu: string | null; alias_cbu: string | null }

  const cambiaCuenta = ('cbu' in cambios && cambios.cbu !== a.cbu) || ('alias_cbu' in cambios && cambios.alias_cbu !== a.alias_cbu)
  const factura_ids = cambiaCuenta ? await aprobadasDe(id) : []

  if (Object.keys(cambios).length === 0) {
    const { data } = await sb.from('pagos_proveedores').select(COLS_PADRON).eq('id', id).single()
    return { proveedor: data as Record<string, unknown>, avisos: [] as Aviso[] }
  }
  const { data, error } = await sb
    .from('pagos_proveedores').update({ ...cambios, updated_by: userId }).eq('id', id).select(COLS_PADRON).single()
  if (error) {
    const dup = await mapDuplicado(error, cambios)
    if (dup) throw dup
    throw new PagosHttpError(500, 'DB_ERROR', error.message)
  }
  const avisos: Aviso[] = []
  if (cambiaCuenta && factura_ids.length > 0) avisos.push({ code: 'APROBACION_RETIRADA', factura_ids })
  return { proveedor: data as Record<string, unknown>, avisos }
}

export const proveedoresService = {

  async listar(f: ListProveedoresQuery, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb.from('v_pagos_proveedores').select('*', { count: 'exact' })
    if (!esBoolQ(f.inactivos)) q = q.eq('activo', true)
    if (esBoolQ(f.sin_cuit)) q = q.is('cuit', null)
    if (esBoolQ(f.sin_datos_pago)) q = q.is('cbu', null).is('alias_cbu', null)
    for (const w of palabras(f.q)) q = q.ilike('busq', `%${w}%`)
    const { data, error, count } = await q.order('razon_social_norm').order('id').range(f.offset, f.offset + f.limit - 1)
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    const items = ((data ?? []) as Record<string, unknown>[]).map((r) => enmascararProveedor(r, verPii))
    const total = count ?? items.length
    return { items, total, limit: f.limit, offset: f.offset, hasMore: f.offset + items.length < total }
  },

  /** «Deuda por proveedor»: activos e inactivos con saldo, ordenado por vencido desc. */
  async saldos(verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) =>
      sb.from('v_pagos_proveedor_saldo').select('*').order('vencido', { ascending: false }).order('saldo', { ascending: false }).order('proveedor_id').range(d, h))
    return filas.map((r) => enmascararProveedor(r, verPii))
  },

  async exportar(verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) =>
      sb.from('v_pagos_proveedores').select('*').order('razon_social_norm').order('id').range(d, h))
    return filas.map((r) => enmascararProveedor(r, verPii))
  },

  /** Ficha + historial de datos de pago (de audit_log, enmascarado) + facturas abiertas. */
  async detalle(id: number, verPii: boolean, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb.from('v_pagos_proveedores').select('*').eq('id', id).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'PROVEEDOR_NO_EXISTE')

    const [hist, abiertas] = await Promise.all([
      supabase.from('audit_log')
        .select('id, created_at, user_id, user_nombre, detalle')
        .eq('modulo', 'pagos').eq('entidad', 'proveedor (pagos)').eq('entidad_id', String(id))
        .or('detalle.ilike.%cbu:%,detalle.ilike.%alias_cbu:%')
        .order('created_at', { ascending: false }).limit(50),
      sb.from('v_pagos_facturas')
        .select('id, tipo_comprobante, numero, fecha, vence_el, total, saldo, estado, vencida, descripcion')
        .eq('proveedor_id', id).in('estado', ['pendiente', 'observada', 'aprobada', 'pagada_parcial'])
        .order('vence_el', { ascending: true, nullsFirst: false }).order('id').limit(200),
    ])
    const historial_datos_pago = ((hist.data ?? []) as { id: number; created_at: string; user_id: string | null; user_nombre: string | null; detalle: string }[])
      .map((h) => ({ ...h, detalle: enmascararTexto(h.detalle ?? '', verPii) }))
    return {
      ...enmascararProveedor(data as Record<string, unknown>, verPii),
      historial_datos_pago,
      facturas_abiertas: abiertas.data ?? [],
    }
  },

  /**
   * Alta (desde el tab o «alta rápida» del modal de factura). Parecidos por
   * razón social solo AVISAN (`PROVEEDOR_PARECIDO`), salvo `forzar`, que
   * saltea la búsqueda; el dedup duro es por CUIT / CBU / alias.
   */
  async crear(dto: CreateProveedorDto, userId: string, forzar: boolean, token: string) {
    const valores = normalizar(dto)
    const avisos: Aviso[] = []
    if (!forzar) {
      // Parecidos por palabra (≥ 4 letras) sobre razon_social_norm: «Silva» y
      // «Silva Hnos» pueden ser dos, por eso solo avisa. Sin pg_trgm desde
      // PostgREST; si hace falta similarity, es una RPC aparte.
      const pal = (valores.razon_social_norm as string).split(' ').filter((w) => w.length >= 4).slice(0, 4)
      if (pal.length > 0) {
        const { data } = await supabase
          .from('pagos_proveedores').select('id, razon_social, activo')
          .or(pal.map((w) => `razon_social_norm.ilike.%${w}%`).join(','))
          .order('id').limit(5)
        const cand = (data ?? []) as { id: number; razon_social: string; activo: boolean }[]
        if (cand.length > 0) avisos.push({ code: 'PROVEEDOR_PARECIDO', candidatos: cand })
      }
    }
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('pagos_proveedores')
      .insert({ ...valores, created_by: userId, updated_by: userId })
      .select(COLS_PADRON).single()
    if (error) {
      const dup = await mapDuplicado(error, valores)
      if (dup) throw dup
      if (error.code === '23514') throw new PagosHttpError(400, 'PROVEEDOR_INVALIDO', error.message)
      throw new PagosHttpError(500, 'DB_ERROR', error.message)
    }
    return { proveedor: data as Record<string, unknown>, avisos }
  },

  async editar(id: number, dto: UpdateProveedorDto, userId: string, token: string) {
    return actualizar(id, dto, userId, token)
  },

  /** La puerta del contador: solo datos de pago (razón social y CUIT no pasan por acá; el schema ya los excluye). */
  async datosPago(id: number, dto: DatosPagoDto, userId: string, token: string) {
    return actualizar(id, dto, userId, token)
  },

  async baja(id: number, motivo: string, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data: s, error: e0 } = await sb.from('v_pagos_proveedor_saldo').select('saldo').eq('proveedor_id', id).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    const saldo = Number((s as { saldo?: number } | null)?.saldo ?? 0)
    if (saldo > 0) throw new PagosHttpError(409, 'PROVEEDOR_CON_SALDO', { saldo })
    const { data, error } = await sb
      .from('pagos_proveedores')
      .update({ activo: false, baja_motivo: motivo, baja_por: userId, baja_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id).eq('activo', true).select('id, activo').maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(409, 'PROVEEDOR_INACTIVO', { proveedor_id: id })
    return { success: true, id, activo: false }
  },

  async reactivar(id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('pagos_proveedores')
      .update({ activo: true, baja_motivo: null, baja_por: null, baja_at: null, updated_by: userId })
      .eq('id', id).select('id, activo').maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!data) throw new PagosHttpError(404, 'PROVEEDOR_NO_EXISTE')
    return { success: true, id, activo: true }
  },
}
