import { createSupabaseClient, supabase as supabaseAdmin } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import type { CreatePrestamoDto } from './prestamos.schema.js'

export interface FiltroPrestamos {
  /** Solo estos legajos ([] = ninguno → devuelve []). */
  legs?: string[]
  semKey?: string
  desde?: string
  hasta?: string
}

export const prestamosService = {

  // GET / — lectura por el backend, paginada y con un solo orden (más nuevo
  // primero). Hasta 2026-09-07 el front leía la tabla con la anon key, sin
  // paginar y con dos órdenes distintos según la pantalla.
  async list(f: FiltroPrestamos = {}) {
    if (f.legs && f.legs.length === 0) return []
    return todasLasFilas((d, h) => {
      let q = supabaseAdmin
        .from('prestamos')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(d, h)
      if (f.legs)   q = q.in('leg', f.legs)
      if (f.semKey) q = q.eq('sem_key', f.semKey)
      if (f.desde)  q = q.gte('sem_key', f.desde)
      if (f.hasta)  q = q.lte('sem_key', f.hasta)
      return q
    })
  },

  async create(dto: CreatePrestamoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('prestamos')
      .insert({
        leg:        dto.leg,
        sem_key:    dto.sem_key,
        tipo:       dto.tipo,
        monto:      dto.monto,
        concepto:   dto.concepto ?? null,
        created_by: userId,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('prestamos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
