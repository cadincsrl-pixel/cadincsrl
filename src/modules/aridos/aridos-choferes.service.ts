/**
 * Choferes de Áridos: padrón propio, jornal versionado y días trabajados.
 *
 * Áridos se maneja como un brazo aparte de CADINC, así que NO reusa el padrón
 * de tarja (`personal`, con legajo y semana viernes-jueves) ni el de logística
 * (`choferes`, con modalidad km/porcentaje y liquidaciones). Ver la migración
 * `20260908f` para el porqué.
 *
 * Cobran POR DÍA TRABAJADO: paga del mes = días cargados × jornal vigente.
 */
import { createSupabaseClient } from '../../lib/supabase.js'

export class ChoferAridosError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'ChoferAridosError'
  }
}

export interface CreateChoferDto {
  nombre: string
  dni?:   string | null
  tel?:   string | null
  obs?:   string | null
  /** Jornal inicial. Si viene, se crea la primera versión junto con el chofer. */
  jornal?:        number | null
  jornal_desde?:  string | null
}

export const choferesAridosService = {

  /** Los choferes con su jornal VIGENTE HOY, para las listas y los selects. */
  async listar(token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('aridos_choferes')
      .select('*, aridos_chofer_jornales(jornal, vigente_desde)')
      .order('nombre')
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)

    const hoy = new Date().toISOString().slice(0, 10)
    return (data ?? []).map((c: any) => {
      // El jornal vigente es la versión más reciente que ya empezó a regir.
      const versiones = (c.aridos_chofer_jornales ?? [])
        .filter((j: any) => j.vigente_desde <= hoy)
        .sort((a: any, b: any) => (a.vigente_desde < b.vigente_desde ? 1 : -1))
      const { aridos_chofer_jornales, ...resto } = c
      return {
        ...resto,
        jornal_vigente: versiones[0]?.jornal ?? null,
        jornal_desde:   versiones[0]?.vigente_desde ?? null,
        versiones_jornal: (aridos_chofer_jornales ?? []).length,
      }
    })
  },

  async crear(dto: CreateChoferDto, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const nombre = dto.nombre.trim()
    if (!nombre) throw new ChoferAridosError(400, 'NOMBRE_REQUERIDO')

    const { data, error } = await sb
      .from('aridos_choferes')
      .insert({
        nombre, dni: dto.dni ?? null, tel: dto.tel ?? null, obs: dto.obs ?? null,
        created_by: userId, updated_by: userId,
      })
      .select()
      .single()
    if (error) {
      if (error.code === '23505' || /unique/i.test(error.message)) {
        throw new ChoferAridosError(409, 'CHOFER_DUPLICADO', { nombre })
      }
      throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    }

    if (dto.jornal != null) {
      await this.setJornal(data.id, { jornal: dto.jornal, vigente_desde: dto.jornal_desde ?? new Date().toISOString().slice(0, 10) }, userId, token)
    }
    return data
  },

  async editar(id: number, dto: Partial<CreateChoferDto> & { activo?: boolean }, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const patch: Record<string, unknown> = { updated_by: userId }
    for (const k of ['nombre', 'dni', 'tel', 'obs', 'activo'] as const) {
      if (dto[k as keyof typeof dto] !== undefined) patch[k] = dto[k as keyof typeof dto]
    }
    const { data, error } = await sb
      .from('aridos_choferes').update(patch).eq('id', id).select().maybeSingle()
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    if (!data) throw new ChoferAridosError(404, 'CHOFER_NO_EXISTE')
    return data
  },

  /**
   * Cambiar el jornal INSERTA una versión nueva, nunca pisa la anterior.
   * Pisarla recalcularía meses ya pagados — es el incidente del 2026-06-26 con
   * el valor hora global, que hubo que reconstruir desde un Excel.
   * Si ya existe una versión con esa misma fecha, esa sí se corrige (es una
   * carga del mismo día, no historia).
   */
  async setJornal(
    choferId: number,
    dto: { jornal: number; vigente_desde: string; obs?: string | null },
    userId: string, token: string,
  ) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('aridos_chofer_jornales')
      .upsert({
        chofer_id: choferId, jornal: dto.jornal, vigente_desde: dto.vigente_desde,
        obs: dto.obs ?? null, created_by: userId, updated_by: userId,
      }, { onConflict: 'chofer_id,vigente_desde' })
      .select()
      .single()
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    return data
  },

  async jornales(choferId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('aridos_chofer_jornales').select('*')
      .eq('chofer_id', choferId)
      .order('vigente_desde', { ascending: false })
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    return data
  },

  // ── Días trabajados ─────────────────────────────────────────────────

  async dias(token: string, desde?: string, hasta?: string, choferId?: number) {
    const sb = createSupabaseClient(token)
    let q = sb
      .from('aridos_chofer_dias')
      .select('*, aridos_choferes(nombre), aridos_unidades(nombre, patente)')
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
    if (desde)    q = q.gte('fecha', desde)
    if (hasta)    q = q.lte('fecha', hasta)
    if (choferId) q = q.eq('chofer_id', choferId)
    const { data, error } = await q
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    return data
  },

  /**
   * Marca un día como trabajado. El jornal se CONGELA en la fila: si mañana
   * sube, los meses cerrados no se mueven.
   */
  async marcarDia(
    dto: { chofer_id: number; fecha: string; unidad_id?: number | null; obs?: string | null },
    userId: string, token: string,
  ) {
    const sb = createSupabaseClient(token)

    const { data: vig } = await sb
      .from('aridos_chofer_jornales')
      .select('jornal')
      .eq('chofer_id', dto.chofer_id)
      .lte('vigente_desde', dto.fecha)
      .order('vigente_desde', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data, error } = await sb
      .from('aridos_chofer_dias')
      .insert({
        chofer_id: dto.chofer_id, fecha: dto.fecha,
        unidad_id: dto.unidad_id ?? null,
        // null a propósito si el chofer todavía no tiene jornal: el día se
        // registra igual y la vista lo cuenta en `dias_sin_jornal`. Esconder
        // el día sería peor que mostrarlo incompleto.
        jornal_aplicado: vig?.jornal ?? null,
        obs: dto.obs ?? null,
        created_by: userId, updated_by: userId,
      })
      .select('*, aridos_choferes(nombre), aridos_unidades(nombre, patente)')
      .single()
    if (error) {
      if (error.code === '23505' || /unique/i.test(error.message)) {
        throw new ChoferAridosError(409, 'DIA_YA_CARGADO', { fecha: dto.fecha })
      }
      throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    }
    return data
  },

  async borrarDia(id: number, userId: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('aridos_chofer_dias')
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id).is('deleted_at', null)
      .select('id').maybeSingle()
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    if (!data) throw new ChoferAridosError(404, 'DIA_NO_EXISTE')
    return { success: true, id: data.id }
  },

  /** Lo que hay que pagarle a cada chofer en un mes. */
  async pagoMes(mes: string, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb
      .from('v_aridos_chofer_pago_mes').select('*')
      .eq('mes', `${mes}-01`)
      .order('chofer')
    if (error) throw new ChoferAridosError(500, 'DB_ERROR', error.message)
    return data
  },
}
