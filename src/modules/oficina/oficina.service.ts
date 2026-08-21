import { supabase } from '../../lib/supabase.js'
import type {
  CreatePersonaDto,
  UpdatePersonaDto,
  CreateSueldoDto,
  PutAsignacionesDto,
  AplicarAumentoDto,
} from './oficina.schema.js'

// Las tablas oficina_* tienen RLS SIN policy para `authenticated` (sueldos =
// dato sensible, migración 20260821b): solo el service_role las lee/escribe.
// Por eso este service usa el cliente admin `supabase` y NO el per-request
// (que resuelve rol `authenticated` por el JWT — ver §9 de CLAUDE.md). El
// control de acceso corre ANTES, en el middleware requireFlag del router.

type AsignacionRow = {
  persona_id: number
  desde: string
  destino: 'obra' | 'logistica' | 'general'
  obra_cod: string | null
  porcentaje: number
}

function throwCoded(code: string): never {
  const e = new Error(code) as Error & { code?: string }
  e.code = code
  throw e
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Último día del mes 'YYYY-MM' como 'YYYY-MM-DD'. */
function finDeMes(mes: string): string {
  const y = Number(mes.slice(0, 4))
  const m = Number(mes.slice(5, 7))
  // Date.UTC(y, m, 0) = día 0 del mes índice m = último día del mes m (1-based).
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

const round2 = (n: number) => Math.round(n * 100) / 100

async function assertPersonaExiste(personaId: number) {
  const { data, error } = await supabase
    .from('oficina_personal')
    .select('id, activo')
    .eq('id', personaId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throwCoded('PERSONA_NO_EXISTE')
  return data as { id: number; activo: boolean }
}

async function upsertSueldoRow(personaId: number, costoMensual: number, desde: string, userId: string) {
  const { data, error } = await supabase
    .from('oficina_sueldos')
    .upsert(
      {
        persona_id: personaId,
        costo_mensual: costoMensual,
        desde,
        created_by: userId,
        updated_by: userId,
      },
      { onConflict: 'persona_id,desde' },
    )
    .select('id, costo_mensual, desde')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export const oficinaService = {

  async getPersonas() {
    const { data, error } = await supabase
      .from('oficina_personal')
      .select('*, sueldos:oficina_sueldos ( id, costo_mensual, desde )')
      .order('nombre')
      .order('desde', { referencedTable: 'oficina_sueldos', ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createPersona(dto: CreatePersonaDto, userId: string) {
    const { data: persona, error } = await supabase
      .from('oficina_personal')
      .insert({ nombre: dto.nombre, activo: true, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Primera versión del sueldo (versionado por desde, estilo categoria_tarifas).
    const sueldo = await upsertSueldoRow(persona.id, dto.costo_mensual, dto.desde ?? hoyISO(), userId)
    return { ...persona, sueldos: [sueldo] }
  },

  async updatePersona(id: number, dto: UpdatePersonaDto, userId: string) {
    const previa = await assertPersonaExiste(id)

    const patch: Record<string, unknown> = { updated_by: userId }
    if (dto.nombre !== undefined) patch.nombre = dto.nombre
    if (dto.activo !== undefined) patch.activo = dto.activo

    const { data, error } = await supabase
      .from('oficina_personal')
      .update(patch)
      .eq('id', id)
      .select('*, sueldos:oficina_sueldos ( id, costo_mensual, desde )')
      .single()
    if (error) throw new Error(error.message)

    // Baja = cerrar el sueldo con una versión $0 desde hoy: los meses pasados
    // conservan su costo (el resumen NO filtra por activo, sería reescribir
    // historia) y los meses nuevos computan cero. Reactivar requiere cargar
    // una versión nueva de sueldo.
    if (previa.activo && dto.activo === false) {
      await upsertSueldoRow(id, 0, hoyISO(), userId)
    }

    return data
  },

  // Upsert por (persona_id, desde): re-editar el mismo desde pisa ESA versión;
  // las versiones anteriores nunca se tocan.
  async upsertSueldo(personaId: number, dto: CreateSueldoDto, userId: string) {
    await assertPersonaExiste(personaId)
    return upsertSueldoRow(personaId, dto.costo_mensual, dto.desde, userId)
  },

  // Historial completo agrupado por desde (snapshot = distribución completa
  // vigente desde esa fecha). Más reciente primero.
  async getAsignaciones(personaId: number) {
    await assertPersonaExiste(personaId)

    const { data, error } = await supabase
      .from('oficina_asignaciones')
      .select('desde, destino, obra_cod, porcentaje')
      .eq('persona_id', personaId)
      .order('desde', { ascending: false })
      .order('destino')
    if (error) throw new Error(error.message)

    const byDesde = new Map<string, Array<{ destino: string; obra_cod: string | null; porcentaje: number }>>()
    for (const row of data ?? []) {
      const items = byDesde.get(row.desde) ?? []
      items.push({ destino: row.destino, obra_cod: row.obra_cod, porcentaje: Number(row.porcentaje) })
      byDesde.set(row.desde, items)
    }
    return [...byDesde.entries()].map(([desde, items]) => ({ desde, items }))
  },

  // Crea/reemplaza el snapshot de (persona_id, desde): delete + insert.
  async putAsignaciones(personaId: number, dto: PutAsignacionesDto, userId: string) {
    await assertPersonaExiste(personaId)

    // Backstop de las validaciones del schema (el schema ya las corre, pero
    // el service no confía en el caller).
    const suma = dto.items.reduce((s, i) => s + i.porcentaje, 0)
    if (Math.abs(suma - 100) > 0.01) throwCoded('SUMA_NO_100')

    const seen = new Set<string>()
    for (const it of dto.items) {
      const tieneObra = it.obra_cod != null && it.obra_cod !== ''
      if ((it.destino === 'obra') !== tieneObra) throwCoded('OBRA_COD_REQUERIDO')
      const key = `${it.destino}|${tieneObra ? it.obra_cod : ''}`
      if (seen.has(key)) throwCoded('DESTINO_DUPLICADO')
      seen.add(key)
    }

    // Existencia de obras destino (esta sí necesita DB).
    const obraCods = [...new Set(
      dto.items.filter((i) => i.destino === 'obra').map((i) => i.obra_cod as string),
    )]
    if (obraCods.length > 0) {
      const { data: obras, error: obrasError } = await supabase
        .from('obras')
        .select('cod')
        .in('cod', obraCods)
      if (obrasError) throw new Error(obrasError.message)
      const encontradas = new Set((obras ?? []).map((o) => o.cod))
      if (obraCods.some((c) => !encontradas.has(c))) throwCoded('OBRA_NO_EXISTE')
    }

    const { error: delError } = await supabase
      .from('oficina_asignaciones')
      .delete()
      .eq('persona_id', personaId)
      .eq('desde', dto.desde)
    if (delError) throw new Error(delError.message)

    const { data, error: insError } = await supabase
      .from('oficina_asignaciones')
      .insert(dto.items.map((i) => ({
        persona_id: personaId,
        desde: dto.desde,
        destino: i.destino,
        obra_cod: i.destino === 'obra' ? i.obra_cod : null,
        porcentaje: i.porcentaje,
        created_by: userId,
      })))
      .select('destino, obra_cod, porcentaje')
    if (insError) throw new Error(insError.message)

    return { persona_id: personaId, desde: dto.desde, items: data }
  },

  // Aumento masivo: una versión nueva de sueldo por persona, calculada sobre
  // la versión vigente ANTERIOR a `desde` (estrictamente <, así re-aplicar el
  // mismo aumento con el mismo desde pisa la versión creada en vez de
  // componer % sobre %). El % puede diferir por persona; negativo = rebaja.
  async aplicarAumento(dto: AplicarAumentoDto, userId: string) {
    const ids = dto.items.map((i) => i.persona_id)
    if (new Set(ids).size !== ids.length) throwCoded('PERSONA_DUPLICADA')

    const { data: personas, error } = await supabase
      .from('oficina_personal')
      .select('id, nombre, sueldos:oficina_sueldos ( costo_mensual, desde )')
      .in('id', ids)
    if (error) throw new Error(error.message)
    if ((personas ?? []).length !== ids.length) throwCoded('PERSONA_NO_EXISTE')

    const sinBase: number[] = []
    const nuevos = (personas ?? []).map((p) => {
      const item = dto.items.find((i) => i.persona_id === p.id)!
      const sueldos = (p.sueldos ?? []) as Array<{ costo_mensual: number; desde: string }>
      const base = sueldos
        .filter((s) => s.desde < dto.desde)
        .sort((a, b) => b.desde.localeCompare(a.desde))[0]
      if (!base) {
        sinBase.push(p.id)
        return null
      }
      const anterior = Number(base.costo_mensual)
      return {
        persona_id: p.id,
        nombre:     p.nombre,
        anterior,
        porcentaje: item.porcentaje,
        nuevo:      round2(anterior * (1 + item.porcentaje / 100)),
      }
    })
    if (sinBase.length > 0) {
      const e = new Error('SIN_SUELDO_BASE') as Error & { code?: string; detail?: number[] }
      e.code = 'SIN_SUELDO_BASE'
      e.detail = sinBase
      throw e
    }

    const filas = nuevos.filter((n): n is NonNullable<typeof n> => n !== null)
    const { error: upError } = await supabase
      .from('oficina_sueldos')
      .upsert(
        filas.map((n) => ({
          persona_id:    n.persona_id,
          costo_mensual: n.nuevo,
          desde:         dto.desde,
          created_by:    userId,
          updated_by:    userId,
        })),
        { onConflict: 'persona_id,desde' },
      )
    if (upError) throw new Error(upError.message)

    return { desde: dto.desde, items: filas }
  },

  // Resumen mensual: sueldo y snapshot vigentes al ÚLTIMO día del mes
  // (mayor `desde` <= fin de mes). NO filtra por activo — la baja se modela
  // con la versión de sueldo $0 (ver updatePersona), así los meses pasados
  // no cambian. Una persona con sueldo pero sin snapshot computa 100% a
  // `general`.
  async getResumen(mes: string) {
    const finMes = finDeMes(mes)

    const { data: personas, error } = await supabase
      .from('oficina_personal')
      .select('id, nombre, activo, sueldos:oficina_sueldos ( costo_mensual, desde )')
      .order('nombre')
    if (error) throw new Error(error.message)

    const ids = (personas ?? []).map((p) => p.id)
    let asignaciones: AsignacionRow[] = []
    if (ids.length > 0) {
      const { data: asigData, error: asigError } = await supabase
        .from('oficina_asignaciones')
        .select('persona_id, desde, destino, obra_cod, porcentaje')
        .in('persona_id', ids)
        .lte('desde', finMes)
      if (asigError) throw new Error(asigError.message)
      asignaciones = (asigData ?? []) as AsignacionRow[]
    }

    const porObraMap = new Map<string, number>()
    let logistica = 0
    let general = 0

    const personasOut = (personas ?? []).map((p) => {
      const sueldos = (p.sueldos ?? []) as Array<{ costo_mensual: number; desde: string }>
      const vigente = sueldos
        .filter((s) => s.desde <= finMes)
        .sort((a, b) => b.desde.localeCompare(a.desde))[0]
      const costoMensual = Number(vigente?.costo_mensual ?? 0)

      const propias = asignaciones.filter((a) => a.persona_id === p.id)
      const snapshotDesde = propias.reduce<string | null>(
        (max, a) => (max === null || a.desde > max ? a.desde : max),
        null,
      )
      const items = snapshotDesde ? propias.filter((a) => a.desde === snapshotDesde) : []

      const itemsOut = items.map((a) => {
        const porcentaje = Number(a.porcentaje)
        const monto = round2(costoMensual * porcentaje / 100)
        if (a.destino === 'obra' && a.obra_cod) {
          porObraMap.set(a.obra_cod, (porObraMap.get(a.obra_cod) ?? 0) + monto)
        } else if (a.destino === 'logistica') {
          logistica += monto
        } else if (a.destino === 'general') {
          general += monto
        }
        return { destino: a.destino, obra_cod: a.obra_cod, porcentaje, monto }
      })

      // Sin snapshot de asignaciones → el costo completo va a general.
      if (!snapshotDesde && costoMensual > 0) general += costoMensual

      return {
        id: p.id,
        nombre: p.nombre,
        activo: p.activo,
        costo_mensual: costoMensual,
        snapshot_desde: snapshotDesde,
        asignaciones: itemsOut,
      }
    })
      // Sin costo ni asignaciones en el mes (ej: baja vieja ya en $0, o alta
      // posterior al mes consultado) → fuera del resumen, es puro ruido.
      .filter((p) => p.costo_mensual > 0 || p.asignaciones.length > 0)

    const porObra = [...porObraMap.entries()]
      .map(([obra_cod, monto]) => ({ obra_cod, monto: round2(monto) }))
      .sort((a, b) => a.obra_cod.localeCompare(b.obra_cod))
    logistica = round2(logistica)
    general = round2(general)
    const totalOficina = round2(
      porObra.reduce((s, o) => s + o.monto, 0) + logistica + general,
    )

    return { mes, personas: personasOut, porObra, logistica, general, totalOficina }
  },
}
