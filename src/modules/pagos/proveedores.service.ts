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
import { PagosHttpError, errorDeCampo, errorPadronPagos, mapRpcError } from './pagos.errors.js'
import { normCuit, cuitValido, normCbu, cbuValido, normAlias, aliasValido, enmascarar, enmascararTexto } from './pagos.util.js'
import { consultarPersona, type PersonaPadron } from '../../lib/arca/index.js'
import { padronJson, precargaPadron, type PrecargaPadron } from '../../lib/arca/padron-datos.js'
import { CONDICIONES_IVA_IDS } from './condicion-iva.js'
import { esBoolQ, type ContactoProveedorDto, type CreateProveedorDto, type UpdateProveedorDto, type DatosPagoDto, type ListProveedoresQuery } from './pagos.schema.js'

const COLS_PADRON = 'id, razon_social, razon_social_norm, cuit, alias_cbu, cbu, banco, plazo_pago_dias, vencimiento_modo, cierre_dia, contacto, telefono, email, obs, activo, baja_motivo, baja_por, baja_at, datos_pago_actualizados_at, datos_pago_actualizados_por, created_at, updated_at, created_by, updated_by, domicilio, provincia, condicion_iva_id, tipo_persona, actividad_principal, padron_consultado_at'

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
  for (const k of ['banco', 'plazo_pago_dias', 'vencimiento_modo', 'contacto', 'telefono', 'email', 'obs'] as const) {
    if (dto[k] !== undefined) out[k] = dto[k]
  }
  // Datos fiscales (20260925o): vacío = null (no se sabe), no ''.
  for (const k of ['domicilio', 'provincia'] as const) {
    if (dto[k] !== undefined) out[k] = dto[k]?.trim() || null
  }
  if (dto.condicion_iva_id !== undefined) {
    if (dto.condicion_iva_id !== null && !CONDICIONES_IVA_IDS.has(dto.condicion_iva_id)) {
      throw errorDeCampo('CONDICION_IVA_INVALIDA', 'condicion_iva_id', { condicion_iva_id: dto.condicion_iva_id })
    }
    out.condicion_iva_id = dto.condicion_iva_id
  }
  // `cierre_dia` va aparte porque el CHECK de la tabla lo ata al modo: sólo
  // se admite con `cierre_mensual`. Al volver a 'dias' hay que limpiarlo en el
  // mismo UPDATE o el constraint rebota con el valor viejo.
  if (dto.vencimiento_modo === 'dias') out.cierre_dia = null
  else if (dto.cierre_dia !== undefined) out.cierre_dia = dto.cierre_dia
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

/**
 * Ids de facturas `aprobada` del proveedor: las que el trigger va a desaprobar
 * si cambia la cuenta. Solo `clase = 'factura'`: una NC no se paga, así que
 * el cambio de CBU no le retira la aprobación (`fn_pagos_proveedor_cuenta_cambiada`, 20260925b).
 */
async function aprobadasDe(proveedorId: number): Promise<number[]> {
  const { data } = await supabase.from('pagos_facturas').select('id').eq('proveedor_id', proveedorId).eq('clase', 'factura').eq('estado', 'aprobada').order('id')
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

// ── Padrón de ARCA (20260925o) ─────────────────────────────────────────────

/** El padrón como lo muestra Compras: el de Ventas + domicilio y provincia en una línea. */
export type PadronProveedor = PersonaPadron & { domicilio: string; provincia: string }

export interface ResultadoPadronProveedor {
  cuit: string
  precarga: PrecargaPadron
  padron: PadronProveedor
  consultado_at: string
}

export interface DiferenciaPadron { campo: string; actual: unknown; arca: unknown; aplicado: boolean }

/** La actividad que se guarda: la primera por orden (el padrón ya las trae ordenadas). */
export function actividadPrincipal(p: PersonaPadron): string | null {
  const a = p.actividades.find((x) => x.descripcion?.trim())
  return a ? a.descripcion.trim() : null
}

/**
 * Qué cambia en el proveedor con lo que dice ARCA. Domicilio, provincia,
 * tipo de persona y actividad se pisan siempre (si ARCA los trae). La
 * condición de IVA también, SALVO que ARCA la marque dudosa y el proveedor ya
 * tenga una cargada: ahí sólo se informa (con `todo` se pisa igual). La razón
 * social sólo con `todo`. Pura, para testear sin ARCA.
 */
export function cambiosProveedorDesdePadron(
  actual: Record<string, unknown>,
  p: PersonaPadron,
  todo: boolean,
): { upd: Record<string, unknown>; diferencias: DiferenciaPadron[] } {
  const pre = precargaPadron(p, CONDICIONES_IVA_IDS)
  const upd: Record<string, unknown> = {}
  const diferencias: DiferenciaPadron[] = []
  const str = (v: unknown) => (v == null ? '' : String(v).trim())

  const siempre: Array<[string, string]> = [
    ['domicilio', pre.domicilio], ['provincia', pre.provincia],
    ['tipo_persona', str(p.tipo_persona)], ['actividad_principal', actividadPrincipal(p) ?? ''],
  ]
  for (const [k, v] of siempre) {
    if (v && v !== str(actual[k])) {
      upd[k] = v
      diferencias.push({ campo: k, actual: str(actual[k]) || null, arca: v, aplicado: true })
    }
  }
  if (pre.razon_social && pre.razon_social !== str(actual.razon_social)) {
    const aplicar = todo || !str(actual.razon_social)
    if (aplicar) {
      upd.razon_social = pre.razon_social
      upd.razon_social_norm = normTxt(pre.razon_social)
    }
    diferencias.push({ campo: 'razon_social', actual: str(actual.razon_social), arca: pre.razon_social, aplicado: aplicar })
  }
  const condActual = actual.condicion_iva_id == null ? null : Number(actual.condicion_iva_id)
  if (pre.condicion_iva_id !== condActual) {
    const aplicar = todo || condActual == null || !p.condicion_iva_dudosa
    if (aplicar) upd.condicion_iva_id = pre.condicion_iva_id
    diferencias.push({ campo: 'condicion_iva_id', actual: condActual, arca: pre.condicion_iva_id, aplicado: aplicar })
  }
  return { upd, diferencias }
}

/** CUIT de 11 dígitos con verificador, o null. */
function cuitConsultable(v: unknown): string | null {
  const c = normCuit(v == null ? null : String(v))
  return c && /^\d{11}$/.test(c) && cuitValido(c) ? c : null
}

async function consultarPadron(cuitCrudo: string): Promise<ResultadoPadronProveedor> {
  const cuit = cuitConsultable(cuitCrudo)
  if (!cuit) throw errorDeCampo('CUIT_INVALIDO', 'cuit', { cuit: String(cuitCrudo ?? '') })
  let p: PersonaPadron
  try {
    p = await consultarPersona(cuit)
  } catch (e) {
    throw errorPadronPagos(e, cuit)
  }
  const precarga = precargaPadron(p, CONDICIONES_IVA_IDS)
  return {
    cuit, precarga,
    padron: { ...p, domicilio: precarga.domicilio, provincia: precarga.provincia },
    consultado_at: new Date().toISOString(),
  }
}

/** Pausa entre consultas del masivo: ARCA limita y no hay apuro. */
export const PAUSA_MASIVO_MS = 300
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

    const [hist, abiertas, contactos] = await Promise.all([
      supabase.from('audit_log')
        .select('id, created_at, user_id, user_nombre, detalle')
        .eq('modulo', 'pagos').eq('entidad', 'proveedor (pagos)').eq('entidad_id', String(id))
        .or('detalle.ilike.%cbu:%,detalle.ilike.%alias_cbu:%')
        .order('created_at', { ascending: false }).limit(50),
      // Solo facturas: una NC tiene saldo 0 (no es deuda); su crédito sin
      // aplicar está en `nc_disponible` de la fila del proveedor.
      sb.from('v_pagos_facturas')
        .select('id, tipo_comprobante, numero, fecha, vence_el, total, saldo, saldo_pagable, nc_pendiente, acreditado, nc_txt, estado, vencida, descripcion')
        .eq('proveedor_id', id).eq('clase', 'factura').in('estado', ['pendiente', 'observada', 'aprobada', 'pagada_parcial'])
        // Las importadas de meses ya pagados no son deuda (20260928b): van aparte en `a_reconstruir`.
        .eq('pago_a_reconstruir', false)
        .order('vence_el', { ascending: true, nullsFirst: false }).order('id').limit(200),
      sb.from('pagos_proveedor_contactos')
        .select('id, nombre, rol, email, telefono, recibe_avisos, orden, obs')
        .eq('proveedor_id', id).order('orden').order('id'),
    ])
    const historial_datos_pago = ((hist.data ?? []) as { id: number; created_at: string; user_id: string | null; user_nombre: string | null; detalle: string }[])
      .map((h) => ({ ...h, detalle: enmascararTexto(h.detalle ?? '', verPii) }))
    return {
      ...enmascararProveedor(data as Record<string, unknown>, verPii),
      historial_datos_pago,
      facturas_abiertas: abiertas.data ?? [],
      contactos: contactos.data ?? [],
    }
  },

  /** Reemplaza la lista de contactos (RPC transaccional, 20260925f). */
  async setContactos(id: number, contactos: ContactoProveedorDto[], userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const lista = contactos.map((k) => ({ ...k, email: k.email?.trim() || null }))
    const { data, error } = await sb.rpc('pagos_guardar_contactos', { p_proveedor_id: id, p_contactos: lista, p_user_id: userId })
    if (error) {
      if (error.code === '23505') throw new PagosHttpError(409, 'CONTACTO_EMAIL_DUPLICADO', { dbMessage: error.message })
      throw mapRpcError(error)
    }
    return { contactos: data ?? [] }
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

  /** Lo que dice ARCA de un CUIT, para precargar el alta. NO guarda nada. */
  async padron(cuit: string): Promise<ResultadoPadronProveedor> {
    return consultarPadron(cuit)
  },

  /**
   * Pisa los datos fiscales del proveedor con los de ARCA (ver
   * `cambiosProveedorDesdePadron`) y guarda el padrón entero en
   * `padron_json` / `padron_consultado_at`. Por el cliente per-request: el
   * trigger de auditoría ve al usuario.
   */
  async actualizarDesdeArca(id: number, opts: { todo?: boolean }, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data: actual, error: e0 } = await sb.from('pagos_proveedores')
      .select('id, razon_social, cuit, domicilio, provincia, condicion_iva_id, tipo_persona, actividad_principal')
      .eq('id', id).maybeSingle()
    if (e0) throw new PagosHttpError(500, 'DB_ERROR', e0.message)
    if (!actual) throw new PagosHttpError(404, 'PROVEEDOR_NO_EXISTE')
    const a = actual as Record<string, unknown>
    if (!a.cuit) throw errorDeCampo('PROVEEDOR_SIN_CUIT', 'cuit', { proveedor_id: id })

    const r = await consultarPadron(String(a.cuit))
    const { upd, diferencias } = cambiosProveedorDesdePadron(a, r.padron, !!opts.todo)
    const { data, error } = await sb.from('pagos_proveedores').update({
      ...upd,
      padron_json: padronJson(r.padron, r.consultado_at),
      padron_consultado_at: r.consultado_at,
      updated_by: userId,
    }).eq('id', id).select(COLS_PADRON).single()
    if (error) {
      if (error.code === '23514') throw new PagosHttpError(400, 'PROVEEDOR_INVALIDO', { dbMessage: error.message })
      const dup = await mapDuplicado(error, upd)
      if (dup) throw dup
      throw new PagosHttpError(500, 'DB_ERROR', error.message)
    }
    return { proveedor: data as Record<string, unknown>, diferencias }
  },

  /**
   * Todos los activos con CUIT válido, DE A UNO y con una pausa corta: ARCA
   * limita las consultas y un error de un proveedor no frena a los demás.
   * Nunca pisa la razón social. Si ARCA no está disponible o el certificado
   * no está autorizado (503), se corta: seguir sería sumar el mismo error N
   * veces; lo que faltó sale en `pendientes`.
   */
  async actualizarTodosDesdeArca(userId: string, token: string, pausaMs = PAUSA_MASIVO_MS) {
    const sb = createSupabaseClient(token)
    const activos = await todasLasFilas<{ id: number; razon_social: string; cuit: string | null }>((d, h) =>
      sb.from('pagos_proveedores').select('id, razon_social, cuit').eq('activo', true).order('id').range(d, h))
    const conCuit = activos.filter((p) => cuitConsultable(p.cuit))
    const sin_cuit = activos.length - conCuit.length
    let actualizados = 0
    const errores: { proveedor_id: number; razon_social: string; error: string }[] = []
    let interrumpido = false
    let pendientes = 0
    for (let i = 0; i < conCuit.length; i++) {
      const p = conCuit[i]!
      if (i > 0 && pausaMs > 0) await dormir(pausaMs)
      try {
        await this.actualizarDesdeArca(p.id, { todo: false }, userId, token)
        actualizados++
      } catch (e) {
        const code = e instanceof PagosHttpError ? e.code : 'ERROR'
        errores.push({ proveedor_id: p.id, razon_social: p.razon_social, error: code })
        if (e instanceof PagosHttpError && e.status === 503) {
          interrumpido = true
          pendientes = conCuit.length - i - 1
          break
        }
      }
    }
    console.log(`[pagos] padrón ARCA masivo: ${actualizados} actualizados, ${errores.length} con error, ${sin_cuit} sin CUIT${interrumpido ? `, cortado con ${pendientes} pendientes` : ''}`)
    return { actualizados, sin_cuit, errores, total: activos.length, interrumpido, pendientes }
  },
}
