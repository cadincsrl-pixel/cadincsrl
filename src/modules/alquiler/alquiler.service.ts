import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import { HTTPException } from 'hono/http-exception'
import type {
  CreateMaquinaDto,
  UpdateMaquinaDto,
  CreateObraDto,
  UpdateObraDto,
  CreateObraMaquinaDto,
  UpdateObraMaquinaDto,
  CreateParteDto,
  UpdateParteDto,
  ListPartesQuery,
  ListRemitosQuery,
  ReporteHorasQuery,
} from './alquiler.schema.js'

// ═══════════════════════════════════════════════════════════════════
//  SCOPE POR IDENTIDAD (Fase 3)
// ───────────────────────────────────────────────────────────────────
//  La seguridad real vive acá (CLAUDE.md §5.4: RLS permisiva, el backend
//  filtra). `requirePermiso('alquiler', accion)` ya gatea POR ACCIÓN
//  (un jefe con solo `lectura` no puede mutar). El scope agrega POR FILA:
//
//   - admin            → ve y opera TODO.
//   - jefe de obra     → ve (read-only) SOLO las obras donde es jefe
//                        (jefe_obra_user_id = él). El read-only ya sale del
//                        gate de acción: no tiene creacion/actualizacion.
//   - maquinista       → ve y carga SOLO sus máquinas (las asignaciones
//                        alquiler_obra_maquinas.maquinista_user_id = él).
//
//  Un usuario puede ser jefe de una obra Y maquinista en otra.
// ═══════════════════════════════════════════════════════════════════
interface AlquilerScope {
  isAdmin:            boolean
  jefeObraIds:        number[]        // obras donde es jefe (ve todas sus máquinas)
  maquinistaObraIds:  number[]        // obras donde es maquinista de ≥1 máquina
  maquinistaPairs:    Set<string>     // `${obra_id}:${maquina_id}` que puede CARGAR
}

async function getScope(userId: string): Promise<AlquilerScope> {
  // El rol (admin) vive en profiles; lo leemos con el cliente admin igual
  // que el middleware de permisos.
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('rol')
    .eq('id', userId)
    .single()

  if (profile?.rol === 'admin') {
    return { isAdmin: true, jefeObraIds: [], maquinistaObraIds: [], maquinistaPairs: new Set() }
  }

  const [{ data: jefeObras }, { data: asigs }] = await Promise.all([
    supabaseAdmin.from('alquiler_obras').select('id').eq('jefe_obra_user_id', userId),
    supabaseAdmin.from('alquiler_obra_maquinas').select('obra_id, maquina_id').eq('maquinista_user_id', userId),
  ])

  const jefeObraIds       = (jefeObras ?? []).map(o => o.id as number)
  const maquinistaObraIds = [...new Set((asigs ?? []).map(a => a.obra_id as number))]
  const maquinistaPairs   = new Set((asigs ?? []).map(a => `${a.obra_id}:${a.maquina_id}`))

  return { isAdmin: false, jefeObraIds, maquinistaObraIds, maquinistaPairs }
}

// Obras que el usuario puede VER (jefe ∪ maquinista).
function accessibleObraIds(scope: AlquilerScope): number[] {
  return [...new Set([...scope.jefeObraIds, ...scope.maquinistaObraIds])]
}

// ¿Puede VER esta fila? A nivel obra (maquinaId omitido) o (obra, máquina).
function canView(scope: AlquilerScope, obraId: number, maquinaId?: number): boolean {
  if (scope.isAdmin) return true
  if (scope.jefeObraIds.includes(obraId)) return true   // jefe ve toda su obra
  if (maquinaId == null) return scope.maquinistaObraIds.includes(obraId)
  return scope.maquinistaPairs.has(`${obraId}:${maquinaId}`)
}

// ¿Puede CARGAR/mutar esta (obra, máquina)? Solo el maquinista asignado (o admin).
// El jefe NO carga (además ya lo frena el gate de acción).
function canLoad(scope: AlquilerScope, obraId: number, maquinaId: number): boolean {
  if (scope.isAdmin) return true
  return scope.maquinistaPairs.has(`${obraId}:${maquinaId}`)
}

function forbidden(msg = 'No tenés acceso a este recurso de alquiler'): never {
  throw new HTTPException(403, { message: msg })
}

// La GESTIÓN de la flota, obras y asignaciones es admin-only. Motivo: el gate
// por método (`requirePermiso('alquiler','creacion')`) es a nivel módulo, así
// que un maquinista —que necesita `creacion` para cargar SUS partes— si no
// fuese por esto podría también crear máquinas/obras/asignaciones por API
// directa (defensa en profundidad, §5.4: la seguridad va en el backend).
// Si en el futuro hace falta un coordinador no-admin, se mueve a un flag de
// permisos (queda para el replanteo del sistema de permisos).
async function requireAdmin(userId: string): Promise<void> {
  const { data } = await supabaseAdmin.from('profiles').select('rol').eq('id', userId).single()
  if (data?.rol !== 'admin') {
    forbidden('Solo un administrador puede gestionar la flota y las obras de alquiler')
  }
}

export const alquilerService = {
  // ── Máquinas (catálogo de flota; admin-only) ──────────────────
  // El catálogo completo solo lo necesitan superficies de ABM (tab Máquinas
  // y el dropdown de asignación), que son admin. El maquinista/jefe NUNCA
  // pide este endpoint (usa getObraMaquinas, ya scopeado). Lo gateamos a
  // admin para no filtrar patentes/obs de toda la flota a un no-admin con
  // `lectura` (hallazgo M1 de la auditoría de seguridad).
  async getMaquinas(token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_maquinas')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createMaquina(dto: CreateMaquinaDto, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_maquinas')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMaquina(id: number, dto: UpdateMaquinaDto, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_maquinas')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMaquina(id: number, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_maquinas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Obras ─────────────────────────────────────────────────────
  // Listado SCOPEADO: el no-admin solo ve sus obras (como jefe o maquinista).
  async getObras(token: string, userId: string) {
    const scope = await getScope(userId)
    const supabase = createSupabaseClient(token)
    let q = supabase.from('alquiler_obras').select('*').order('nombre')
    if (!scope.isAdmin) {
      const ids = accessibleObraIds(scope)
      if (ids.length === 0) return []
      q = q.in('id', ids)
    }
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getObraById(id: number, token: string, userId: string) {
    const scope = await getScope(userId)
    if (!canView(scope, id)) forbidden('No tenés acceso a esta obra de alquiler')
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obras')
      .select('*, alquiler_obra_maquinas(*, alquiler_maquinas(*))')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async createObra(dto: CreateObraDto, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obras')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateObra(id: number, dto: UpdateObraDto, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obras')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteObra(id: number, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_obras').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Asignación máquina ↔ obra ─────────────────────────────────
  // SCOPEADA en lectura: el maquinista solo ve SUS máquinas de la obra; el
  // jefe (y admin) ven todas. Es la fuente del tab Partes.
  async getObraMaquinas(obraId: number, token: string, userId: string) {
    const scope = await getScope(userId)
    if (!canView(scope, obraId)) forbidden('No tenés acceso a esta obra de alquiler')
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obra_maquinas')
      .select('*, alquiler_maquinas(*)')
      .eq('obra_id', obraId)
      .order('id')
    if (error) throw new Error(error.message)
    // jefe/admin → todas; maquinista → solo las suyas.
    return (data ?? []).filter(om => canView(scope, obraId, om.maquina_id as number))
  },

  async createObraMaquina(obraId: number, dto: CreateObraMaquinaDto, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obra_maquinas')
      .insert({
        obra_id:            obraId,
        maquina_id:         dto.maquina_id,
        maquinista_user_id: dto.maquinista_user_id ?? null,
        created_by:         userId,
        updated_by:         userId,
      })
      .select('*, alquiler_maquinas(*)')
      .single()
    if (error) {
      // 23505 = unique_violation: la máquina ya está asignada a esta obra.
      if ((error as { code?: string }).code === '23505') {
        throw new Error('La máquina ya está asignada a esta obra')
      }
      throw new Error(error.message)
    }
    return data
  },

  async updateObraMaquina(id: number, dto: UpdateObraMaquinaDto, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_obra_maquinas')
      .update({ maquinista_user_id: dto.maquinista_user_id ?? null, updated_by: userId })
      .eq('id', id)
      .select('*, alquiler_maquinas(*)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteObraMaquina(id: number, token: string, userId: string) {
    await requireAdmin(userId)
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('alquiler_obra_maquinas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Partes ────────────────────────────────────────────────────
  async getPartes(query: ListPartesQuery, token: string, userId: string) {
    const scope = await getScope(userId)
    if (!canView(scope, query.obra_id)) forbidden('No tenés acceso a esta obra de alquiler')

    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('alquiler_partes')
      .select('*, alquiler_maquinas(*)')
      .eq('obra_id', query.obra_id)

    if (query.maquina_id != null) q = q.eq('maquina_id', query.maquina_id)
    if (query.desde) q = q.gte('fecha', query.desde)
    if (query.hasta) q = q.lte('fecha', query.hasta)

    const { data, error } = await q.order('fecha', { ascending: false })
    if (error) throw new Error(error.message)
    // maquinista → solo sus máquinas; jefe/admin → todas.
    return (data ?? []).filter(p => canView(scope, query.obra_id, p.maquina_id as number))
  },

  async createParte(dto: CreateParteDto, token: string, userId: string) {
    const scope = await getScope(userId)
    if (!canLoad(scope, dto.obra_id, dto.maquina_id)) {
      forbidden('Solo podés cargar partes de tus máquinas asignadas')
    }
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('alquiler_partes')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) {
      // 23505 = unique_violation: ya hay un parte para esa obra+máquina+fecha.
      if ((error as { code?: string }).code === '23505') {
        throw new Error('Ya existe un parte para esta máquina en esta obra y fecha')
      }
      throw new Error(error.message)
    }
    return data
  },

  async updateParte(id: number, dto: UpdateParteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // El (obra, máquina) del parte define el scope; lo leemos antes de mutar.
    const { data: parte, error: errGet } = await supabase
      .from('alquiler_partes')
      .select('obra_id, maquina_id')
      .eq('id', id)
      .single()
    if (errGet) throw new Error(errGet.message)
    const scope = await getScope(userId)
    if (!canLoad(scope, parte.obra_id as number, parte.maquina_id as number)) {
      forbidden('Solo podés editar partes de tus máquinas asignadas')
    }

    const { data, error } = await supabase
      .from('alquiler_partes')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteParte(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data: parte, error: errGet } = await supabase
      .from('alquiler_partes')
      .select('obra_id, maquina_id')
      .eq('id', id)
      .single()
    if (errGet) throw new Error(errGet.message)
    const scope = await getScope(userId)
    if (!canLoad(scope, parte.obra_id as number, parte.maquina_id as number)) {
      forbidden('Solo podés borrar partes de tus máquinas asignadas')
    }
    const { error } = await supabase.from('alquiler_partes').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Remitos (Fase 2) ──────────────────────────────────────────
  async emitirRemito(parteId: number, token: string, userId: string) {
    // Scope: solo el maquinista del parte (o admin) puede emitir su remito.
    const supabase = createSupabaseClient(token)
    const { data: parte, error: errGet } = await supabase
      .from('alquiler_partes')
      .select('obra_id, maquina_id')
      .eq('id', parteId)
      .single()
    if (errGet) throw new Error('No se encontró el parte para emitir el remito')
    const scope = await getScope(userId)
    if (!canLoad(scope, parte.obra_id as number, parte.maquina_id as number)) {
      forbidden('Solo podés emitir remitos de tus máquinas asignadas')
    }

    // §9: el RPC es SECURITY DEFINER → SIEMPRE con el cliente admin.
    const { data, error } = await supabaseAdmin.rpc('emitir_remito_alquiler', {
      p_parte_id: parteId,
      p_user_id:  userId,
    })
    if (error) {
      if (error.message?.includes('PARTE_NO_EXISTE')) {
        throw new Error('No se encontró el parte para emitir el remito')
      }
      throw new Error(error.message)
    }
    return data
  },

  async getRemitos(query: ListRemitosQuery, token: string, userId: string) {
    const scope = await getScope(userId)
    const supabase = createSupabaseClient(token)
    let q = supabase.from('alquiler_remitos').select('*')
    if (query.obra_id    != null) q = q.eq('obra_id', query.obra_id)
    if (query.maquina_id != null) q = q.eq('maquina_id', query.maquina_id)
    if (query.desde) q = q.gte('fecha_trabajo', query.desde)
    if (query.hasta) q = q.lte('fecha_trabajo', query.hasta)

    if (!scope.isAdmin) {
      const ids = accessibleObraIds(scope)
      if (ids.length === 0) return []
      q = q.in('obra_id', ids)
    }

    const { data, error } = await q
      .order('fecha_emision', { ascending: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    // maquinista → solo remitos de sus máquinas; jefe/admin → todos los de la obra.
    return (data ?? []).filter(r => canView(scope, r.obra_id as number, r.maquina_id as number))
  },

  async deleteRemito(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data: remito, error: errGet } = await supabase
      .from('alquiler_remitos')
      .select('obra_id, maquina_id')
      .eq('id', id)
      .single()
    if (errGet) throw new Error(errGet.message)
    const scope = await getScope(userId)
    if (!canLoad(scope, remito.obra_id as number, remito.maquina_id as number)) {
      forbidden('Solo podés anular remitos de tus máquinas asignadas')
    }
    const { error } = await supabase.from('alquiler_remitos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Reportes (Fase 3) ─────────────────────────────────────────
  // Horas por máquina en un período (scopeado). Agrega los partes por máquina:
  // total de horas + cantidad de días con carga.
  async getReporteHorasPorMaquina(query: ReporteHorasQuery, token: string, userId: string) {
    const scope = await getScope(userId)
    const supabase = createSupabaseClient(token)

    let q = supabase.from('alquiler_partes').select('obra_id, maquina_id, fecha, horas')
    if (query.obra_id != null) {
      if (!canView(scope, query.obra_id)) forbidden('No tenés acceso a esta obra de alquiler')
      q = q.eq('obra_id', query.obra_id)
    } else if (!scope.isAdmin) {
      const ids = accessibleObraIds(scope)
      if (ids.length === 0) return []
      q = q.in('obra_id', ids)
    }
    if (query.desde) q = q.gte('fecha', query.desde)
    if (query.hasta) q = q.lte('fecha', query.hasta)

    const { data, error } = await q
    if (error) throw new Error(error.message)

    const rows = (data ?? []).filter(p => canView(scope, p.obra_id as number, p.maquina_id as number))
    if (rows.length === 0) return []

    // Agregar por máquina.
    const agg = new Map<number, { maquina_id: number; total_horas: number; dias: Set<string> }>()
    for (const p of rows) {
      const mid = p.maquina_id as number
      const cur = agg.get(mid) ?? { maquina_id: mid, total_horas: 0, dias: new Set<string>() }
      cur.total_horas += Number(p.horas ?? 0)
      cur.dias.add(p.fecha as string)
      agg.set(mid, cur)
    }

    // Nombres/tipos de las máquinas involucradas.
    const maquinaIds = [...agg.keys()]
    const { data: maquinas, error: errMaq } = await supabase
      .from('alquiler_maquinas')
      .select('id, nombre, tipo')
      .in('id', maquinaIds)
    if (errMaq) throw new Error(errMaq.message)
    const maqMap = new Map((maquinas ?? []).map(m => [m.id as number, m]))

    return [...agg.values()]
      .map(a => ({
        maquina_id:     a.maquina_id,
        maquina_nombre: maqMap.get(a.maquina_id)?.nombre ?? null,
        maquina_tipo:   maqMap.get(a.maquina_id)?.tipo ?? null,
        total_horas:    Math.round(a.total_horas * 100) / 100,
        dias:           a.dias.size,
      }))
      .sort((x, y) => y.total_horas - x.total_horas)
  },
}
