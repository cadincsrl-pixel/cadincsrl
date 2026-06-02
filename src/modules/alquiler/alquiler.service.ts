import { createHash, randomUUID } from 'node:crypto'
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
  SeguroUploadUrlDto,
  SeguroRegistrarDto,
} from './alquiler.schema.js'

// ── Storage de la póliza de seguro (bucket privado alquiler-docs) ──
const SEGURO_BUCKET = 'alquiler-docs'
const SEGURO_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
])
const SEGURO_MAX_BYTES = 10 * 1024 * 1024
function seguroExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}
async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

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

  // ── Póliza de seguro (archivo adjunto, admin-only) ────────────
  // Flujo de 2 pasos (calcado de vehiculo-docs): pedir signed upload URL →
  // el cliente sube el archivo al bucket → registrar el storage_path.
  async seguroUploadUrl(maquinaId: number, dto: SeguroUploadUrlDto, userId: string) {
    await requireAdmin(userId)
    if (!SEGURO_ALLOWED_MIME.has(dto.mime_type)) {
      throw new HTTPException(400, { message: 'Tipo de archivo no permitido (foto o PDF)' })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > SEGURO_MAX_BYTES) {
      throw new HTTPException(400, { message: 'Archivo demasiado grande (máx 10 MB)' })
    }
    const ext  = seguroExtFromMime(dto.mime_type)
    const path = `maquina/${maquinaId}/${randomUUID()}.${ext}`
    const { data, error } = await supabaseAdmin.storage.from(SEGURO_BUCKET).createSignedUploadUrl(path)
    if (error) throw new HTTPException(500, { message: error.message })
    return { path, token: data.token, signed_url: data.signedUrl }
  },

  async seguroRegistrar(maquinaId: number, dto: SeguroRegistrarDto, userId: string, token: string) {
    await requireAdmin(userId)
    // Verificar que el archivo realmente se subió y que el path es de esta máquina.
    if (!dto.storage_path.startsWith(`maquina/${maquinaId}/`)) {
      throw new HTTPException(400, { message: 'Path inválido' })
    }
    const dl = await supabaseAdmin.storage.from(SEGURO_BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new HTTPException(400, { message: 'El archivo no se subió correctamente' })
    }
    const hash = await sha256OfBlob(dl.data)

    const sb = createSupabaseClient(token)
    // Path de la póliza anterior (para borrar el archivo viejo del bucket).
    const { data: prev } = await sb
      .from('alquiler_maquinas').select('seguro_poliza_path').eq('id', maquinaId).single()

    const { data, error } = await sb
      .from('alquiler_maquinas')
      .update({
        seguro_poliza_path:   dto.storage_path,
        seguro_poliza_nombre: dto.nombre_archivo,
        seguro_poliza_mime:   dto.mime_type,
        seguro_poliza_size:   dl.data.size,
        seguro_poliza_hash:   hash,
        updated_by:           userId,
      })
      .eq('id', maquinaId)
      .select()
      .single()
    if (error) throw new HTTPException(500, { message: error.message })

    // Limpiar el archivo anterior si cambió (best-effort).
    const prevPath = (prev as { seguro_poliza_path?: string | null } | null)?.seguro_poliza_path
    if (prevPath && prevPath !== dto.storage_path) {
      await supabaseAdmin.storage.from(SEGURO_BUCKET).remove([prevPath]).catch(() => undefined)
    }
    return data
  },

  async seguroSignedUrl(maquinaId: number, token: string, userId: string) {
    await requireAdmin(userId)
    const sb = createSupabaseClient(token)
    const { data: maq, error } = await sb
      .from('alquiler_maquinas')
      .select('seguro_poliza_path, seguro_poliza_nombre')
      .eq('id', maquinaId)
      .single()
    if (error) throw new HTTPException(500, { message: error.message })
    if (!maq?.seguro_poliza_path) {
      throw new HTTPException(404, { message: 'La máquina no tiene póliza adjunta' })
    }
    const { data, error: sErr } = await supabaseAdmin.storage
      .from(SEGURO_BUCKET)
      .createSignedUrl(maq.seguro_poliza_path, 900, { download: maq.seguro_poliza_nombre ?? undefined })
    if (sErr) throw new HTTPException(500, { message: sErr.message })
    return { url: data.signedUrl, nombre_archivo: maq.seguro_poliza_nombre }
  },

  async seguroDelete(maquinaId: number, token: string, userId: string) {
    await requireAdmin(userId)
    const sb = createSupabaseClient(token)
    const { data: maq } = await sb
      .from('alquiler_maquinas').select('seguro_poliza_path').eq('id', maquinaId).single()

    const { data, error } = await sb
      .from('alquiler_maquinas')
      .update({
        seguro_poliza_path:   null,
        seguro_poliza_nombre: null,
        seguro_poliza_mime:   null,
        seguro_poliza_size:   null,
        seguro_poliza_hash:   null,
        updated_by:           userId,
      })
      .eq('id', maquinaId)
      .select()
      .single()
    if (error) throw new HTTPException(500, { message: error.message })

    const prevPath = (maq as { seguro_poliza_path?: string | null } | null)?.seguro_poliza_path
    if (prevPath) {
      await supabaseAdmin.storage.from(SEGURO_BUCKET).remove([prevPath]).catch(() => undefined)
    }
    return data
  },

  // ── Notificaciones: seguros de máquinas vencidos / por vencer ──
  // Devuelve las máquinas con `seguro_vence` cargado (scopeado por identidad);
  // el frontend clasifica vencido / por-vencer. La campana lo muestra SOLO en
  // el módulo Alquiler.
  async getSegurosVencimientos(token: string, userId: string) {
    const scope = await getScope(userId)
    const sb = createSupabaseClient(token)
    let q = sb
      .from('alquiler_maquinas')
      .select('id, nombre, identificacion, seguro, seguro_vence')
      .not('seguro_vence', 'is', null)

    if (!scope.isAdmin) {
      const obraIds = accessibleObraIds(scope)
      if (obraIds.length === 0) return []
      // máquinas asignadas en las obras accesibles del usuario
      const { data: asigs } = await supabaseAdmin
        .from('alquiler_obra_maquinas').select('maquina_id').in('obra_id', obraIds)
      const maquinaIds = [...new Set((asigs ?? []).map(a => a.maquina_id as number))]
      if (maquinaIds.length === 0) return []
      q = q.in('id', maquinaIds)
    }

    const { data, error } = await q.order('seguro_vence', { ascending: true })
    if (error) throw new Error(error.message)
    return data
  },
}
