/**
 * Cuentas de tesorería de CADINC (`tesoreria_cuentas`, 20260926b): bancos,
 * caja y valores. Son la fuente de la «cuenta de origen» de una OP de Pagos y
 * del auxiliar `tesoreria` de los asientos. Ventas sigue usando
 * `ventas_cuentas_bancarias` para la FCE (decisión 1 de la spec); el vínculo
 * `ventas_cuenta_id` es solo para conciliar más adelante.
 *
 * Se escriben por tabla (no hay RPC): el trigger `fn_tesoreria_cuenta_valida`
 * frena una cuenta contable que no sea imputable, activa y de rubro activo
 * (CUENTA_TESORERIA_INVALIDA) y los índices únicos parciales frenan nombre y
 * CBU repetidos entre las activas (TESORERIA_DUPLICADA).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { cbuValido, normCbu } from '../pagos/pagos.util.js'
import { ContabilidadHttpError, errorDeCampo, mapRpcError, type PgError } from './contabilidad.errors.js'
import type { TesoreriaDto, UpdateTesoreriaDto } from './contabilidad.schema.js'

const ALIAS_RE = /^[A-Za-z0-9.-]{6,20}$/
const COLS = 'id, tipo, nombre, banco, cbu, alias, moneda, cuenta_id, ventas_cuenta_id, activo, obs, created_at, updated_at, cuenta:cont_cuentas(codigo, nombre)'

type FilaDb = Record<string, unknown> & { cuenta?: { codigo: string; nombre: string } | { codigo: string; nombre: string }[] | null }

export interface TesoreriaCuenta {
  id: number; tipo: 'banco' | 'caja' | 'valores' | 'tarjeta' | 'billetera'; nombre: string; banco: string; cbu: string | null; alias: string | null
  moneda: 'ARS' | 'USD'; cuenta_id: number | null; cuenta_codigo: string | null; cuenta_nombre: string | null
  ventas_cuenta_id: number | null; activo: boolean; obs: string; created_at: string; updated_at: string
}

function aplanar(f: FilaDb): TesoreriaCuenta {
  const { cuenta, ...resto } = f
  const c = Array.isArray(cuenta) ? cuenta[0] : cuenta
  return { ...(resto as unknown as TesoreriaCuenta), cuenta_codigo: c?.codigo ?? null, cuenta_nombre: c?.nombre ?? null }
}

/** Tipos que llevan CBU (o CVU, en la billetera) y alias (20260927h). */
export const TIPOS_CON_CBU = ['banco', 'billetera'] as const
export const llevaCbu = (tipo: string) => (TIPOS_CON_CBU as readonly string[]).includes(tipo)

/**
 * CBU y alias solo en bancos y billeteras (CHECK de la tabla; la billetera
 * lleva el CVU, que se valida igual que un CBU). CBU con verificadores
 * (`cbu_valido()` de la base); alias 6 a 20 letras, números, punto o guion.
 * La tarjeta de crédito no lleva ninguno: `banco` es el emisor.
 */
export function validarDatosBanco(tipo: string, cbu: string | null | undefined, alias: string | null | undefined): { cbu: string | null; alias: string | null } {
  const c = cbu ? normCbu(cbu) : null
  const a = alias?.trim() ? alias.trim() : null
  if (!llevaCbu(tipo)) {
    if (c) throw errorDeCampo('CBU_INVALIDO', 'cbu', { motivo: 'solo_bancos' })
    if (a) throw errorDeCampo('ALIAS_INVALIDO', 'alias', { motivo: 'solo_bancos' })
    return { cbu: null, alias: null }
  }
  if (cbu != null && cbu !== '' && (!c || !cbuValido(c))) throw errorDeCampo('CBU_INVALIDO', 'cbu')
  if (a && !ALIAS_RE.test(a)) throw errorDeCampo('ALIAS_INVALIDO', 'alias')
  return { cbu: c, alias: a ? a.toUpperCase() : null }
}

function errorEscritura(error: PgError): ContabilidadHttpError {
  if (error.code === '23505') {
    const m = error.message ?? ''
    const campo = m.includes('ventas_cuenta') ? 'ventas_cuenta_id' : m.includes('cbu') ? 'cbu' : 'nombre'
    return new ContabilidadHttpError(409, 'TESORERIA_DUPLICADA', { campo })
  }
  if (error.code === '23503') {
    const m = error.message ?? ''
    const campo = m.includes('ventas_cuenta') ? 'ventas_cuenta_id' : 'cuenta_id'
    return new ContabilidadHttpError(400, 'DATOS_INVALIDOS', { campo, mensaje: 'la cuenta vinculada no existe' })
  }
  const e = mapRpcError(error)
  if (e.code === 'CUENTA_TESORERIA_INVALIDA') {
    e.detail = { campo: 'cuenta_id', ...((e.detail && typeof e.detail === 'object') ? e.detail as object : {}) }
  }
  return e
}

export const tesoreriaService = {
  async listar(incluirInactivas: boolean, db: SupabaseClient = supabase): Promise<TesoreriaCuenta[]> {
    let q = db.from('tesoreria_cuentas').select(COLS)
    if (!incluirInactivas) q = q.eq('activo', true)
    const { data, error } = await q.order('tipo').order('nombre').order('id')
    if (error) throw mapRpcError(error as PgError)
    return ((data ?? []) as FilaDb[]).map(aplanar)
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<TesoreriaCuenta> {
    const { data, error } = await db.from('tesoreria_cuentas').select(COLS).eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new ContabilidadHttpError(404, 'TESORERIA_NO_EXISTE', { tesoreria_id: id })
    return aplanar(data as FilaDb)
  },

  async crear(dto: TesoreriaDto, userId: string, db: SupabaseClient = supabase): Promise<TesoreriaCuenta> {
    const { cbu, alias } = validarDatosBanco(dto.tipo, dto.cbu, dto.alias)
    const { data, error } = await db.from('tesoreria_cuentas').insert({
      tipo: dto.tipo, nombre: dto.nombre.trim(), banco: (dto.banco ?? '').trim(), cbu, alias,
      moneda: dto.moneda, cuenta_id: dto.cuenta_id ?? null, ventas_cuenta_id: dto.ventas_cuenta_id ?? null,
      obs: (dto.obs ?? '').trim(), created_by: userId, updated_by: userId,
    }).select('id').single()
    if (error) throw errorEscritura(error as PgError)
    return this.detalle((data as { id: number }).id, db)
  },

  async editar(id: number, dto: UpdateTesoreriaDto, userId: string, db: SupabaseClient = supabase): Promise<TesoreriaCuenta> {
    const a = await this.detalle(id, db)
    const upd: Record<string, unknown> = { updated_by: userId }
    const tipo = dto.tipo ?? a.tipo
    if (dto.tipo !== undefined || dto.cbu !== undefined || dto.alias !== undefined) {
      // Pasar de banco a caja limpia CBU y alias si no se mandan.
      const cbuIn = dto.cbu !== undefined ? dto.cbu : (llevaCbu(tipo) ? a.cbu : null)
      const aliasIn = dto.alias !== undefined ? dto.alias : (llevaCbu(tipo) ? a.alias : null)
      const v = validarDatosBanco(tipo, cbuIn, aliasIn)
      upd.tipo = tipo
      upd.cbu = v.cbu
      upd.alias = v.alias
    }
    if (dto.nombre !== undefined) upd.nombre = dto.nombre.trim()
    if (dto.banco !== undefined) upd.banco = dto.banco.trim()
    if (dto.moneda !== undefined) upd.moneda = dto.moneda
    // Solo si cambió: el trigger valida la cuenta en cada UPDATE OF cuenta_id, y
    // reenviar una que después se dio de baja trabaría editar el nombre.
    if (dto.cuenta_id !== undefined && dto.cuenta_id !== a.cuenta_id) upd.cuenta_id = dto.cuenta_id
    if (dto.ventas_cuenta_id !== undefined) upd.ventas_cuenta_id = dto.ventas_cuenta_id
    if (dto.obs !== undefined) upd.obs = dto.obs.trim()
    const { error } = await db.from('tesoreria_cuentas').update(upd).eq('id', id)
    if (error) throw errorEscritura(error as PgError)
    return this.detalle(id, db)
  },

  async setActivo(id: number, activo: boolean, userId: string, db: SupabaseClient = supabase): Promise<TesoreriaCuenta> {
    const a = await this.detalle(id, db)
    if (a.activo === activo) return a
    const { error } = await db.from('tesoreria_cuentas').update({ activo, updated_by: userId }).eq('id', id)
    if (error) throw errorEscritura(error as PgError)
    return this.detalle(id, db)
  },
}
