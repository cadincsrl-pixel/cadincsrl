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

// Busca Chivilcoy en canteras y depósitos. Devuelve el primero que encuentre.
async function findChivilcoy(sb: any): Promise<{ kind: 'cantera' | 'deposito'; id: number } | null> {
  const { data: dep, error: e1 } = await sb
    .from('depositos').select('id').ilike('nombre', '%chivilcoy%').limit(1).maybeSingle()
  if (e1) throw new Error(e1.message)
  if (dep) return { kind: 'deposito', id: dep.id }

  const { data: cant, error: e2 } = await sb
    .from('canteras').select('id').ilike('nombre', '%chivilcoy%').limit(1).maybeSingle()
  if (e2) throw new Error(e2.message)
  if (cant) return { kind: 'cantera', id: cant.id }

  return null
}

// km del tramo entre una cantera y un depósito. Pese al nombre del campo
// `km_ida_vuelta`, el valor representa los km de UN trayecto (cargado O
// vacío), no la suma — así lo usa el resto del proyecto (kmTramo en
// LiquidacionesTab, getKm en ViajesTab, etc.).
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

// Sugiere km para cada chofer en un relevo, asumiendo que el lugar
// intermedio es Chivilcoy (cantera o depósito). Devuelve { km1, km2 }
// o null si no se puede calcular automáticamente.
//
// Tramo cargado: cantera → depósito.
//   - Si Chivilcoy es depósito: necesitamos ruta(cantera, Chivilcoy) y ruta(cantera, depósito) para resta.
//   - Si Chivilcoy es cantera:  necesitamos ruta(Chivilcoy, depósito) y ruta(cantera, depósito).
//
// Tramo vacío: depósito → cantera (mismo set de rutas, indexada al revés).
async function sugerirKm(
  sb: any,
  tramo: TramoRow,
): Promise<{ km1: number; km2: number; lugar: string; encontrado: true }
       | { encontrado: false; lugar: string; motivo: string }> {
  const lugar = LUGAR_RELEVO
  if (tramo.cantera_id == null || tramo.deposito_id == null) {
    return { encontrado: false, lugar, motivo: 'TRAMO_SIN_CANTERA_O_DEPOSITO' }
  }
  const chiv = await findChivilcoy(sb)
  if (!chiv) return { encontrado: false, lugar, motivo: 'CHIVILCOY_NO_CARGADO' }

  const kmTotal = await kmCanteraDeposito(sb, tramo.cantera_id, tramo.deposito_id)
  if (kmTotal == null) return { encontrado: false, lugar, motivo: 'RUTA_PRINCIPAL_SIN_KM' }

  // Para tramo cargado: chofer 1 hace cantera→Chivilcoy, chofer 2 hace Chivilcoy→destino.
  // Para tramo vacío:   chofer 1 hace depósito→Chivilcoy, chofer 2 hace Chivilcoy→cantera.
  // El chofer "que termina en Chivilcoy" es siempre chofer 1.
  let kmHastaChivilcoy: number | null = null
  if (chiv.kind === 'deposito') {
    if (tramo.tipo === 'cargado') {
      // cantera → depósito-chivilcoy (km1)
      kmHastaChivilcoy = await kmCanteraDeposito(sb, tramo.cantera_id, chiv.id)
    } else {
      // depósito-origen → depósito-chivilcoy. No hay relación directa en `rutas`.
      // Lo aproximamos con: ruta(canteraDestino, Chivilcoy). Es el segmento que
      // recorre el chofer 2 (Chivilcoy → cantera) → así km2 = ese, y km1 = total - km2.
      const km2 = await kmCanteraDeposito(sb, tramo.cantera_id, chiv.id)
      if (km2 == null) return { encontrado: false, lugar, motivo: 'CHIVILCOY_SIN_RUTA_RELEVANTE' }
      const km1 = Math.max(0, kmTotal - km2)
      return { encontrado: true, lugar, km1, km2 }
    }
  } else {
    // chiv es cantera
    if (tramo.tipo === 'cargado') {
      // cantera-origen → Chivilcoy (cantera-cantera, no hay en `rutas`).
      // Aproximamos con: ruta(Chivilcoy, depósito). Es lo que hace chofer 2.
      const km2 = await kmCanteraDeposito(sb, chiv.id, tramo.deposito_id)
      if (km2 == null) return { encontrado: false, lugar, motivo: 'CHIVILCOY_SIN_RUTA_RELEVANTE' }
      const km1 = Math.max(0, kmTotal - km2)
      return { encontrado: true, lugar, km1, km2 }
    } else {
      // depósito → Chivilcoy (cantera).
      kmHastaChivilcoy = await kmCanteraDeposito(sb, chiv.id, tramo.deposito_id)
    }
  }

  if (kmHastaChivilcoy == null) {
    return { encontrado: false, lugar, motivo: 'CHIVILCOY_SIN_RUTA_RELEVANTE' }
  }
  const km1 = kmHastaChivilcoy
  const km2 = Math.max(0, kmTotal - km1)
  return { encontrado: true, lugar, km1, km2 }
}

export const tramoRelevoService = {

  async get(tramoId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('tramo_choferes')
      .select('id, tramo_id, chofer_id, orden, km_cargado, km_vacio, jornales, lugar_relevo, obs, created_at, updated_at')
      .eq('tramo_id', tramoId)
      .order('orden', { ascending: true })
    if (error) throw new Error(error.message)
    return data
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
      .from('tramos').select('id, tipo, chofer_id, cantera_id, deposito_id')
      .eq('id', tramoId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!tramo) throw new RelevoError(404, 'TRAMO_NO_EXISTE')
    if (!tramo.chofer_id) throw new RelevoError(400, 'TRAMO_SIN_CHOFER')
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
      .from('tramo_choferes').select('id, tramo_id, orden, km_cargado, km_vacio')
      .eq('tramo_id', tramoId)
      .order('orden', { ascending: true })
    if (error) throw new Error(error.message)
    if (!rows || rows.length !== 2) throw new RelevoError(404, 'RELEVO_NO_EXISTE')

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
    const { error } = await sb
      .from('tramo_choferes').delete().eq('tramo_id', tramoId)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
