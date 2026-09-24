/**
 * Plan de cuentas (`cont_cuentas`, 20260926a). Todas las escrituras pasan por
 * RPC (`cont_guardar_cuenta`, `cont_baja_cuenta`, `cont_borrar_cuenta`,
 * `cont_importar_plan`), que chequean el flag `editar_plan` y dejan las reglas
 * del árbol al trigger `fn_cont_cuenta_consistente`. Las lecturas salen de
 * `v_cont_cuentas` (con padre, naturaleza, hijas y si tiene movimientos).
 *
 * La normalización de filas y del CSV del importador es pura y vive en
 * `plan-import.ts`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { ContabilidadHttpError, mapRpcError, type PgError } from './contabilidad.errors.js'
import { rpc } from './comun.js'
import { filasDeEntrada, mezclarErroresLocales, type ImportarFila } from './plan-import.js'
import type { CuentaDto, UpdateCuentaDto } from './contabilidad.schema.js'

export { normalizarFila, parsearCsv, filasDeEntrada, mezclarErroresLocales } from './plan-import.js'
export type { ImportarFila } from './plan-import.js'

export type CtbCuenta = Record<string, unknown> & {
  id: number; codigo: string; nombre: string; rubro: string; nivel: number; imputable: boolean
  auxiliar: string; activo: boolean; obs: string
}

export interface ImportarRes {
  confirmado: boolean; total_filas: number; nuevas: number; duplicadas: number; errores: number; filas: ImportarFila[]
}

const MAX_FILAS = 2000

export const cuentasService = {
  async listar(
    f: { incluirInactivas?: boolean; soloImputables?: boolean; q?: string },
    db: SupabaseClient = supabase,
  ): Promise<CtbCuenta[]> {
    const filas = await todasLasFilas<CtbCuenta>((d, h) => {
      let q = db.from('v_cont_cuentas').select('*')
      if (!f.incluirInactivas) q = q.eq('activo', true)
      if (f.soloImputables) q = q.eq('imputable', true)
      return q.order('codigo_orden').order('id').range(d, h)
    })
    const busq = normTxt(f.q ?? '')
    if (!busq) return filas
    // El plan son cientos de filas: filtrar acá evita armar un `or` de PostgREST con texto del usuario.
    return filas.filter((c) => c.codigo.startsWith((f.q ?? '').trim()) || normTxt(c.nombre).includes(busq))
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<CtbCuenta> {
    const { data, error } = await db.from('v_cont_cuentas').select('*').eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new ContabilidadHttpError(404, 'CUENTA_NO_EXISTE', { cuenta_id: id })
    return data as CtbCuenta
  },

  /** La RPC devuelve la cuenta; se relee de la vista para traer padre, hijas y movimientos. */
  async guardar(p: Record<string, unknown>, userId: string, db: SupabaseClient): Promise<CtbCuenta> {
    const r = await rpc<{ id: number } | null>(db, 'cont_guardar_cuenta', { p_cuenta: p, p_user_id: userId }, { unicoComo: 'CODIGO_DUPLICADO' })
    const id = Number(r?.id ?? p.id)
    return this.detalle(id, db)
  },

  async crear(dto: CuentaDto, userId: string, db: SupabaseClient = supabase): Promise<CtbCuenta> {
    return this.guardar({
      codigo: dto.codigo, nombre: dto.nombre, rubro: dto.rubro ?? null,
      imputable: dto.imputable, auxiliar: dto.auxiliar, obs: dto.obs ?? '',
    }, userId, db)
  },

  /**
   * Edición parcial: se completa con lo guardado y va la cuenta entera. El
   * rubro guardado solo se reenvía si el código no cambia (o es nivel 1): si
   * la cuenta se mueve de padre, que lo herede del nuevo.
   */
  async editar(id: number, dto: UpdateCuentaDto, userId: string, db: SupabaseClient = supabase): Promise<CtbCuenta> {
    const a = await this.detalle(id, db)
    const codigo = dto.codigo ?? a.codigo
    const nivel1 = !codigo.includes('.')
    let rubro: string | null = dto.rubro ?? (codigo === a.codigo || nivel1 ? a.rubro : null)
    if (rubro === null) {
      // La RPC toma un rubro null como «no vino» y se queda con el guardado:
      // al mover la cuenta hay que mandarle el de la nueva madre.
      const madre = codigo.slice(0, codigo.lastIndexOf('.'))
      const { data, error } = await db.from('v_cont_cuentas').select('rubro').eq('codigo', madre).maybeSingle()
      if (error) throw error
      rubro = (data as { rubro: string } | null)?.rubro ?? a.rubro
    }
    return this.guardar({
      id, codigo, nombre: dto.nombre ?? a.nombre, rubro,
      imputable: dto.imputable ?? a.imputable, auxiliar: dto.auxiliar ?? a.auxiliar, obs: dto.obs ?? a.obs ?? '',
    }, userId, db)
  },

  async setActivo(id: number, activo: boolean, motivo: string | null, userId: string, db: SupabaseClient = supabase): Promise<CtbCuenta> {
    await rpc(db, 'cont_baja_cuenta', { p_id: id, p_activo: activo, p_motivo: motivo, p_user_id: userId })
    return this.detalle(id, db)
  },

  async borrar(id: number, userId: string, db: SupabaseClient = supabase): Promise<{ ok: true; id: number }> {
    await rpc(db, 'cont_borrar_cuenta', { p_id: id, p_user_id: userId })
    return { ok: true, id }
  },

  /**
   * Vista previa (`confirmar=false`) o importación (todo o nada). Las filas
   * con `imputable` ilegible se marcan acá y hacen fallar la confirmación
   * igual que un error de la RPC (422 IMPORTACION_CON_ERRORES).
   */
  async importar(
    entrada: { filas?: Record<string, string | number | boolean | null>[]; csv?: string; confirmar: boolean },
    userId: string,
    db: SupabaseClient = supabase,
  ): Promise<ImportarRes> {
    const normalizadas = filasDeEntrada(entrada)
    if (normalizadas.length === 0) throw new ContabilidadHttpError(400, 'SIN_FILAS', { campo: 'filas' })
    if (normalizadas.length > MAX_FILAS) {
      throw new ContabilidadHttpError(400, 'DEMASIADAS_FILAS', { campo: 'filas', maximo: MAX_FILAS, filas: normalizadas.length })
    }
    const locales = normalizadas.map((n, i) => ({ i, e: n.error })).filter((x) => x.e)
    const pFilas = normalizadas.map((n) => n.fila)

    const res = await rpc<ImportarRes>(db, 'cont_importar_plan', {
      p_filas: pFilas, p_user_id: userId, p_confirmar: entrada.confirmar && locales.length === 0,
    })
    if (locales.length === 0) return res

    const filas = mezclarErroresLocales(res.filas, locales.map((x) => ({ indice: x.i, code: x.e!.code, detalle: x.e!.detalle })))
    const conError = filas.filter((f) => f.estado === 'error')
    const out: ImportarRes = {
      ...res,
      confirmado: false,
      nuevas: filas.filter((f) => f.estado === 'nueva').length,
      duplicadas: filas.filter((f) => f.estado === 'duplicada').length,
      errores: conError.length,
      filas,
    }
    if (entrada.confirmar) {
      throw new ContabilidadHttpError(422, 'IMPORTACION_CON_ERRORES', {
        errores: conError.map((f) => ({ indice: f.indice, codigo: f.codigo, error: f.error, detalle: f.detalle })),
      })
    }
    return out
  },
}
