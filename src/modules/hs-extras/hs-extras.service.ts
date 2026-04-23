import { HTTPException } from 'hono/http-exception'
import { createSupabaseClient } from '../../lib/supabase.js'
import type { UpsertHsExtraDto, UpsertHsExtrasLoteDto } from './hs-extras.schema.js'

type SupabaseClient = ReturnType<typeof createSupabaseClient>

// Verifica si una (obra_cod, sem_key) está cerrada. Si lo está, lanza 409.
// Devuelve silenciosamente si no hay fila de cierre o si está 'pendiente'.
async function ensureSemanaAbierta(
  supabase: SupabaseClient,
  obraCod: string,
  semKey: string,
) {
  const { data, error } = await supabase
    .from('cierres')
    .select('estado')
    .eq('obra_cod', obraCod)
    .eq('sem_key', semKey)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (data?.estado === 'cerrado') {
    throw new HTTPException(409, {
      message: 'Semana cerrada, no se puede modificar horas extras',
    })
  }
}

// Verifica cierre de múltiples (obra_cod, sem_key). Si alguno está cerrado, lanza 409.
async function ensureSemanasAbiertas(
  supabase: SupabaseClient,
  obraCod: string,
  semKeys: string[],
) {
  if (semKeys.length === 0) return
  const unicos = Array.from(new Set(semKeys))
  const { data, error } = await supabase
    .from('cierres')
    .select('sem_key, estado')
    .eq('obra_cod', obraCod)
    .in('sem_key', unicos)

  if (error) throw new Error(error.message)
  const cerrado = data?.find((r) => r.estado === 'cerrado')
  if (cerrado) {
    throw new HTTPException(409, {
      message: 'Semana cerrada, no se puede modificar horas extras',
    })
  }
}

async function fetchById(supabase: SupabaseClient, id: number) {
  const { data, error } = await supabase
    .from('tarja_hs_extras')
    .select('obra_cod, sem_key')
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

export const hsExtrasService = {

  // GET /all — todas las hs extras (sin filtro), para vistas globales (recibos, export)
  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarja_hs_extras')
      .select('*')
      .order('sem_key')
    if (error) throw new Error(error.message)
    return data ?? []
  },

  // GET /:obra_cod?desde&hasta
  async getByObra(
    obraCod: string,
    desde: string | undefined,
    hasta: string | undefined,
    token: string,
  ) {
    const supabase = createSupabaseClient(token)
    let q = supabase
      .from('tarja_hs_extras')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('sem_key')

    if (desde) q = q.gte('sem_key', desde)
    if (hasta) q = q.lte('sem_key', hasta)

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },

  // PUT / — upsert individual
  async upsert(dto: UpsertHsExtraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    await ensureSemanaAbierta(supabase, dto.obra_cod, dto.sem_key)

    // hs = 0 → eliminar fila (consistencia con grid)
    if (dto.hs === 0) {
      const { error } = await supabase
        .from('tarja_hs_extras')
        .delete()
        .eq('obra_cod', dto.obra_cod)
        .eq('leg', dto.leg)
        .eq('sem_key', dto.sem_key)

      if (error) throw new Error(error.message)
      return { deleted: true }
    }

    const { data, error } = await supabase
      .from('tarja_hs_extras')
      .upsert(
        {
          obra_cod: dto.obra_cod,
          leg: dto.leg,
          sem_key: dto.sem_key,
          hs: dto.hs,
          created_by: userId,
          updated_by: userId,
        },
        { onConflict: 'obra_cod,leg,sem_key' },
      )
      .select()
      .single()

    if (error) {
      // FK violation → 404 (obra o leg inexistente)
      if (error.code === '23503') {
        throw new HTTPException(404, {
          message: 'Obra o legajo inexistente',
        })
      }
      throw new Error(error.message)
    }
    return data
  },

  // PUT /lote — upsert múltiple atómico por request
  async upsertLote(dto: UpsertHsExtrasLoteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    if (dto.items.length === 0) return { success: true, upserted: 0, deleted: 0 }

    // Validar cierres de todas las semanas involucradas
    const semKeys = dto.items.map((i) => i.sem_key)
    await ensureSemanasAbiertas(supabase, dto.obra_cod, semKeys)

    // Separar items a borrar (hs === 0) y a upsertar
    const aBorrar = dto.items.filter((i) => i.hs === 0)
    const aUpsertar = dto.items.filter((i) => i.hs > 0)

    // NOTA: "atómico por request" — Supabase JS no expone transacciones multi-statement.
    // Para atomicidad real habría que usar una RPC de Postgres. Aquí hacemos las
    // operaciones secuenciales; si alguna falla, lanzamos y no se ejecutan las
    // siguientes. Si se necesita rollback total ante fallos parciales, migrar a RPC.
    let deleted = 0
    for (const b of aBorrar) {
      const { error, count } = await supabase
        .from('tarja_hs_extras')
        .delete({ count: 'exact' })
        .eq('obra_cod', dto.obra_cod)
        .eq('leg', b.leg)
        .eq('sem_key', b.sem_key)
      if (error) throw new Error(error.message)
      deleted += count ?? 0
    }

    if (aUpsertar.length > 0) {
      const rows = aUpsertar.map((i) => ({
        obra_cod: dto.obra_cod,
        leg: i.leg,
        sem_key: i.sem_key,
        hs: i.hs,
        created_by: userId,
        updated_by: userId,
      }))

      const { error } = await supabase
        .from('tarja_hs_extras')
        .upsert(rows, { onConflict: 'obra_cod,leg,sem_key' })

      if (error) {
        if (error.code === '23503') {
          throw new HTTPException(404, {
            message: 'Obra o legajo inexistente en alguno de los items',
          })
        }
        throw new Error(error.message)
      }
    }

    return { success: true, upserted: aUpsertar.length, deleted }
  },

  // DELETE /:id
  async deleteById(id: number, token: string) {
    const supabase = createSupabaseClient(token)

    const existing = await fetchById(supabase, id)
    if (!existing) {
      throw new HTTPException(404, { message: 'Registro inexistente' })
    }

    await ensureSemanaAbierta(supabase, existing.obra_cod, existing.sem_key)

    const { error } = await supabase
      .from('tarja_hs_extras')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  },
}
