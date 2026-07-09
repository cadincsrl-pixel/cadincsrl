import { createSupabaseClient } from '../../../lib/supabase.js'
import type { CreateCobroDto } from './cobros.schema.js'

export const cobrosService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      .select('*, empresas_transportistas(nombre, modalidad_cobro)')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // 0. Si la empresa cobra con facturación, el cobro ES una factura emitida
    // por CADINC: exige nº + fecha de factura y exactamente un viaje (una
    // factura por viaje — regla del negocio, no técnica).
    const { data: empresa, error: errEmp } = await supabase
      .from('empresas_transportistas')
      .select('modalidad_cobro')
      .eq('id', dto.empresa_id)
      .maybeSingle()
    if (errEmp) throw new Error(errEmp.message)
    if (!empresa) {
      const e = new Error('EMPRESA_NO_EXISTE') as Error & { code?: string }
      e.code = 'EMPRESA_NO_EXISTE'
      throw e
    }
    const esFacturacion = empresa.modalidad_cobro === 'facturacion'
    if (esFacturacion) {
      if (!dto.factura_nro?.trim() || !dto.factura_fecha) {
        const e = new Error('FALTA_FACTURA') as Error & { code?: string }
        e.code = 'FALTA_FACTURA'
        throw e
      }
      if (!dto.tramo_ids || dto.tramo_ids.length !== 1) {
        const e = new Error('FACTURA_UN_VIAJE') as Error & { code?: string }
        e.code = 'FACTURA_UN_VIAJE'
        throw e
      }
    }

    // 1. Validar tramos ANTES de crear el cobro (evita huérfanos): que existan,
    // pertenezcan a la empresa del cobro y no estén ya cobrados.
    if (dto.tramo_ids && dto.tramo_ids.length > 0) {
      const { data: tramos, error: errVal } = await supabase
        .from('tramos')
        .select('id, empresa_id, cobro_id')
        .in('id', dto.tramo_ids)
      if (errVal) throw new Error(errVal.message)
      if (!tramos || tramos.length !== dto.tramo_ids.length) {
        const e = new Error('TRAMO_NO_EXISTE') as Error & { code?: string }
        e.code = 'TRAMO_NO_EXISTE'
        throw e
      }
      const otraEmpresa = tramos.filter(t => t.empresa_id !== dto.empresa_id)
      if (otraEmpresa.length > 0) {
        const e = new Error('TRAMO_OTRA_EMPRESA') as Error & { code?: string; detail?: number[] }
        e.code = 'TRAMO_OTRA_EMPRESA'
        e.detail = otraEmpresa.map(t => t.id)
        throw e
      }
      const yaCobrados = tramos.filter(t => t.cobro_id != null)
      if (yaCobrados.length > 0) {
        const e = new Error('TRAMO_YA_COBRADO') as Error & { code?: string; detail?: number[] }
        e.code = 'TRAMO_YA_COBRADO'
        e.detail = yaCobrados.map(t => t.id)
        throw e
      }
    }

    // 2. Crear el cobro
    const { data: cobro, error: errCobro } = await supabase
      .from('cobros')
      .insert({
        empresa_id:        dto.empresa_id,
        fecha_desde:       dto.fecha_desde,
        fecha_hasta:       dto.fecha_hasta,
        toneladas_totales: dto.toneladas_totales,
        total:             dto.total,
        obs:               dto.obs,
        factura_nro:       esFacturacion ? dto.factura_nro!.trim() : null,
        factura_fecha:     esFacturacion ? dto.factura_fecha : null,
        estado:            'pendiente',
        created_by:        userId,
      })
      .select()
      .single()
    if (errCobro) throw new Error(errCobro.message)

    // 3. Marcar tramos con cobro_id. Si falla, borrar el cobro recién creado
    // (best-effort, sin RPC no es transaccional pero evita el huérfano típico).
    if (dto.tramo_ids && dto.tramo_ids.length > 0) {
      const { error: errTramos } = await supabase
        .from('tramos')
        .update({ cobro_id: cobro.id })
        .in('id', dto.tramo_ids)
      if (errTramos) {
        await supabase.from('cobros').delete().eq('id', cobro.id)
        throw new Error(errTramos.message)
      }
    }

    return cobro
  },

  async marcarCobrado(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Validar que exista comprobante de pago antes de marcar como cobrado.
    // Sin comprobante no hay forma de demostrar el pago — y el user
    // pidió que el sistema lo bloquee para evitar olvidos.
    const { data: adjs, error: errAdj } = await supabase
      .from('cobros_adjuntos')
      .select('id')
      .eq('cobro_id', id)
      .eq('tipo', 'comprobante')
      .is('deleted_at', null)
      .limit(1)
    if (errAdj) throw new Error(errAdj.message)
    if (!adjs || adjs.length === 0) {
      const e = new Error('FALTA_COMPROBANTE_PAGO') as Error & { code?: string }
      e.code = 'FALTA_COMPROBANTE_PAGO'
      throw e
    }

    const { data, error } = await supabase
      .from('cobros')
      .update({ estado: 'cobrado', updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Volver un cobro de 'cobrado' a 'pendiente' — útil cuando se marcó
  // por error o falta corregir el comprobante.
  async revertirCobrado(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      .update({ estado: 'pendiente', updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Bloquear delete si el cobro ya está cobrado: borrarlo perdería el
    // rastro de plata efectivamente entrada y liberaría tramos ya facturados.
    const { data: cobro, error: errSel } = await supabase
      .from('cobros').select('estado').eq('id', id).maybeSingle()
    if (errSel) throw new Error(errSel.message)
    if (!cobro) {
      const e = new Error('COBRO_NO_EXISTE') as Error & { code?: string }
      e.code = 'COBRO_NO_EXISTE'
      throw e
    }
    if (cobro.estado === 'cobrado') {
      const e = new Error('COBRO_YA_COBRADO') as Error & { code?: string }
      e.code = 'COBRO_YA_COBRADO'
      throw e
    }
    // Liberar tramos y borrar.
    await supabase.from('tramos').update({ cobro_id: null }).eq('cobro_id', id)
    const { error } = await supabase.from('cobros').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
