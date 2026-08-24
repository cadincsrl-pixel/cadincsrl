import { createSupabaseClient } from '../../lib/supabase.js'
import type {
  ListStockClienteDto,
  EntradaStockClienteDto,
  EntradaLoteStockClienteDto,
  SalidaStockClienteDto,
} from './stock-cliente.schema.js'

// Material que el cliente compró y entregó a CADINC para administrar en el
// depósito (ledger stock_cliente_items + stock_cliente_movimientos, migración
// 20260820). Los consumos vía solicitud van por resolver_item_stock_cliente
// en solicitudes.service — acá viven las entradas y las salidas manuales.

export class StockClienteHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'StockClienteHttpError'
  }
}

// Núcleo compartido por entrada() y entradaLote(): find-or-create del material
// por obra + descripción normalizada más el movimiento de entrada. El índice
// único parcial (sci_obra_descripcion_uq: obra + lower(btrim(descripcion))
// entre activos) respalda contra carreras: si dos entradas simultáneas crean
// el mismo material, la segunda pega 23505 y reintenta el lookup.
async function registrarEntradaItem(
  supabase: ReturnType<typeof createSupabaseClient>,
  args: {
    obra_cod:    string
    descripcion: string
    unidad:      string
    cantidad:    number
    fecha?:      string
    obs:         string
  },
  userId: string,
) {
  const desc = args.descripcion.trim()
  // ilike trata % y _ como comodines: sin escapar, "Hierro 8_mm" podría
  // matchear (y sumarle saldo a) otro ítem. Solo queremos case-insensitive.
  const descPattern = desc.replace(/([%_\\])/g, '\\$1')
  let { data: item } = await supabase
    .from('stock_cliente_items')
    .select('*')
    .eq('obra_cod', args.obra_cod)
    .eq('activo', true)
    .ilike('descripcion', descPattern)
    .maybeSingle()

  if (!item) {
    const { data: creado, error: errCrear } = await supabase
      .from('stock_cliente_items')
      .insert({
        obra_cod: args.obra_cod, descripcion: desc, unidad: args.unidad,
        created_by: userId, updated_by: userId,
      })
      .select()
      .single()
    if (errCrear) {
      if (errCrear.code === '23505') {
        const { data: existente } = await supabase
          .from('stock_cliente_items')
          .select('*')
          .eq('obra_cod', args.obra_cod)
          .eq('activo', true)
          .ilike('descripcion', desc)
          .maybeSingle()
        if (!existente) throw new Error(errCrear.message)
        item = existente
      } else if (errCrear.code === '23503') {
        throw new StockClienteHttpError(404, 'OBRA_NO_EXISTE')
      } else {
        throw new Error(errCrear.message)
      }
    } else {
      item = creado
    }
  }

  const { data: mov, error } = await supabase
    .from('stock_cliente_movimientos')
    .insert({
      item_id: item.id, tipo: 'entrada', motivo: 'entrega_cliente',
      cantidad: args.cantidad, fecha: args.fecha ?? undefined,
      obs: args.obs || null, created_by: userId,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return { item, movimiento: mov }
}

export const stockClienteService = {
  // Saldo por material (vista v_stock_cliente). `obra_cod` es el filtro que
  // responde "¿qué le queda pendiente en depósito a la obra X?".
  async list(dto: ListStockClienteDto, token: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('v_stock_cliente')
      .select('*')
      .eq('activo', true)
      .order('obra_cod')
      .order('descripcion')
    if (dto.obra_cod) q = q.eq('obra_cod', dto.obra_cod)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    // Con saldo 0 el material ya se consumió entero: por default no ensucia
    // la vista, pero con `incluir_agotados` se ve el histórico completo.
    return dto.incluir_agotados ? data : data.filter(r => Number(r.saldo) > 0)
  },

  async getMovimientos(itemId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('stock_cliente_movimientos')
      .select('*')
      .eq('item_id', itemId)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async entrada(dto: EntradaStockClienteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    return registrarEntradaItem(supabase, {
      obra_cod:    dto.obra_cod,
      descripcion: dto.descripcion,
      unidad:      dto.unidad,
      cantidad:    dto.cantidad,
      fecha:       dto.fecha,
      obs:         dto.obs,
    }, userId)
  },

  // Entrega en lote: muchos materiales de una misma factura/remito. Loop
  // secuencial NO-atómico (patrón aceptado en el repo — no hay transacción
  // multi-statement vía PostgREST sin RPC): se procesa en orden y, si un
  // insert falla a mitad, los anteriores QUEDAN registrados. El error sale
  // con detail de qué ítem falló y cuántos entraron, para que el usuario
  // sepa qué recargar.
  async entradaLote(dto: EntradaLoteStockClienteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const registrados: { item_id: number; descripcion: string; cantidad: number }[] = []

    for (const it of dto.items) {
      try {
        const { item } = await registrarEntradaItem(supabase, {
          obra_cod:    dto.obra_cod,
          descripcion: it.descripcion,
          unidad:      it.unidad,
          cantidad:    it.cantidad,
          fecha:       dto.fecha,
          obs:         dto.obs,
        }, userId)
        registrados.push({ item_id: item.id, descripcion: item.descripcion, cantidad: it.cantidad })
      } catch (err) {
        const detail = {
          item_fallido: it.descripcion,
          registrados:  registrados.length,
          total:        dto.items.length,
          motivo:       err instanceof StockClienteHttpError ? err.code
                      : err instanceof Error                 ? err.message
                      : String(err),
        }
        const status = err instanceof StockClienteHttpError ? err.status : 500
        throw new StockClienteHttpError(status, 'ENTRADA_LOTE_PARCIAL', detail)
      }
    }

    return { obra_cod: dto.obra_cod, fecha: dto.fecha ?? null, items: registrados }
  },

  async salida(dto: SalidaStockClienteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Chequeo de saldo best-effort (la vía transaccional con lock es la RPC
    // de solicitudes; la salida manual tolera el chequeo en dos pasos — el
    // peor caso es un saldo negativo visible que se corrige con un ajuste).
    const { data: saldoRow, error: errSaldo } = await supabase
      .from('v_stock_cliente')
      .select('saldo, activo')
      .eq('item_id', dto.item_id)
      .maybeSingle()
    if (errSaldo) throw new Error(errSaldo.message)
    if (!saldoRow || !saldoRow.activo) throw new StockClienteHttpError(404, 'ITEM_NO_EXISTE')
    if (Number(saldoRow.saldo) < dto.cantidad) {
      throw new StockClienteHttpError(409, 'SALDO_INSUFICIENTE', { saldo: Number(saldoRow.saldo) })
    }

    const { data, error } = await supabase
      .from('stock_cliente_movimientos')
      .insert({
        item_id: dto.item_id, tipo: 'salida', motivo: dto.motivo,
        cantidad: dto.cantidad, fecha: dto.fecha ?? undefined,
        obs: dto.obs || null, created_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },
}
