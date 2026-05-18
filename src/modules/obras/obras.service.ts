import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, invalidarCacheObrasUsuario } from '../../lib/obras-usuario.js'
import type { CreateObraDto, UpdateObraDto } from './obras.schema.js'

// Valida que un user (si está seteado) exista, esté activo y tenga el
// rol_base esperado. Lanza error con mensaje claro si no.
async function validarResponsableObra(
  userIdNuevo: string | null | undefined,
  rolEsperado: 'capataz' | 'jefe_obra',
): Promise<void> {
  if (!userIdNuevo) return
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('rol, rol_base, activo')
    .eq('id', userIdNuevo)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Usuario responsable no existe')
  if (data.activo === false) throw new Error('El usuario responsable está inactivo')
  // Admin puede ser responsable también (no rompe nada, ve todo igual).
  // Solo rechazamos si rol_base está seteado y NO matchea.
  if (data.rol !== 'admin' && data.rol_base != null && data.rol_base !== rolEsperado) {
    throw new Error(`El usuario no tiene rol_base=${rolEsperado} (tiene ${data.rol_base})`)
  }
}

// Sincroniza usuario_obras cuando cambia el responsable de una obra.
// Inserta una row para el nuevo user (modulo=NULL → aplica a todos los
// módulos donde tenga scope='asignadas') y borra la del viejo si cambió.
// Idempotente: si el user ya tiene la obra asignada, no duplica.
//
// Permisos v3 (2026-05-18) eliminó la columna usuario_obras.modulo —
// las asignaciones son globales del par (user_id, obra_cod).
async function syncUsuarioObrasResponsable(
  obraCod: string,
  userIdAnterior: string | null | undefined,
  userIdNuevo: string | null | undefined,
  callerId: string,
): Promise<void> {
  if (userIdAnterior === userIdNuevo) return

  // 1) Si había uno anterior y cambió/se quitó, borrar su asignación.
  if (userIdAnterior) {
    const { error: errDel } = await supabaseAdmin
      .from('usuario_obras')
      .delete()
      .eq('user_id', userIdAnterior)
      .eq('obra_cod', obraCod)
    if (errDel) throw new Error(errDel.message)
    invalidarCacheObrasUsuario(userIdAnterior)
  }

  // 2) Si hay uno nuevo, upsert (idempotente vs constraint user_id+obra_cod).
  if (userIdNuevo) {
    const { error: errIns } = await supabaseAdmin
      .from('usuario_obras')
      .upsert(
        { user_id: userIdNuevo, obra_cod: obraCod, created_by: callerId },
        { onConflict: 'user_id,obra_cod' },
      )
    if (errIns) throw new Error(errIns.message)
    invalidarCacheObrasUsuario(userIdNuevo)
  }
}

export const obrasService = {

  async getAll(token: string, userId: string, modulo?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('obras')
      .select('*')
      .eq('archivada', false)
      .order('created_at')

    // Filtrar por obras del usuario si NO es admin.
    // null = admin sin restricción. Array vacío = ve cero obras.
    // El parámetro `modulo` permite respetar el override por módulo
    // (ej: Cristian tiene scope global='todas' pero override en
    // tarja='asignadas' a la obra depósito). Si no se pasa, usa el
    // scope global.
    const allowed = await getObrasDelUsuarioCached(userId, modulo)
    if (allowed != null) {
      if (allowed.length === 0) return []
      q = q.in('cod', allowed)
    }

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getArchivadas(token: string, userId: string, modulo?: string) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('obras')
      .select('*')
      .eq('archivada', true)
      .order('fecha_archivo', { ascending: false })

    const allowed = await getObrasDelUsuarioCached(userId, modulo)
    if (allowed != null) {
      if (allowed.length === 0) return []
      q = q.in('cod', allowed)
    }

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  async getByCod(cod: string, token: string, userId: string, modulo?: string) {
    // Validar acceso del usuario a esta obra antes de devolverla.
    const allowed = await getObrasDelUsuarioCached(userId, modulo)
    if (allowed != null && !allowed.includes(cod)) {
      const e: Error & { code?: string } = new Error('OBRA_SIN_ACCESO')
      e.code = 'OBRA_SIN_ACCESO'
      throw e
    }
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .select('*')
      .eq('cod', cod)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async proximoCodigoPreview(): Promise<string> {
    // Devuelve el próximo código SIN consumir la sequence — para preview
    // en el modal "Nueva obra". El insert real va a llamar a
    // siguiente_codigo_obra() (que sí consume), garantizando unicidad
    // bajo concurrencia.
    const { data, error } = await supabaseAdmin.rpc('proximo_codigo_obra_preview')
    if (error) throw new Error(error.message)
    return data as unknown as string
  },

  async create(dto: CreateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Validar responsables ANTES de generar el código para que un error
    // de validación no consuma un número de la sequence.
    await validarResponsableObra(dto.capataz_user_id,   'capataz')
    await validarResponsableObra(dto.jefe_obra_user_id, 'jefe_obra')

    // Generar código atómicamente. Ignoramos cualquier `dto.cod` que el
    // cliente haya mandado — el código es server-only para evitar
    // duplicados, typos y formats inconsistentes (cc 24, CC-001, etc.).
    const { data: cod, error: errCod } = await supabaseAdmin.rpc('siguiente_codigo_obra')
    if (errCod) throw new Error(errCod.message)
    const codFinal = cod as unknown as string

    const { data, error } = await supabase
      .from('obras')
      .insert({
        cod: codFinal,
        nom: dto.nom,
        cc: dto.cc,
        dir: dto.dir,
        resp: dto.resp,
        obs: dto.obs,
        capataz_user_id:   dto.capataz_user_id   ?? null,
        jefe_obra_user_id: dto.jefe_obra_user_id ?? null,
        archivada: false,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Sincronizar usuario_obras para los responsables recién seteados.
    // No hay "anterior" en create, pasamos null.
    await syncUsuarioObrasResponsable(codFinal, null, dto.capataz_user_id,   userId)
    await syncUsuarioObrasResponsable(codFinal, null, dto.jefe_obra_user_id, userId)

    return data
  },

  async update(cod: string, dto: UpdateObraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // Validar nuevos responsables (si vienen en el patch).
    if (dto.capataz_user_id !== undefined) {
      await validarResponsableObra(dto.capataz_user_id, 'capataz')
    }
    if (dto.jefe_obra_user_id !== undefined) {
      await validarResponsableObra(dto.jefe_obra_user_id, 'jefe_obra')
    }

    // Snapshot previo de los user_ids para saber qué cambió y poder
    // borrar las asignaciones del viejo responsable si fue reemplazado.
    let beforeCapataz: string | null = null
    let beforeJefe:    string | null = null
    if (dto.capataz_user_id !== undefined || dto.jefe_obra_user_id !== undefined) {
      const { data: before } = await supabaseAdmin
        .from('obras')
        .select('capataz_user_id, jefe_obra_user_id')
        .eq('cod', cod)
        .maybeSingle()
      beforeCapataz = before?.capataz_user_id ?? null
      beforeJefe    = before?.jefe_obra_user_id ?? null
    }

    const { data, error } = await supabase
      .from('obras')
      .update({ ...dto, updated_by: userId })
      .eq('cod', cod)
      .select()
      .single()

    if (error) throw new Error(error.message)

    // Sincronizar usuario_obras para los responsables que cambiaron.
    if (dto.capataz_user_id !== undefined) {
      await syncUsuarioObrasResponsable(cod, beforeCapataz, dto.capataz_user_id, userId)
    }
    if (dto.jefe_obra_user_id !== undefined) {
      await syncUsuarioObrasResponsable(cod, beforeJefe, dto.jefe_obra_user_id, userId)
    }

    return data
  },

  async archivar(cod: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({
        archivada: true,
        fecha_archivo: new Date().toISOString().slice(0, 10),
        updated_by: userId,
      })
      .eq('cod', cod)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async desarchivar(cod: string, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('obras')
      .update({ archivada: false, fecha_archivo: null, updated_by: userId })
      .eq('cod', cod)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Auto-archiva obras sin actividad en los últimos N días.
  //
  // Implementación vía RPC `obras_a_auto_archivar` (ver migración
  // 20260430): el cálculo corre del lado del servidor con NOT EXISTS
  // contra los índices de horas/certificaciones, así no depende del cap
  // de filas de PostgREST (~1000) que en la implementación anterior
  // generaba falsos "sin actividad" → obras archivadas por error.
  async autoArchivar(_token: string, userId: string) {
    const { data: candidatas, error: errRpc } = await supabaseAdmin
      .rpc('obras_a_auto_archivar', { p_dias_atras: 21 })
    if (errRpc) throw new Error(errRpc.message)

    const cods = (candidatas ?? []).map((r: { cod: string }) => r.cod)
    if (cods.length === 0) return { archivadas: [] }

    const hoy = new Date().toISOString().slice(0, 10)
    const { error: errUpd } = await supabaseAdmin
      .from('obras')
      .update({ archivada: true, fecha_archivo: hoy, updated_by: userId })
      .in('cod', cods)
    if (errUpd) throw new Error(errUpd.message)

    return { archivadas: cods }
  },

  async delete(cod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('obras')
      .delete()
      .eq('cod', cod)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
