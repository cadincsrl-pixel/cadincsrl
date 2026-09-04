import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'

/**
 * Salidas de herramientas a obra — la bandeja del pañol.
 *
 * Las filas de `herr_entregas` NO las escribe este módulo: las escribe el
 * trigger `trg_herr_entregas_sync` sobre `solicitud_compra_item.cantidad_enviada`
 * (ver migración 20260904b). Acá solo se leen y se les cambia el estado.
 *
 * FASE 1 NO TOCA EL PADRÓN. Ningún endpoint de este archivo escribe en
 * `herramientas` ni en `herr_movimientos`. Eso es deliberado: hay 12 textos
 * distintos para la misma amoladora y 35 para "escalera", así que dar de alta
 * automáticamente dejaría ~159 fichas para ~40 objetos reales. Vincular y dar
 * de alta es decisión de un humano, y va en fase 2.
 *
 * Por eso alcanza con `herramientas.actualizacion`: Sosa es operador y NO tiene
 * `eliminacion`, así que nada acá puede pedirle ese permiso.
 */
const entregas = new Hono()

// Espejo EXACTO de public.norm_txt() (migración 20260904a). El trigger guarda
// `descripcion_norm` con esa función, así que el texto que se busca tiene que
// normalizarse igual o el ilike no pega nunca. Si allá cambia, acá también:
// usar String.normalize('NFD') acá parece equivalente y NO lo es (saca acentos
// que el translate de SQL deja pasar).
const NORM_FROM = 'áéíóúüñàèìòùç'
const NORM_TO   = 'aeiouunaeiouc'
function normTxt(t: string): string {
  return Array.from(t.toLowerCase())
    .map(ch => { const i = NORM_FROM.indexOf(ch); return i >= 0 ? NORM_TO[i] : ch })
    .join('')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const ESTADOS = ['pendiente', 'vinculada', 'catalogada', 'ignorada', 'anulada', 'revisar'] as const

const ListQuerySchema = z.object({
  estado:   z.enum(ESTADOS).optional(),
  obra_cod: z.string().min(1).optional(),
  q:        z.string().min(1).optional(),
  desde:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // El techo duro de PostgREST es 1000 filas y no se bypassea desde el cliente
  // (§5.7). Paginamos en el server desde el día 0 en vez de descubrirlo cuando
  // la tabla crezca: hoy son 256 filas y entran ~17 por semana.
  limit:    z.coerce.number().int().positive().max(200).default(50),
  offset:   z.coerce.number().int().min(0).default(0),
})

// Marcar el estado de una entrega. En fase 1 solo se puede archivar
// ("no es herramienta") o desarchivar, más una nota libre.
const PatchSchema = z.object({
  estado: z.enum(['pendiente', 'ignorada', 'revisar']),
  nota:   z.string().max(500).nullish(),
})

// GET /api/herramientas/entregas
entregas.get(
  '/entregas',
  requirePermiso('herramientas', 'lectura'),
  zValidator('query', ListQuerySchema),
  async (c) => {
    const q = c.req.valid('query')

    let query = supabase
      .from('herr_entregas')
      .select('*', { count: 'exact' })
      .order('fecha', { ascending: false })
      .order('id',    { ascending: false })
      .range(q.offset, q.offset + q.limit - 1)

    if (q.estado)   query = query.eq('estado', q.estado)
    if (q.obra_cod) query = query.eq('obra_cod', q.obra_cod)
    if (q.desde)    query = query.gte('fecha', q.desde)
    if (q.hasta)    query = query.lte('fecha', q.hasta)
    // `descripcion_norm` ya viene normalizado por el trigger (sin tildes ni
    // puntuación), así que el ilike de acá tiene que normalizar el input igual.
    if (q.q) {
      const norm = normTxt(q.q)
      if (norm) query = query.ilike('descripcion_norm', `%${norm}%`)
    }

    const { data, error, count } = await query
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ items: data ?? [], total: count ?? 0, limit: q.limit, offset: q.offset })
  },
)

// GET /api/herramientas/entregas/stats
entregas.get('/entregas/stats', requirePermiso('herramientas', 'lectura'), async (c) => {
  const [pendientes, revisar, obras, faltantes] = await Promise.all([
    supabase.from('herr_entregas').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),
    supabase.from('herr_entregas').select('id', { count: 'exact', head: true }).eq('estado', 'revisar'),
    supabase.from('herr_entregas').select('obra_cod').neq('estado', 'anulada'),
    // Si esta vista tiene filas, el `exception when others` del trigger se tragó
    // un error y hay herramientas que salieron sin quedar registradas. Es el
    // antídoto de esa red: se pinta en rojo en la pantalla.
    supabase.from('v_herr_entregas_faltantes').select('item_id', { count: 'exact', head: true }),
  ])

  // La lista de obras va acá y no se deriva en el cliente: el listado viene
  // paginado, así que armarla con las filas de la página dejaba fuera del
  // filtro a toda obra que no cayera en la página que estás mirando.
  const conteo = new Map<string, number>()
  for (const r of (obras.data ?? []) as { obra_cod: string | null }[]) {
    if (r.obra_cod) conteo.set(r.obra_cod, (conteo.get(r.obra_cod) ?? 0) + 1)
  }

  return c.json({
    pendientes: pendientes.count ?? 0,
    revisar:    revisar.count ?? 0,
    obras:      conteo.size,
    faltantes:  faltantes.count ?? 0,
    obras_lista: [...conteo.entries()]
      .map(([cod, n]) => ({ cod, n }))
      .sort((a, b) => b.n - a.n),
  })
})

// PATCH /api/herramientas/entregas/:id
entregas.patch(
  '/entregas/:id',
  requirePermiso('herramientas', 'actualizacion'),
  zValidator('json', PatchSchema),
  async (c) => {
    const id  = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'ID_INVALIDO' }, 400)
    const dto = c.req.valid('json')

    // `anulada` la pone SOLO el trigger, al bajar lo enviado. Dejar que un
    // humano la escriba desincronizaría el ledger de `cantidad_enviada`.
    const { data, error } = await supabase
      .from('herr_entregas')
      .update({
        estado:       dto.estado,
        nota:         dto.nota ?? null,
        resuelto_por: c.get('user').id,
        resuelto_el:  new Date().toISOString(),
        updated_by:   c.get('user').id,
      })
      .eq('id', id)
      .neq('estado', 'anulada')
      .select()
      .maybeSingle()

    if (error) return c.json({ error: error.message }, 500)
    if (!data)  return c.json({ error: 'ENTREGA_NO_EXISTE_O_ANULADA' }, 404)
    return c.json(data)
  },
)

export default entregas
