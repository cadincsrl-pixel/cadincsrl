import { createSupabaseClient, supabase as supabaseAdmin } from '../../../lib/supabase.js'
import type { CreateTramoDto, UpdateTramoDto, RegistrarDescargaDto } from './tramos.schema.js'

// Helper para errores con código que el handler HTTP mapea a status
// específicos (ver tramos.routes.ts).
function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string }
  e.code = code
  return e
}

// Un tramo `cargado` representa un viaje facturable (cantera origen → depósito
// destino). Los lugares operativos (CHIVILCOY: mantenimiento/relevos/parking) no
// son facturables y no deben ser origen ni destino de un cargado (saldría en $0
// sin tarifa). Los vacíos sí pueden tocarlos (ruteo). Defensa en profundidad: el
// front ya los oculta del selector. Lanza CANTERA_OPERATIVO/DEPOSITO_OPERATIVO.
async function assertLugaresFacturables(
  supabase: ReturnType<typeof createSupabaseClient>,
  tipo: string | null | undefined,
  canteraId: number | null | undefined,
  depositoId: number | null | undefined,
): Promise<void> {
  if (tipo !== 'cargado') return
  if (canteraId != null) {
    const { data: c, error } = await supabase.from('canteras').select('operativo').eq('id', canteraId).maybeSingle()
    if (error) throw new Error(error.message)
    if (c?.operativo) throw codedError('CANTERA_OPERATIVO', 'La cantera es un lugar operativo (no facturable): no puede ser origen de un tramo cargado')
  }
  if (depositoId != null) {
    const { data: d, error } = await supabase.from('depositos').select('operativo').eq('id', depositoId).maybeSingle()
    if (error) throw new Error(error.message)
    if (d?.operativo) throw codedError('DEPOSITO_OPERATIVO', 'El depósito es un lugar operativo (no facturable): no puede ser destino de un tramo cargado')
  }
}

export const tramosService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    // Orden estable: fecha_operacion DESC; tiebreaker manual (orden_dia)
    // y finalmente id DESC.
    const { data, error } = await supabase
      .from('tramos')
      .select('*')
      .order('fecha_operacion', { ascending: false, nullsFirst: false })
      .order('orden_dia', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async mover(id: number, dir: 'up' | 'down', _token: string, userId?: string) {
    // RPC transaccional con FOR UPDATE sobre ambos tramos — evita
    // duplicados de orden_dia bajo concurrencia. Migración
    // 20260424_rpc_mover_tramo_orden.
    // supabaseAdmin: SECURITY DEFINER revocada de `authenticated` (migración 20260527).
    const { data, error } = await supabaseAdmin.rpc('mover_tramo_orden', {
      p_tramo_id: id,
      p_dir:      dir,
      p_user_id:  userId ?? null,
    })
    if (error) {
      const msg = error.message || ''
      if (/TRAMO_NO_EXISTE/.test(msg))   throw codedError('TRAMO_NO_EXISTE', 'Tramo no encontrado')
      if (/TRAMO_SIN_FECHA/.test(msg))   throw codedError('TRAMO_SIN_FECHA', 'El tramo no tiene fecha asignada')
      if (/DIR_INVALIDA/.test(msg))      throw codedError('DIR_INVALIDA', 'Dirección inválida')
      if (/SIN_PERMISO/.test(msg))       throw codedError('SIN_PERMISO', 'Sin permiso para reordenar')
      throw new Error(msg)
    }
    return data as { moved: boolean; actual_id?: number; vecino_id?: number }
  },

  async create(dto: CreateTramoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Un cargado no puede originarse/entregar en un lugar operativo (no facturable).
    await assertLugaresFacturables(supabase, dto.tipo, dto.cantera_id, dto.deposito_id)

    // Default: cargado→en_curso, vacio→completado. El cliente puede
    // overridear con `dto.estado` (caso típico: vacío que arranca tras
    // una descarga y queda en seguimiento GPS hasta cargar de nuevo).
    const estadoDefault = dto.tipo === 'vacio' ? 'completado' : 'en_curso'
    const estado = dto.estado ?? estadoDefault
    const { data, error } = await supabase
      .from('tramos')
      .insert({ ...dto, estado, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Si el nuevo tramo es `cargado en_curso`, cerramos cualquier vacío
    // `en_curso` previo del mismo camión: ya llegó a la cantera nueva, su
    // viaje vacío terminó. Evita vacíos "huérfanos" que nunca se cierran.
    if (dto.tipo === 'cargado' && estado === 'en_curso' && dto.camion_id) {
      await supabase
        .from('tramos')
        .update({ estado: 'completado', updated_by: userId })
        .eq('camion_id', dto.camion_id)
        .eq('tipo', 'vacio')
        .eq('estado', 'en_curso')
        .neq('id', (data as any).id)
    }
    return data
  },

  async update(id: number, dto: UpdateTramoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // Eliminar keys con valor undefined para no pisar campos existentes en Supabase
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined)
    )

    // Guard: un tramo ya liquidado/cobrado tiene su km/toneladas/empresa
    // snapshoteados en la liquidación/cobro; editar cualquier campo (salvo obs)
    // los desincronizaría. Bloqueamos. (El front ya mapea TRAMO_COBRADO/LIQUIDADO.)
    const tocaFinancieros = Object.keys(patch).some(k => k !== 'obs')
    if (tocaFinancieros) {
      const { data: tramo, error: e0 } = await supabase
        .from('tramos')
        .select('id, liquidacion_id, cobro_id')
        .eq('id', id)
        .maybeSingle()
      if (e0) throw new Error(e0.message)
      if (!tramo)               throw codedError('TRAMO_NO_EXISTE', 'Tramo no encontrado')
      if (tramo.liquidacion_id) throw codedError('TRAMO_LIQUIDADO', 'No se puede editar: el tramo está liquidado')
      if (tramo.cobro_id)       throw codedError('TRAMO_COBRADO',   'No se puede editar: el tramo está cobrado')
    }

    // Guard de lugar operativo (mismo criterio que create) sobre el estado
    // EFECTIVO post-patch: si el patch toca tipo/cantera/depósito, no permitir
    // que el tramo quede cargado con un lugar operativo (no facturable).
    if (['tipo', 'cantera_id', 'deposito_id'].some(k => k in patch)) {
      const { data: actual, error: e1 } = await supabase
        .from('tramos').select('tipo, cantera_id, deposito_id').eq('id', id).maybeSingle()
      if (e1) throw new Error(e1.message)
      if (!actual) throw codedError('TRAMO_NO_EXISTE', 'Tramo no encontrado')
      await assertLugaresFacturables(
        supabase,
        (patch.tipo as string | undefined) ?? actual.tipo,
        ('cantera_id'  in patch ? patch.cantera_id  : actual.cantera_id)  as number | null,
        ('deposito_id' in patch ? patch.deposito_id : actual.deposito_id) as number | null,
      )
    }

    const { data, error } = await supabase
      .from('tramos')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async registrarDescarga(id: number, dto: RegistrarDescargaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Precondiciones: no permitir pisar la descarga de un tramo ya liquidado
    // o cobrado (toneladas_descarga es la base del cálculo aguas abajo).
    // Mismo guard que revertirDescarga.
    const { data: tramo, error: e0 } = await supabase
      .from('tramos')
      .select('id, liquidacion_id, cobro_id')
      .eq('id', id)
      .maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!tramo)               throw codedError('TRAMO_NO_EXISTE', 'Tramo no encontrado')
    if (tramo.liquidacion_id) throw codedError('TRAMO_LIQUIDADO', 'No se puede registrar descarga: el tramo está liquidado')
    if (tramo.cobro_id)       throw codedError('TRAMO_COBRADO',   'No se puede registrar descarga: el tramo está cobrado')

    const { data, error } = await supabase
      .from('tramos')
      .update({ ...dto, estado: 'completado', updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Revertir el registro de descarga de un tramo: borra fecha, toneladas,
  // nº de remito e imagen de descarga, y deja el estado en 'en_curso'.
  // Bloquea si el tramo está liquidado o cobrado (rompería la contabilidad
  // aguas abajo). No toca el archivo físico en Storage — queda huérfano y
  // se limpia con un job aparte si hace falta.
  async revertirDescarga(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Cargar precondiciones.
    const { data: tramo, error: e0 } = await supabase
      .from('tramos')
      .select('id, fecha_descarga, liquidacion_id, cobro_id')
      .eq('id', id)
      .maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!tramo)                 throw codedError('TRAMO_NO_EXISTE',    'Tramo no encontrado')
    if (!tramo.fecha_descarga)  throw codedError('TRAMO_SIN_DESCARGA', 'El tramo no tiene descarga registrada')
    if (tramo.liquidacion_id)   throw codedError('TRAMO_LIQUIDADO',    'No se puede revertir: el tramo está liquidado')
    if (tramo.cobro_id)         throw codedError('TRAMO_COBRADO',      'No se puede revertir: el tramo está cobrado')

    const { data, error } = await supabase
      .from('tramos')
      .update({
        fecha_descarga:          null,
        toneladas_descarga:      null,
        // remito_descarga tiene NOT NULL con default ''. Usamos '' en lugar
        // de null para volver al valor "sin remito" sin violar la constraint.
        remito_descarga:         '',
        remito_descarga_img_url: null,
        estado:                  'en_curso',
        updated_by:              userId,
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // liquidacion_tramos era del modelo paralelo viejo — tabla eliminada
    // en la migración 20260424_drop_modelo_paralelo. El CASCADE de la FK
    // tramos.liquidacion_id se maneja arriba (los tramos a liquidar se
    // desligan primero en eliminar_liquidacion).
    const { error } = await supabase.from('tramos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
