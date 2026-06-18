import { createSupabaseClient } from '../../../lib/supabase.js'

const LUGAR_RELEVO = 'Chivilcoy'

export class RelevoError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'RelevoError'
  }
}

export interface CrearRelevoDto {
  chofer_relevo_id: number
  km_chofer_1?: number
  km_chofer_2?: number
  jornales_chofer_1?: number
  jornales_chofer_2?: number
  obs?: string
}

export interface UpdateRelevoDto {
  km_chofer_1?: number
  km_chofer_2?: number
  jornales_chofer_1?: number
  jornales_chofer_2?: number
  obs?: string
}

interface TramoRow {
  id: number
  tipo: 'cargado' | 'vacio'
  chofer_id: number | null
  cantera_id: number | null
  deposito_id: number | null
}
interface RutaRow {
  cantera_id: number
  deposito_id: number
  km_ida_vuelta: number | null
}

// Busca Chivilcoy en canteras y depósitos. Devuelve los IDs de cada uno
// (puede estar como cantera, como depósito, o ambos).
async function findChivilcoy(sb: any): Promise<{ canteraId: number | null; depositoId: number | null }> {
  const { data: dep, error: e1 } = await sb
    .from('depositos').select('id').ilike('nombre', '%chivilcoy%').limit(1).maybeSingle()
  if (e1) throw new Error(e1.message)
  const { data: cant, error: e2 } = await sb
    .from('canteras').select('id').ilike('nombre', '%chivilcoy%').limit(1).maybeSingle()
  if (e2) throw new Error(e2.message)
  return {
    canteraId:  cant?.id ?? null,
    depositoId: dep?.id  ?? null,
  }
}

// km de un trayecto cantera↔depósito. El campo se llama `km_ida_vuelta`
// pero por convención del proyecto representa los km de UN trayecto
// (cargado O vacío), no la suma. Así lo usa kmTramo en LiquidacionesTab
// y getKm en ViajesTab.
async function kmCanteraDeposito(sb: any, canteraId: number, depositoId: number): Promise<number | null> {
  const { data, error } = await sb
    .from('rutas')
    .select('km_ida_vuelta')
    .eq('cantera_id', canteraId)
    .eq('deposito_id', depositoId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.km_ida_vuelta == null) return null
  return Number(data.km_ida_vuelta)
}

// Sugiere km para un relevo en Chivilcoy.
//
// Estrategia:
// 1. Si están cargados los DOS segmentos (origen→Chivilcoy y Chivilcoy→destino),
//    se suman directamente. Esto refleja correctamente desvíos donde la ruta
//    real es más larga que la directa.
// 2. Si solo está cargado UN segmento, se completa restando del km de la ruta
//    directa. La aproximación pierde precisión cuando hay desvío.
// 3. Si no hay ninguno → falla, el user carga manual.
//
// Para tramo cargado (cantera → depósito):
//   - Segmento 1 (cantera → Chivilcoy): requiere Chivilcoy como depósito.
//   - Segmento 2 (Chivilcoy → depósito destino): requiere Chivilcoy como cantera.
// Para tramo vacío (depósito → cantera):
//   - Segmento 1 (depósito → Chivilcoy): requiere Chivilcoy como cantera.
//   - Segmento 2 (Chivilcoy → cantera): requiere Chivilcoy como depósito.
async function sugerirKm(
  sb: any,
  tramo: TramoRow,
): Promise<{ km1: number; km2: number; lugar: string; encontrado: true; metodo: 'suma' | 'resta' }
       | { encontrado: false; lugar: string; motivo: string }> {
  const lugar = LUGAR_RELEVO
  if (tramo.cantera_id == null || tramo.deposito_id == null) {
    return { encontrado: false, lugar, motivo: 'TRAMO_SIN_CANTERA_O_DEPOSITO' }
  }
  const chiv = await findChivilcoy(sb)
  if (chiv.canteraId == null && chiv.depositoId == null) {
    return { encontrado: false, lugar, motivo: 'CHIVILCOY_NO_CARGADO' }
  }

  // Resolución de cada segmento según el tipo de tramo.
  let seg1: number | null = null
  let seg2: number | null = null
  if (tramo.tipo === 'cargado') {
    // Segmento 1: cantera origen → Chivilcoy (depósito).
    if (chiv.depositoId != null) {
      seg1 = await kmCanteraDeposito(sb, tramo.cantera_id, chiv.depositoId)
    }
    // Segmento 2: Chivilcoy (cantera) → depósito destino.
    if (chiv.canteraId != null) {
      seg2 = await kmCanteraDeposito(sb, chiv.canteraId, tramo.deposito_id)
    }
  } else {
    // Tramo vacío.
    // Segmento 1: depósito origen → Chivilcoy (cantera).
    if (chiv.canteraId != null) {
      seg1 = await kmCanteraDeposito(sb, chiv.canteraId, tramo.deposito_id)
    }
    // Segmento 2: Chivilcoy (depósito) → cantera destino.
    if (chiv.depositoId != null) {
      seg2 = await kmCanteraDeposito(sb, tramo.cantera_id, chiv.depositoId)
    }
  }

  // Caso 1: ambos segmentos cargados → suma directa (preciso, considera desvíos).
  if (seg1 != null && seg2 != null) {
    return { encontrado: true, lugar, km1: seg1, km2: seg2, metodo: 'suma' }
  }

  // Caso 2: un segmento + ruta directa → resta (aproximado, no considera desvíos).
  const kmDirecto = await kmCanteraDeposito(sb, tramo.cantera_id, tramo.deposito_id)
  if (kmDirecto != null) {
    if (seg1 != null) {
      const km2 = Math.max(0, kmDirecto - seg1)
      return { encontrado: true, lugar, km1: seg1, km2, metodo: 'resta' }
    }
    if (seg2 != null) {
      const km1 = Math.max(0, kmDirecto - seg2)
      return { encontrado: true, lugar, km1, km2: seg2, metodo: 'resta' }
    }
  }

  return { encontrado: false, lugar, motivo: 'CHIVILCOY_SIN_RUTA_RELEVANTE' }
}

export const tramoRelevoService = {

  async get(tramoId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('tramo_choferes')
      .select('id, tramo_id, chofer_id, orden, km_cargado, km_vacio, jornales, lugar_relevo, obs, liquidacion_id, created_at, updated_at')
      .eq('tramo_id', tramoId)
      .order('orden', { ascending: true })
    if (error) throw new Error(error.message)
    return data
  },

  // Filas de relevo pendientes de liquidar (liquidacion_id IS NULL) cuyo tramo
  // está completado. Bounded por chofer → sin riesgo de cap PostgREST. El front
  // filtra por rango de fechas (igual que con los tramos). Fase 2 de relevos.
  async relevosPendientes(choferId: number | undefined, token: string) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('tramo_choferes')
      .select('id, tramo_id, chofer_id, orden, km_cargado, km_vacio, jornales, lugar_relevo, liquidacion_id, tramo:tramos(id, tipo, estado, camion_id, cantera_id, deposito_id, fecha_carga, fecha_descarga, fecha_vacio)')
      .is('liquidacion_id', null)
    if (choferId) q = q.eq('chofer_id', choferId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []).filter((r: any) => r.tramo && r.tramo.estado === 'completado')
  },

  // Patas de relevo YA liquidadas (con camión/tipo del tramo) para que el
  // reporte de gastos impute la MO del relevista al camión real. Volumen chico
  // (solo tramos relevados); si crece, paginar/filtrar por rango.
  async relevosLiquidados(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('tramo_choferes')
      .select('id, tramo_id, liquidacion_id, chofer_id, km_cargado, km_vacio, tramo:tramos(camion_id, tipo)')
      .not('liquidacion_id', 'is', null)
    if (error) throw new Error(error.message)
    return data ?? []
  },

  // Sólo sugerencia, sin escribir. Se llama desde la UI antes de abrir el modal
  // de relevo para mostrar km calculados.
  async sugerencia(tramoId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: tramo, error } = await sb
      .from('tramos').select('id, tipo, chofer_id, cantera_id, deposito_id')
      .eq('id', tramoId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!tramo) throw new RelevoError(404, 'TRAMO_NO_EXISTE')
    return sugerirKm(sb, tramo as TramoRow)
  },

  async crear(tramoId: number, dto: CrearRelevoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data: tramo, error } = await sb
      .from('tramos').select('id, tipo, chofer_id, cantera_id, deposito_id, liquidacion_id')
      .eq('id', tramoId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!tramo) throw new RelevoError(404, 'TRAMO_NO_EXISTE')
    if (!tramo.chofer_id) throw new RelevoError(400, 'TRAMO_SIN_CHOFER')
    if (tramo.liquidacion_id != null) {
      throw new RelevoError(409, 'TRAMO_YA_LIQUIDADO', { message: 'El tramo ya está liquidado; no se puede agregar un relevo (reabrí la liquidación primero).' })
    }
    if (tramo.chofer_id === dto.chofer_relevo_id) {
      throw new RelevoError(400, 'CHOFER_IGUAL', { message: 'El chofer de relevo no puede ser el mismo que el chofer del tramo.' })
    }

    // Si ya existe relevo, error (usar PATCH para editar).
    const { data: existing, error: errEx } = await sb
      .from('tramo_choferes').select('id').eq('tramo_id', tramoId).limit(1)
    if (errEx) throw new Error(errEx.message)
    if (existing && existing.length > 0) {
      throw new RelevoError(409, 'RELEVO_YA_EXISTE')
    }

    // Auto-sugerencia si no se pasaron km manualmente.
    let km1 = dto.km_chofer_1
    let km2 = dto.km_chofer_2
    let lugar = LUGAR_RELEVO
    if (km1 == null || km2 == null) {
      const sug = await sugerirKm(sb, tramo as TramoRow)
      if (sug.encontrado) {
        if (km1 == null) km1 = sug.km1
        if (km2 == null) km2 = sug.km2
        lugar = sug.lugar
      } else {
        // Sin sugerencia: el cliente DEBERÍA haber mandado km. Si no, default a 0.
        if (km1 == null) km1 = 0
        if (km2 == null) km2 = 0
      }
    }

    const isCargado = (tramo as TramoRow).tipo === 'cargado'
    const rows = [
      {
        tramo_id:      tramoId,
        chofer_id:     tramo.chofer_id,
        orden:         1,
        km_cargado:    isCargado ? km1 : 0,
        km_vacio:      isCargado ? 0 : km1,
        jornales:      dto.jornales_chofer_1 ?? 1,
        lugar_relevo:  lugar,
        obs:           dto.obs ?? null,
        created_by:    userId,
        updated_by:    userId,
      },
      {
        tramo_id:      tramoId,
        chofer_id:     dto.chofer_relevo_id,
        orden:         2,
        km_cargado:    isCargado ? km2 : 0,
        km_vacio:      isCargado ? 0 : km2,
        jornales:      dto.jornales_chofer_2 ?? 1,
        lugar_relevo:  lugar,
        obs:           dto.obs ?? null,
        created_by:    userId,
        updated_by:    userId,
      },
    ]

    const { data, error: errIns } = await sb
      .from('tramo_choferes').insert(rows)
      .select('id, tramo_id, chofer_id, orden, km_cargado, km_vacio, jornales, lugar_relevo, obs, created_at, updated_at')
      .order('orden', { ascending: true })
    if (errIns) throw new Error(errIns.message)
    return data
  },

  async update(tramoId: number, dto: UpdateRelevoDto, token: string, userId: string) {
    const sb = createSupabaseClient(token)
    const { data: rows, error } = await sb
      .from('tramo_choferes').select('id, tramo_id, orden, km_cargado, km_vacio, liquidacion_id')
      .eq('tramo_id', tramoId)
      .order('orden', { ascending: true })
    if (error) throw new Error(error.message)
    if (!rows || rows.length !== 2) throw new RelevoError(404, 'RELEVO_NO_EXISTE')
    if (rows.some((r: any) => r.liquidacion_id != null)) {
      throw new RelevoError(409, 'RELEVO_LIQUIDADO', { message: 'El relevo ya está liquidado; reabrí la liquidación para editarlo.' })
    }

    const { data: tramo, error: errT } = await sb
      .from('tramos').select('tipo').eq('id', tramoId).maybeSingle()
    if (errT || !tramo) throw new RelevoError(404, 'TRAMO_NO_EXISTE')
    const isCargado = tramo.tipo === 'cargado'

    const updates: Array<{ id: number; km_cargado?: number; km_vacio?: number; jornales?: number; obs?: string | null; updated_by: string }> = []
    for (const r of rows) {
      const km = r.orden === 1 ? dto.km_chofer_1 : dto.km_chofer_2
      const jornales = r.orden === 1 ? dto.jornales_chofer_1 : dto.jornales_chofer_2
      const u: any = { id: r.id, updated_by: userId }
      if (km !== undefined) {
        if (isCargado) u.km_cargado = km
        else u.km_vacio = km
      }
      if (jornales !== undefined) u.jornales = jornales
      if (dto.obs !== undefined) u.obs = dto.obs ?? null
      updates.push(u)
    }
    for (const u of updates) {
      const { id, ...patch } = u
      const { error: errU } = await sb
        .from('tramo_choferes').update(patch).eq('id', id)
      if (errU) throw new Error(errU.message)
    }
    return this.get(tramoId, token)
  },

  async delete(tramoId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data: rows, error: errSel } = await sb
      .from('tramo_choferes').select('id, liquidacion_id').eq('tramo_id', tramoId)
    if (errSel) throw new Error(errSel.message)
    if (rows && rows.some((r: any) => r.liquidacion_id != null)) {
      throw new RelevoError(409, 'RELEVO_LIQUIDADO', { message: 'El relevo ya está liquidado; reabrí la liquidación para eliminarlo.' })
    }
    const { error } = await sb
      .from('tramo_choferes').delete().eq('tramo_id', tramoId)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
