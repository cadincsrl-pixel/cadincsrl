import { createSupabaseClient } from '../../../lib/supabase.js'
import { valorCambio } from '../../../lib/cambios.js'
import type {
  CreateLugarDto, UpdateLugarDto, CreateRutaDto, UpdateRutaDto,
  CrearLugarOperativoDto, UpdateLugarOperativoDto,
} from './lugares.schema.js'

function codedError(code: string, message: string, detail?: unknown): Error {
  const e = new Error(message) as Error & { code?: string; detail?: unknown }
  e.code = code
  if (detail !== undefined) e.detail = detail
  return e
}

// ── Renombre de un lugar con historial ─────────────────────────────────────
// El nombre de una cantera/depósito no es un dato suelto: es la etiqueta con la
// que se muestran TODOS los viajes que ya colgaban de esa ficha. Renombrar
// reescribe el pasado. El 27/07/2026 se renombró la cantera "Nueva Esperanza"
// a "Fátima" (era un lugar nuevo, había que crear otra ficha): 10 viajes
// quedaron reetiquetados, con coordenadas a 90 km, y hubo que ajustar la
// liquidación de un chofer. Desde entonces el renombre de un lugar con viajes
// exige `confirmar_renombre: true` — la UI muestra el aviso, y el que pega
// directo a la API tiene que mandarlo a propósito.

type TablaLugar = 'canteras' | 'depositos'

const LUGAR_META: Record<TablaLugar, {
  columnaTramo: 'cantera_id' | 'deposito_id'
  etiqueta:     string
  noExiste:     string
  crearOtro:    string
}> = {
  canteras: {
    columnaTramo: 'cantera_id',
    etiqueta:     'La cantera',
    noExiste:     'Cantera no encontrada',
    crearOtro:    'Si "%NUEVO%" es otro lugar, cerrá esto y cargá una cantera nueva en vez de renombrar esta.',
  },
  depositos: {
    columnaTramo: 'deposito_id',
    etiqueta:     'El depósito',
    noExiste:     'Depósito no encontrado',
    crearOtro:    'Si "%NUEVO%" es otro lugar, cerrá esto y cargá un depósito nuevo en vez de renombrar este.',
  },
}

/** Cuenta los viajes que cuelgan de un lugar operativo (par cantera+depósito)
 *  y corta con LUGAR_CON_HISTORIAL si hay alguno.
 *
 *  Un lugar operativo aparece en los tramos de las dos puntas: como origen
 *  (`cantera_id`) cuando el camión sale de ahí y como destino (`deposito_id`)
 *  cuando vuelve. Contar una sola columna subestima el daño: al 28/07/2026
 *  CHIVILCOY tenía 6 viajes como punto de carga y 12 como destino.
 *
 *  Además hay una trampa: `relevo.service.ts` encuentra Chivilcoy por NOMBRE
 *  (`ilike '%chivilcoy%'`), así que renombrarlo no sólo reetiqueta el historial,
 *  también deja de resolver los relevos de tramo. Va en el mensaje. */
async function frenarRenombreConHistorial(
  supabase: ReturnType<typeof createSupabaseClient>,
  p: { nombreActual: string; nombreNuevo: string; canteraId: number; depositoId: number },
): Promise<void> {
  const filtro = `cantera_id.eq.${p.canteraId},deposito_id.eq.${p.depositoId}`
  const [total, comoCantera, comoDeposito] = await Promise.all([
    supabase.from('tramos').select('id', { count: 'exact', head: true }).or(filtro),
    supabase.from('tramos').select('id', { count: 'exact', head: true }).eq('cantera_id', p.canteraId),
    supabase.from('tramos').select('id', { count: 'exact', head: true }).eq('deposito_id', p.depositoId),
  ])
  for (const r of [total, comoCantera, comoDeposito]) if (r.error) throw new Error(r.error.message)

  const viajes = total.count ?? 0
  if (viajes === 0) return

  const comoQue = [
    (comoCantera.count ?? 0) > 0 ? `${comoCantera.count} como punto de carga` : null,
    (comoDeposito.count ?? 0) > 0 ? `${comoDeposito.count} como destino` : null,
  ].filter(Boolean).join(' y ')
  const tiene = viajes === 1 ? '1 viaje cargado' : `${viajes} viajes cargados`
  const pasan = viajes === 1 ? 'ese viaje va a pasar' : `esos ${viajes} viajes van a pasar`
  // Los relevos de tramo ubican Chivilcoy por nombre (relevo.service.ts:
  // ilike '%chivilcoy%'), así que ahí el renombre además rompe el cálculo.
  const rompeRelevos = /chivilcoy/i.test(p.nombreActual) && !/chivilcoy/i.test(p.nombreNuevo)

  throw codedError(
    'LUGAR_CON_HISTORIAL',
    `El lugar operativo "${p.nombreActual}" tiene ${tiene}${comoQue ? ` (${comoQue})` : ''}. ` +
    `Si le cambiás el nombre a "${p.nombreNuevo}", ${pasan} a figurar como "${p.nombreNuevo}", ` +
    `porque el nombre se guarda una sola vez y lo comparten el punto de carga y el destino. ` +
    (rompeRelevos
      ? `Ojo: los relevos de tramo ubican a Chivilcoy por su nombre, así que si le sacás "Chivilcoy" dejan de encontrarlo. `
      : '') +
    `Si "${p.nombreNuevo}" es otro lugar, cerrá esto y cargá un lugar operativo nuevo en vez de renombrar este.`,
    {
      viajes,
      rompe_relevos: rompeRelevos,
      como_cantera:  comoCantera.count ?? 0,
      como_deposito: comoDeposito.count ?? 0,
      nombre_actual: p.nombreActual,
      nombre_nuevo:  p.nombreNuevo,
      tipo:          'operativo',
      cantera_id:    p.canteraId,
      deposito_id:   p.depositoId,
    },
  )
}

/** Actualiza cantera o depósito. Si el patch cambia el nombre y el lugar ya
 *  tiene viajes, corta con LUGAR_CON_HISTORIAL salvo que venga confirmado. */
async function actualizarLugar(
  tabla: TablaLugar,
  id: number,
  dto: UpdateLugarDto,
  token: string,
  userId: string,
) {
  const supabase = createSupabaseClient(token)
  // El flag es una confirmación de la operación, no un campo del registro.
  const { confirmar_renombre, ...patch } = dto
  const meta = LUGAR_META[tabla]

  // Sólo el nombre reetiqueta historial: localidad, coordenadas y obs se
  // corrigen sin preguntar nada.
  if (patch.nombre !== undefined) {
    const { data: actual, error: e0 } = await supabase
      .from(tabla).select('nombre').eq('id', id).maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!actual) throw codedError('LUGAR_NO_EXISTE', meta.noExiste)

    if (!confirmar_renombre && valorCambio(patch.nombre, actual.nombre)) {
      const { count, error: e1 } = await supabase
        .from('tramos')
        .select('id', { count: 'exact', head: true })
        .eq(meta.columnaTramo, id)
      if (e1) throw new Error(e1.message)

      const viajes = count ?? 0
      if (viajes > 0) {
        const tiene = viajes === 1 ? '1 viaje cargado' : `${viajes} viajes cargados`
        const pasan = viajes === 1 ? 'ese viaje va a pasar' : `esos ${viajes} viajes van a pasar`
        throw codedError(
          'LUGAR_CON_HISTORIAL',
          `${meta.etiqueta} "${actual.nombre}" tiene ${tiene}. ` +
          `Si le cambiás el nombre a "${patch.nombre}", ${pasan} a figurar como "${patch.nombre}". ` +
          meta.crearOtro.replace('%NUEVO%', patch.nombre),
          {
            viajes,
            nombre_actual: actual.nombre,
            nombre_nuevo:  patch.nombre,
            tipo: tabla === 'canteras' ? 'cantera' : 'deposito',
          },
        )
      }
    }
  }

  const { data, error } = await supabase
    .from(tabla)
    .update({ ...patch, updated_by: userId })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export const lugaresService = {
  async getCanteras(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('canteras').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getDepositos(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('depositos').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async getRutas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .select('*, canteras(nombre), depositos(nombre)')
      .order('id')
    if (error) throw new Error(error.message)
    return data
  },

  async createCantera(dto: CreateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('canteras')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createDeposito(dto: CreateLugarDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('depositos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createRuta(dto: CreateRutaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCantera(id: number, dto: UpdateLugarDto, token: string, userId: string) {
    return actualizarLugar('canteras', id, dto, token, userId)
  },

  async updateDeposito(id: number, dto: UpdateLugarDto, token: string, userId: string) {
    return actualizarLugar('depositos', id, dto, token, userId)
  },

  async updateRuta(id: number, dto: UpdateRutaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('rutas')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteRuta(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('rutas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Lugares operativos (par cantera+depósito gestionado como un concepto) ──

  async getLugaresOperativos(token: string) {
    const supabase = createSupabaseClient(token)
    // La geo (localidad/maps_url/lat/lng) vive en el par; la traemos de la
    // cantera (cantera y depósito están sincronizados) y la aplanamos.
    const { data, error } = await supabase
      .from('lugares_operativos')
      .select('id, nombre, cantera_id, deposito_id, obs, cantera:canteras(localidad, maps_url, lat, lng)')
      .order('nombre')
    if (error) throw new Error(error.message)
    return (data ?? []).map((l: any) => {
      const c = Array.isArray(l.cantera) ? l.cantera[0] : l.cantera
      return {
        id: l.id, nombre: l.nombre, cantera_id: l.cantera_id, deposito_id: l.deposito_id, obs: l.obs,
        localidad: c?.localidad ?? null,
        maps_url:  c?.maps_url  ?? null,
        lat: c?.lat ?? null,
        lng: c?.lng ?? null,
      }
    })
  },

  /** Crea el lugar operativo = cantera (operativo) + depósito (operativo) +
   *  fila que los vincula. La geo va al par (la usan tramos/en-ruta). Si algún
   *  paso falla, limpia los anteriores. */
  async crearLugarOperativo(dto: CrearLugarOperativoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const base = {
      nombre: dto.nombre, operativo: true,
      localidad: dto.localidad ?? '', maps_url: dto.maps_url ?? '',
      lat: dto.lat ?? null, lng: dto.lng ?? null,
      created_by: userId, updated_by: userId,
    }

    const { data: cantera, error: e1 } = await supabase
      .from('canteras').insert(base).select('id').single()
    if (e1) throw new Error(e1.message)

    const { data: deposito, error: e2 } = await supabase
      .from('depositos').insert(base).select('id').single()
    if (e2) {
      await supabase.from('canteras').delete().eq('id', cantera.id)
      throw new Error(e2.message)
    }

    const { data, error: e3 } = await supabase
      .from('lugares_operativos')
      .insert({ nombre: dto.nombre, obs: dto.obs ?? null, cantera_id: cantera.id, deposito_id: deposito.id, created_by: userId, updated_by: userId })
      .select('*').single()
    if (e3) {
      await supabase.from('depositos').delete().eq('id', deposito.id)
      await supabase.from('canteras').delete().eq('id', cantera.id)
      throw new Error(e3.message)
    }
    return data
  },

  // El modal de lugares operativos es el ÚNICO camino de la UI para renombrar
  // CHIVILCOY o Yerba Buena: LugaresTab esconde de las listas de canteras y
  // depósitos a los que forman parte de un par. Así que la barrera de renombre
  // tiene que estar acá TAMBIÉN — si no, alcanza con abrir este modal para
  // reetiquetar el historial sin que nadie avise. Y acá el renombre pega doble:
  // toca la cantera y el depósito del par de una sola pasada.
  async actualizarLugarOperativo(id: number, dto: UpdateLugarOperativoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { confirmar_renombre, ...campos } = dto
    const { data: lugar, error: e0 } = await supabase
      .from('lugares_operativos').select('*').eq('id', id).maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!lugar) throw codedError('NO_EXISTE', 'Lugar operativo no encontrado')

    // Sólo el nombre reetiqueta historial: localidad y coordenadas se corrigen
    // sin preguntar nada.
    if (campos.nombre !== undefined && !confirmar_renombre && valorCambio(campos.nombre, lugar.nombre)) {
      await frenarRenombreConHistorial(supabase, {
        nombreActual: String(lugar.nombre),
        nombreNuevo:  campos.nombre,
        canteraId:    lugar.cantera_id,
        depositoId:   lugar.deposito_id,
      })
    }

    // Nombre + geo viven en el par (cantera+depósito) — los mantenemos en sync.
    const parPatch: Record<string, unknown> = { updated_by: userId }
    if (campos.nombre    !== undefined) parPatch.nombre    = campos.nombre
    if (campos.localidad !== undefined) parPatch.localidad = campos.localidad
    if (campos.maps_url  !== undefined) parPatch.maps_url  = campos.maps_url
    if (campos.lat       !== undefined) parPatch.lat       = campos.lat
    if (campos.lng       !== undefined) parPatch.lng       = campos.lng
    if (Object.keys(parPatch).length > 1) { // algo más que updated_by
      const r1 = await supabase.from('canteras').update(parPatch).eq('id', lugar.cantera_id)
      if (r1.error) throw new Error(r1.error.message)
      const r2 = await supabase.from('depositos').update(parPatch).eq('id', lugar.deposito_id)
      if (r2.error) throw new Error(r2.error.message)
    }

    // En lugares_operativos solo persistimos nombre + obs (la geo se lee del par).
    const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date().toISOString() }
    if (campos.nombre !== undefined) patch.nombre = campos.nombre
    if (campos.obs !== undefined)    patch.obs = campos.obs
    const { data, error } = await supabase
      .from('lugares_operativos').update(patch).eq('id', id).select('*').single()
    if (error) throw new Error(error.message)
    return data
  },

  async eliminarLugarOperativo(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data: lugar, error: e0 } = await supabase
      .from('lugares_operativos').select('*').eq('id', id).maybeSingle()
    if (e0) throw new Error(e0.message)
    if (!lugar) throw codedError('NO_EXISTE', 'Lugar operativo no encontrado')

    // No borrar si la cantera/depósito está en uso. Chequeamos las tablas que
    // referencian con RESTRICT (tramos, rutas); cualquier otra FK no contemplada
    // se atrapa abajo (Postgres 23503 → EN_USO) para no devolver un 500 crudo.
    const filtro = `cantera_id.eq.${lugar.cantera_id},deposito_id.eq.${lugar.deposito_id}`
    for (const tabla of ['tramos', 'rutas']) {
      const { count, error } = await supabase.from(tabla).select('id', { count: 'exact', head: true }).or(filtro)
      if (error) throw new Error(error.message)
      if ((count ?? 0) > 0) throw codedError('EN_USO', 'No se puede eliminar: el lugar tiene tramos o rutas asociadas')
    }

    // Primero la fila operativa (FK a canteras/depositos), después el par.
    try {
      for (const op of [
        () => supabase.from('lugares_operativos').delete().eq('id', id),
        () => supabase.from('depositos').delete().eq('id', lugar.deposito_id),
        () => supabase.from('canteras').delete().eq('id', lugar.cantera_id),
      ]) {
        const { error } = await op()
        if (error) throw error
      }
    } catch (err: any) {
      if (err?.code === '23503') throw codedError('EN_USO', 'No se puede eliminar: el lugar está en uso en otra parte del sistema')
      throw new Error(err?.message ?? 'Error al eliminar el lugar operativo')
    }
    return { success: true }
  },
}
