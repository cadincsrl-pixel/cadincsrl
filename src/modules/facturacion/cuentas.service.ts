/**
 * Cuentas bancarias de CADINC para la FCE MiPyME (`ventas_cuentas_bancarias`,
 * 20260924e). El CBU y el alias van a ARCA en la factura (opcionales 2101 y
 * 2102); la factura guarda una FOTO al guardarse, así que editar una cuenta no
 * cambia lo ya emitido.
 *
 * Una sola cuenta por defecto (índice único parcial). La que prefiere un
 * cliente vive en `ventas_clientes.cuenta_fce_id`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { cbuValido, normCbu } from '../pagos/pagos.util.js'
import { FacturacionHttpError, errorDeCampo, mapRpcError, type PgError } from './facturacion.errors.js'
import type { CuentaDto, UpdateCuentaDto } from './facturacion.schema.js'

export interface CuentaBancaria {
  id: number
  banco: string
  cbu: string
  alias: string
  es_default: boolean
  activo: boolean
  obs: string
  created_at: string
  updated_at: string
  /** Clientes que la tienen como preferida. */
  clientes: Array<{ id: number; razon_social: string }>
}

const COLS = 'id, banco, cbu, alias, es_default, activo, obs, created_at, updated_at'
const ALIAS_RE = /^[A-Za-z0-9.-]{6,20}$/

/** CBU: 22 dígitos con verificadores; alias: 6 a 20 letras, números, punto o guion. */
export function validarCuenta(cbu: string | null | undefined, alias: string | null | undefined): { cbu: string; alias: string } {
  const c = normCbu(cbu ?? '')
  if (!c || !cbuValido(c)) throw errorDeCampo('CBU_INVALIDO', 'cbu')
  const a = (alias ?? '').trim()
  if (a && !ALIAS_RE.test(a)) throw errorDeCampo('ALIAS_INVALIDO', 'alias')
  return { cbu: c, alias: a.toUpperCase() }
}

function errorEscritura(error: PgError): FacturacionHttpError {
  if (error.code === '23505') {
    const m = error.message ?? ''
    return m.includes('default') ? new FacturacionHttpError(409, 'CUENTA_DEFAULT_DUPLICADA')
      : new FacturacionHttpError(409, 'CUENTA_DUPLICADA', { campo: 'cbu' })
  }
  if (error.code === '23514') return new FacturacionHttpError(400, 'CUENTA_INVALIDA', { dbMessage: error.message })
  return mapRpcError(error)
}

export const cuentasService = {
  async listar(incluirInactivas: boolean, db: SupabaseClient = supabase): Promise<CuentaBancaria[]> {
    let q = db.from('ventas_cuentas_bancarias').select(COLS)
    if (!incluirInactivas) q = q.eq('activo', true)
    const { data, error } = await q.order('es_default', { ascending: false }).order('banco').order('id')
    if (error) throw mapRpcError(error as PgError)
    const cuentas = (data ?? []) as Array<Omit<CuentaBancaria, 'clientes'>>
    const ids = cuentas.map((c) => c.id)
    const por = new Map<number, Array<{ id: number; razon_social: string }>>()
    if (ids.length) {
      const { data: cli, error: e2 } = await db.from('ventas_clientes')
        .select('id, razon_social, cuenta_fce_id').in('cuenta_fce_id', ids).order('razon_social_norm')
      if (e2) throw mapRpcError(e2 as PgError)
      for (const c of (cli ?? []) as Array<{ id: number; razon_social: string; cuenta_fce_id: number }>) {
        por.set(c.cuenta_fce_id, [...(por.get(c.cuenta_fce_id) ?? []), { id: c.id, razon_social: c.razon_social }])
      }
    }
    return cuentas.map((c) => ({ ...c, clientes: por.get(c.id) ?? [] }))
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<CuentaBancaria> {
    const todas = await this.listar(true, db)
    const c = todas.find((x) => x.id === id)
    if (!c) throw new FacturacionHttpError(404, 'CUENTA_NO_EXISTE', { cuenta_id: id })
    return c
  },

  /** Si pasa a ser la de por defecto, primero se le saca la marca a la otra. */
  async soltarDefault(salvoId: number | null, db: SupabaseClient): Promise<void> {
    let q = db.from('ventas_cuentas_bancarias').update({ es_default: false }).eq('es_default', true)
    if (salvoId != null) q = q.neq('id', salvoId)
    const { error } = await q
    if (error) throw errorEscritura(error as PgError)
  },

  async crear(dto: CuentaDto, userId: string, db: SupabaseClient = supabase): Promise<CuentaBancaria> {
    const { cbu, alias } = validarCuenta(dto.cbu, dto.alias)
    if (dto.es_default) await this.soltarDefault(null, db)
    const { data, error } = await db.from('ventas_cuentas_bancarias').insert({
      banco: dto.banco.trim(), cbu, alias, es_default: !!dto.es_default, obs: (dto.obs ?? '').trim(),
      created_by: userId, updated_by: userId,
    }).select('id').single()
    if (error) throw errorEscritura(error as PgError)
    return this.detalle((data as { id: number }).id, db)
  },

  async editar(id: number, dto: UpdateCuentaDto, userId: string, db: SupabaseClient = supabase): Promise<CuentaBancaria> {
    const actual = await this.detalle(id, db)
    const upd: Record<string, unknown> = { updated_by: userId }
    if (dto.banco !== undefined) upd.banco = dto.banco.trim()
    if (dto.cbu !== undefined || dto.alias !== undefined) {
      const v = validarCuenta(dto.cbu ?? actual.cbu, dto.alias === undefined ? actual.alias : dto.alias)
      upd.cbu = v.cbu
      upd.alias = v.alias
    }
    if (dto.obs !== undefined) upd.obs = (dto.obs ?? '').trim()
    if (dto.es_default === true) {
      if (!actual.activo) throw new FacturacionHttpError(409, 'CUENTA_INACTIVA', { cuenta_id: id })
      await this.soltarDefault(id, db)
      upd.es_default = true
    } else if (dto.es_default === false) {
      if (actual.es_default) throw new FacturacionHttpError(409, 'CUENTA_DEFAULT_REQUERIDA', { cuenta_id: id })
    }
    const { error } = await db.from('ventas_cuentas_bancarias').update(upd).eq('id', id)
    if (error) throw errorEscritura(error as PgError)
    return this.detalle(id, db)
  },

  /** Baja/alta. La de por defecto no se da de baja: primero hay que marcar otra. */
  async setActivo(id: number, activo: boolean, userId: string, db: SupabaseClient = supabase): Promise<CuentaBancaria> {
    const actual = await this.detalle(id, db)
    if (actual.activo === activo) return actual
    if (!activo && actual.es_default) throw new FacturacionHttpError(409, 'CUENTA_DEFAULT_REQUERIDA', { cuenta_id: id })
    const { error } = await db.from('ventas_cuentas_bancarias').update({ activo, updated_by: userId }).eq('id', id)
    if (error) throw errorEscritura(error as PgError)
    return this.detalle(id, db)
  },
}
