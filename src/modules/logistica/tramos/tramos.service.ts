import { createSupabaseClient, supabase as supabaseAdmin } from '../../../lib/supabase.js'
// Criterio compartido de "¿este campo cambió de verdad?" — lo usan también los
// guards de lugares y tarifas (ver src/lib/cambios.ts).
import { valorCambio } from '../../../lib/cambios.js'
import type { CreateTramoDto, UpdateTramoDto, RegistrarDescargaDto } from './tramos.schema.js'

// Helper para errores con código que el handler HTTP mapea a status
// específicos (ver tramos.routes.ts).
function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string }
  e.code = code
  return e
}

// ── Qué campos de un tramo mueven plata, y cuál ────────────────────────────
// Documentación pura: no entran en ningún cálculo, se corrigen siempre (el
// caso típico es el remito cargado con un provisorio y corregido después,
// cuando el tramo ya se liquidó).
const CAMPOS_SIN_PLATA = new Set([
  'obs',
  'remito_carga', 'remito_carga_img_url',
  'remito_descarga', 'remito_descarga_img_url',
])

// Sólo afectan la FACTURACIÓN al cliente (el cobro se arma por tonelada y por
// tarifa de la empresa). En modalidad km_jornal la liquidación del chofer no
// los mira (días × básico + km × $/km), así que un tramo liquidado pero
// todavía sin facturar los puede corregir.
// ⚠️ En modalidad pct estos campos SÍ mueven la comisión: la base_neta es
// Σ ton × tarifa (por empresa/variante) ÷ 1,21, y queda SNAPSHOTEADA al crear
// el borrador — cerrar NO recalcula. Por eso update() los bloquea cuando la
// liquidación del tramo es pct (ver guard más abajo).
const CAMPOS_SOLO_COBRO = new Set(['toneladas_carga', 'toneladas_descarga', 'empresa_id', 'tarifa_variante'])

// El resto (chofer, camión, tipo, cantera, depósito, fechas, estado) cambia km
// o días: pega en la liquidación Y en el cobro.

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
    // PostgREST capea cada RESPUESTA a 1000 filas y el recorte es silencioso
    // (CLAUDE.md §5.7 del frontend). Como el orden es fecha DESC, al pasar las
    // 1000 se caerían los tramos MÁS VIEJOS: un viaje viejo sin liquidar
    // desaparecería de la lista de pendientes y ese chofer no cobraría nunca.
    // Se pagina en el server y se devuelve todo junto — mismo shape de siempre.
    // A ~81 tramos/mes esto compra años; si el payload molesta algún día, el
    // paso siguiente es filtrar por pantalla (rango de fechas / sin_liquidar).
    const PAGINA = 1000
    const todos: Record<string, unknown>[] = []
    for (let desde = 0; ; desde += PAGINA) {
      // Orden estable: fecha_operacion DESC; tiebreaker manual (orden_dia)
      // y finalmente id DESC — necesario para que las páginas no se solapen.
      const { data, error } = await supabase
        .from('tramos')
        .select('*')
        .order('fecha_operacion', { ascending: false, nullsFirst: false })
        .order('orden_dia', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(desde, desde + PAGINA - 1)
      if (error) throw new Error(error.message)
      todos.push(...(data ?? []))
      if ((data ?? []).length < PAGINA) break
    }
    // Dedup por id: un INSERT entre página y página corre las filas hacia
    // abajo (orden DESC) y puede repetir una en el borde. Duplicada rompería
    // los agregados; perdida no puede quedar, el corrimiento va para abajo.
    const vistos = new Set<number>()
    return todos.filter(t => {
      const id = Number(t.id)
      if (vistos.has(id)) return false
      vistos.add(id)
      return true
    })
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

    // Guard por CAMPO, no por tramo entero: un tramo liquidado/cobrado tiene
    // km, toneladas y empresa snapshoteados, pero no todos los campos entran
    // en esos números y bloquear el tramo completo obligaba a reabrir una
    // liquidación sólo para corregir el número de un remito.
    const conPlata = Object.keys(patch).filter(k => !CAMPOS_SIN_PLATA.has(k))
    if (conPlata.length > 0) {
      const { data: tramo, error: e0 } = await supabase
        .from('tramos')
        .select('*')
        .eq('id', id)
        .maybeSingle()
      if (e0) throw new Error(e0.message)
      if (!tramo) throw codedError('TRAMO_NO_EXISTE', 'Tramo no encontrado')

      // Sólo cuentan los campos que EFECTIVAMENTE cambian de valor.
      const cambiados = conPlata.filter(k => valorCambio(patch[k], (tramo as Record<string, unknown>)[k]))

      // La liquidación del chofer es días × básico + km × $/km: no mira
      // toneladas ni empresa, así que esos dos sólo chocan con el cobro.
      const tocaLiquidacion = cambiados.filter(k => !CAMPOS_SOLO_COBRO.has(k))
      if (tramo.liquidacion_id && tocaLiquidacion.length > 0) {
        throw codedError(
          'TRAMO_LIQUIDADO',
          `No se puede cambiar ${tocaLiquidacion.join(', ')}: el tramo está liquidado (liquidación N° ${tramo.liquidacion_id}). Los remitos y las observaciones sí se pueden corregir.`,
        )
      }
      // La exención de CAMPOS_SOLO_COBRO vale sólo para km_jornal. En pct la
      // comisión del chofer se calcula sobre ton × tarifa (empresa/variante
      // incluidas) y la base_neta queda snapshoteada al CREAR el borrador —
      // cerrar no recalcula. Editar estos campos con el tramo ya vinculado
      // desincronizaría la base sin que nadie lo note.
      const soloCobroCambiados = cambiados.filter(k => CAMPOS_SOLO_COBRO.has(k))
      if (tramo.liquidacion_id && soloCobroCambiados.length > 0) {
        const { data: liq, error: eLiq } = await supabase
          .from('liquidaciones')
          .select('modalidad')
          .eq('id', tramo.liquidacion_id)
          .maybeSingle()
        if (eLiq) throw new Error(eLiq.message)
        if (liq?.modalidad === 'pct') {
          throw codedError(
            'TRAMO_LIQUIDADO',
            `No se puede cambiar ${soloCobroCambiados.join(', ')}: el tramo está en la liquidación N° ${tramo.liquidacion_id}, de modalidad porcentaje, y esos campos afectan la comisión del chofer. Reabrí (o eliminá el borrador de) esa liquidación primero.`,
          )
        }
      }
      // El cobro se arma por tonelada y por tarifa de empresa/unidad: cualquiera
      // de estos campos lo desincroniza.
      if (tramo.cobro_id && cambiados.length > 0) {
        throw codedError(
          'TRAMO_COBRADO',
          `No se puede cambiar ${cambiados.join(', ')}: el tramo ya está facturado (cobro N° ${tramo.cobro_id}). Los remitos y las observaciones sí se pueden corregir.`,
        )
      }
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

    // Un tramo liquidado NO se borra. Era el único camino mutativo que quedaba
    // sin este candado (editar, registrar descarga y revertir ya lo tenían), y
    // es la vía viva más probable de fabricar una liquidación huérfana: borrar
    // el último tramo de una liquidación cerrada la deja como cáscara, con los
    // subtotales intactos y nada adentro, y los reportes la siguen contando
    // como plata real. Pasó el 2026-07-26 con las liq 23 y 25.
    // El camino correcto es reabrir la liquidación (que desliga los tramos) y
    // recién ahí borrar.
    const { data: tramo, error: e0 } = await supabase
      .from('tramos')
      .select('liquidacion_id, cobro_id')
      .eq('id', id)
      .single()
    if (e0) throw new Error(e0.message)
    if (tramo.liquidacion_id) {
      throw codedError(
        'TRAMO_LIQUIDADO',
        `No se puede borrar: el tramo está liquidado (liquidación N° ${tramo.liquidacion_id}). Reabrí esa liquidación primero.`,
      )
    }
    if (tramo.cobro_id) {
      throw codedError(
        'TRAMO_COBRADO',
        `No se puede borrar: el tramo está en un cobro facturado (N° ${tramo.cobro_id}). Deshacé el cobro primero.`,
      )
    }

    // liquidacion_tramos era del modelo paralelo viejo — tabla eliminada
    // en la migración 20260424_drop_modelo_paralelo. El CASCADE de la FK
    // tramos.liquidacion_id se maneja arriba (los tramos a liquidar se
    // desligan primero en eliminar_liquidacion).
    const { error } = await supabase.from('tramos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
