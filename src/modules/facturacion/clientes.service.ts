/**
 * Padrón de clientes de Facturación (`ventas_clientes`). Módulo independiente
 * como Pagos: no se cruza con aridos_clientes ni con la cuenta corriente. Lo
 * único compartido son las obras: cada obra es su propio centro de costo
 * (decisión del 23/09, `obras.cc` en desuso) y `obras.cliente_id` precarga el
 * cliente de la factura. Las obras internas y el depósito no se facturan: no
 * se vinculan a un cliente ni aparecen en el selector.
 *
 * Los clientes se escriben por tabla (no hay RPC): el índice único parcial
 * `ventas_clientes_doc_uidx` (doc_tipo, doc_nro) where activo es la verdad
 * contra duplicados; el chequeo previo solo sirve para devolver quién es el
 * otro.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { normTxt } from '../../lib/norm-txt.js'
import { cuitValido } from '../pagos/pagos.util.js'
import { FacturacionHttpError, errorDeCampo, mapRpcError, type PgError } from './facturacion.errors.js'
import { CONDICIONES_IVA_IDS, letraDe, normDoc, obrasNoVinculables, type ObraFacturable } from './reglas.js'
import type { CreateClienteDto, UpdateClienteDto } from './facturacion.schema.js'

export interface ObraCliente { cod: string; nom: string }
export type VentasCliente = Record<string, unknown> & { id: number; obras: ObraCliente[] }

const COLS = 'id, razon_social, razon_social_norm, doc_tipo, doc_nro, condicion_iva_id, domicilio, provincia, email, activo, obs, created_at, updated_at, created_by, updated_by, cuenta_fce_id, fce_obligado, fce_monto_desde, fce_consultado_at'

/** La cuenta preferida para la FCE tiene que existir y estar activa. */
async function validarCuentaFce(db: SupabaseClient, id: number | null | undefined): Promise<void> {
  if (id == null) return
  const { data, error } = await db.from('ventas_cuentas_bancarias').select('id, activo').eq('id', id).maybeSingle()
  if (error) throw mapRpcError(error as PgError)
  if (!data || !(data as { activo: boolean }).activo) throw errorDeCampo('CUENTA_NO_EXISTE', 'cuenta_fce_id', { cuenta_id: id })
}

/** Valida y normaliza el documento según su tipo. */
export function validarDocumento(docTipo: number, docNro: string | null | undefined): string {
  const doc = normDoc(docTipo, docNro)
  if (!doc) throw errorDeCampo('DOC_INVALIDO', 'doc_nro')
  if (docTipo === 80 || docTipo === 86) {
    if (!cuitValido(doc)) throw errorDeCampo('CUIT_INVALIDO', 'doc_nro')
  } else if (docTipo === 96) {
    if (!/^\d{7,8}$/.test(doc)) throw errorDeCampo('DOC_INVALIDO', 'doc_nro')
  }
  return doc
}

function validarCondicion(id: number): void {
  if (!CONDICIONES_IVA_IDS.has(id)) throw errorDeCampo('CONDICION_IVA_INVALIDA', 'condicion_iva_id')
}

/**
 * Un cliente al que no se le puede hacer ni A ni B no sirve para facturar:
 * RI o monotributo sin CUIT (ARCA no acepta esas condiciones en la B). Se
 * frena al cargarlo, no al emitir.
 */
function validarLetra(docTipo: number, condicionIvaId: number): void {
  if (!letraDe(docTipo, condicionIvaId)) {
    throw errorDeCampo('CLIENTE_SIN_LETRA', 'condicion_iva_id', { doc_tipo: docTipo, condicion_iva_id: condicionIvaId })
  }
}

const limpio = (v: string | null | undefined) => (v ?? '').trim()

async function duplicado(db: SupabaseClient, docTipo: number, docNro: string, salvoId?: number): Promise<{ cliente_id: number; razon_social: string } | null> {
  if (docTipo === 99) return null
  let q = db.from('ventas_clientes').select('id, razon_social')
    .eq('doc_tipo', docTipo).eq('doc_nro', docNro).eq('activo', true).limit(1)
  if (salvoId) q = q.neq('id', salvoId)
  const { data } = await q
  const f = (data ?? [])[0] as { id: number; razon_social: string } | undefined
  return f ? { cliente_id: f.id, razon_social: f.razon_social } : null
}

async function errorDuplicado(db: SupabaseClient, docTipo: number, docNro: string, salvoId?: number): Promise<FacturacionHttpError> {
  const otro = await duplicado(db, docTipo, docNro, salvoId)
  return new FacturacionHttpError(409, 'CLIENTE_DUPLICADO', { campo: 'doc_nro', ...(otro ?? {}) })
}

async function conObras(db: SupabaseClient, clientes: Array<Record<string, unknown> & { id: number }>): Promise<VentasCliente[]> {
  if (clientes.length === 0) return []
  const ids = clientes.map((c) => c.id)
  const obras: Array<ObraCliente & { cliente_id: number }> = []
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200)
    const filas = await todasLasFilas<ObraCliente & { cliente_id: number }>((d, h) =>
      db.from('obras').select('cod, nom, cliente_id').in('cliente_id', lote).order('cod').range(d, h))
    obras.push(...filas)
  }
  const por = new Map<number, ObraCliente[]>()
  for (const o of obras) {
    const l = por.get(o.cliente_id) ?? []
    l.push({ cod: o.cod, nom: o.nom })
    por.set(o.cliente_id, l)
  }
  return clientes.map((c) => ({ ...c, obras: por.get(c.id) ?? [] }))
}

export const clientesService = {
  async listar(q: { q?: string; incluir_inactivos?: string }, db: SupabaseClient = supabase): Promise<VentasCliente[]> {
    const incluir = q.incluir_inactivos === '1' || q.incluir_inactivos === 'true'
    const busq = normTxt(q.q ?? '')
    const digitos = (q.q ?? '').replace(/\D+/g, '')
    const filas = await todasLasFilas<Record<string, unknown> & { id: number }>((d, h) => {
      let s = db.from('ventas_clientes').select(COLS)
      if (!incluir) s = s.eq('activo', true)
      if (busq) {
        const conds = [`razon_social_norm.ilike.%${busq.replace(/[%,()]/g, ' ')}%`]
        if (digitos.length >= 3) conds.push(`doc_nro.ilike.%${digitos}%`)
        s = s.or(conds.join(','))
      }
      return s.order('razon_social_norm').order('id').range(d, h)
    })
    return conObras(db, filas)
  },

  async detalle(id: number, db: SupabaseClient = supabase): Promise<VentasCliente> {
    const { data, error } = await db.from('ventas_clientes').select(COLS).eq('id', id).maybeSingle()
    if (error) throw mapRpcError(error as PgError)
    if (!data) throw new FacturacionHttpError(404, 'CLIENTE_NO_EXISTE', { cliente_id: id })
    const [c] = await conObras(db, [data as Record<string, unknown> & { id: number }])
    return c!
  },

  async crear(dto: CreateClienteDto, userId: string, db: SupabaseClient = supabase): Promise<VentasCliente> {
    const docTipo = dto.doc_tipo ?? 80
    const doc = validarDocumento(docTipo, dto.doc_nro)
    validarCondicion(dto.condicion_iva_id)
    validarLetra(docTipo, dto.condicion_iva_id)
    if (await duplicado(db, docTipo, doc)) throw await errorDuplicado(db, docTipo, doc)
    await validarCuentaFce(db, dto.cuenta_fce_id)

    const { data, error } = await db.from('ventas_clientes').insert({
      razon_social: dto.razon_social.trim(),
      doc_tipo: docTipo,
      doc_nro: doc,
      condicion_iva_id: dto.condicion_iva_id,
      domicilio: limpio(dto.domicilio),
      provincia: limpio(dto.provincia),
      email: limpio(dto.email),
      obs: limpio(dto.obs),
      cuenta_fce_id: dto.cuenta_fce_id ?? null,
      created_by: userId,
      updated_by: userId,
    }).select('id').single()
    if (error) {
      if ((error as PgError).code === '23505') throw await errorDuplicado(db, docTipo, doc)
      if ((error as PgError).code === '23514') throw new FacturacionHttpError(400, 'CLIENTE_INVALIDO', { dbMessage: error.message })
      throw mapRpcError(error as PgError, { unicoComo: 'CLIENTE_DUPLICADO' })
    }
    return this.detalle((data as { id: number }).id, db)
  },

  async editar(id: number, dto: UpdateClienteDto, userId: string, db: SupabaseClient = supabase): Promise<VentasCliente> {
    const actual = await this.detalle(id, db)
    const upd: Record<string, unknown> = { updated_by: userId }
    if (dto.razon_social !== undefined) upd.razon_social = dto.razon_social.trim()
    const docTipo = dto.doc_tipo ?? Number(actual.doc_tipo)
    if (dto.doc_tipo !== undefined || dto.doc_nro !== undefined) {
      const doc = validarDocumento(docTipo, dto.doc_nro ?? String(actual.doc_nro))
      upd.doc_tipo = docTipo
      upd.doc_nro = doc
      if (actual.activo && await duplicado(db, docTipo, doc, id)) throw await errorDuplicado(db, docTipo, doc, id)
    }
    if (dto.condicion_iva_id !== undefined) {
      validarCondicion(dto.condicion_iva_id)
      upd.condicion_iva_id = dto.condicion_iva_id
    }
    if (dto.doc_tipo !== undefined || dto.condicion_iva_id !== undefined) {
      validarLetra(docTipo, dto.condicion_iva_id ?? Number(actual.condicion_iva_id))
    }
    for (const k of ['domicilio', 'provincia', 'email', 'obs'] as const) {
      if (dto[k] !== undefined) upd[k] = limpio(dto[k])
    }
    if (dto.cuenta_fce_id !== undefined) {
      await validarCuentaFce(db, dto.cuenta_fce_id)
      upd.cuenta_fce_id = dto.cuenta_fce_id ?? null
    }
    // Cambió el CUIT: el dato de WSFECRED ya no vale.
    if (upd.doc_nro !== undefined && upd.doc_nro !== actual.doc_nro) {
      upd.fce_obligado = null
      upd.fce_monto_desde = null
      upd.fce_consultado_at = null
    }
    const { error } = await db.from('ventas_clientes').update(upd).eq('id', id)
    if (error) {
      if ((error as PgError).code === '23505') throw await errorDuplicado(db, docTipo, String(upd.doc_nro ?? actual.doc_nro), id)
      if ((error as PgError).code === '23514') throw new FacturacionHttpError(400, 'CLIENTE_INVALIDO', { dbMessage: error.message })
      throw mapRpcError(error as PgError, { unicoComo: 'CLIENTE_DUPLICADO' })
    }
    return this.detalle(id, db)
  },

  async setActivo(id: number, activo: boolean, userId: string, db: SupabaseClient = supabase): Promise<VentasCliente> {
    const actual = await this.detalle(id, db)
    if (actual.activo === activo) return actual
    if (activo && await duplicado(db, Number(actual.doc_tipo), String(actual.doc_nro), id)) {
      throw await errorDuplicado(db, Number(actual.doc_tipo), String(actual.doc_nro), id)
    }
    const { error } = await db.from('ventas_clientes').update({ activo, updated_by: userId }).eq('id', id)
    if (error) {
      if ((error as PgError).code === '23505') throw await errorDuplicado(db, Number(actual.doc_tipo), String(actual.doc_nro), id)
      throw mapRpcError(error as PgError)
    }
    return this.detalle(id, db)
  },

  /**
   * Las obras que se le facturan a este cliente: `obras.cliente_id = id` para
   * las de la lista y `null` para las que tenía y ya no están. Una obra que
   * estaba con otro cliente pasa a este (la lista manda). Las internas y el
   * depósito no se le facturan a nadie: OBRA_INTERNA / OBRA_DEPOSITO.
   */
  async setObras(id: number, obraCods: string[], db: SupabaseClient = supabase): Promise<VentasCliente> {
    await this.detalle(id, db)
    const cods = [...new Set(obraCods.map((c) => c.trim()).filter(Boolean))]
    if (cods.length) {
      const encontradas: ObraFacturable[] = []
      for (let i = 0; i < cods.length; i += 200) {
        const { data, error } = await db.from('obras').select('cod, es_interna, es_deposito').in('cod', cods.slice(i, i + 200))
        if (error) throw mapRpcError(error as PgError)
        encontradas.push(...((data ?? []) as ObraFacturable[]))
      }
      const err = obrasNoVinculables(cods, encontradas)
      if (err) throw new FacturacionHttpError(400, err.code, { campo: 'obra_cods', obra_cods: err.obra_cods })
    }
    // Soltar las que ya no están.
    let soltar = db.from('obras').update({ cliente_id: null }).eq('cliente_id', id)
    if (cods.length) soltar = soltar.not('cod', 'in', `(${cods.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(',')})`)
    const { error: e1 } = await soltar
    if (e1) throw mapRpcError(e1 as PgError)
    for (let i = 0; i < cods.length; i += 200) {
      const { error: e2 } = await db.from('obras').update({ cliente_id: id }).in('cod', cods.slice(i, i + 200))
      if (e2) throw mapRpcError(e2 as PgError)
    }
    return this.detalle(id, db)
  },

  /**
   * Obras que se pueden facturar, para los selectores: no archivadas, ni
   * internas ni depósito. Cada una es su propio centro de costo; `cliente_nom`
   * es el cliente que la agrupa (precarga el de la factura).
   */
  async obras(db: SupabaseClient = supabase) {
    const filas = await todasLasFilas<Record<string, unknown> & { cliente?: { razon_social: string } | { razon_social: string }[] | null }>((d, h) =>
      db.from('obras').select('cod, nom, cliente_id, es_interna, archivada, cliente:ventas_clientes(razon_social)')
        .eq('archivada', false).eq('es_interna', false).eq('es_deposito', false)
        .order('nom').order('cod').range(d, h))
    return filas.map(({ cliente, ...o }) => {
      const c = Array.isArray(cliente) ? cliente[0] : cliente
      return { ...o, cliente_nom: c?.razon_social ?? null }
    })
  },
}
