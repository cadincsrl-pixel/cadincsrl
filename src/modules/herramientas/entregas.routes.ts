import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'

/**
 * Salidas de herramientas a obra y retornos al pañol — el ledger del pañol.
 *
 * Las SALIDAS de `herr_entregas` NO las escribe este módulo: las escribe el
 * trigger `trg_herr_entregas_sync` sobre `solicitud_compra_item.cantidad_enviada`
 * (ver migración 20260904b). Acá se leen, se les cambia el estado (de a una o
 * en lote) y se registran los RETORNOS (20260904ay): una devolución manual es
 * una fila más, colgada de la salida que devuelve, con retorno parcial
 * permitido. El registro va por RPC con lock de la salida.
 *
 * FASE 1 NO TOCA EL PADRÓN. Ningún endpoint de este archivo escribe en
 * `herramientas` ni en `herr_movimientos`. Vincular y dar de alta es decisión
 * de un humano, y va en fase 2.
 *
 * Por eso alcanza con `herramientas.actualizacion`: Sosa es operador y NO tiene
 * `eliminacion`, así que nada acá puede pedirle ese permiso.
 */
const entregas = new Hono()

// La búsqueda normaliza con `normTxt` (lib/norm-txt.ts), el espejo exacto de
// public.norm_txt(): el trigger guarda `descripcion_norm` con esa función y si
// el texto buscado no se normaliza igual, el ilike no pega nunca.

const ESTADOS  = ['pendiente', 'confirmada', 'vinculada', 'catalogada', 'ignorada', 'anulada', 'revisar'] as const
const ORIGENES = ['clase', 'catalogo', 'patron', 'manual'] as const
// Estados "vivos" de una salida: los que cuentan como herramienta en obra.
const VIVOS = ['pendiente', 'confirmada', 'revisar'] as const

const BOOL_Q = z.enum(['1', '0', 'true', 'false']).optional()

const ListQuerySchema = z.object({
  estado:      z.enum(ESTADOS).optional(),
  // Varios estados separados por coma (pisa a `estado` si vienen los dos).
  estados:     z.string().max(120).optional(),
  sentido:     z.enum(['salida', 'devolucion']).optional(),
  origen:      z.enum(ORIGENES).optional(),
  obra_cod:    z.string().min(1).optional(),
  material_id: z.coerce.number().int().positive().optional(),
  // Solo salidas vivas con algo todavía en obra (cantidad − devuelto > 0).
  en_obra:     BOOL_Q,
  q:           z.string().min(1).optional(),
  desde:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // El techo duro de PostgREST es 1000 filas y no se bypassea desde el cliente
  // (§5.7). Paginamos en el server desde el día 0.
  limit:       z.coerce.number().int().positive().max(200).default(50),
  offset:      z.coerce.number().int().min(0).default(0),
})

// Marcar el estado de una entrega. Un humano solo puede decir "sí, es
// herramienta y ya la vi" (confirmada), "no es herramienta" (ignorada), o
// volverla a la bandeja (pendiente). `vinculada` y `catalogada` son de la
// fase 2 (tocan el padrón) y `anulada` la escribe SOLO el trigger.
const EstadoHumano = z.enum(['pendiente', 'confirmada', 'ignorada', 'revisar'])
const PatchSchema = z.object({
  estado: EstadoHumano,
  nota:   z.string().max(500).nullish(),
})
const BulkSchema = z.object({
  ids:    z.array(z.number().int().positive()).min(1).max(200),
  estado: EstadoHumano,
  nota:   z.string().max(500).nullish(),
})
const RetornoSchema = z.object({
  items: z.array(z.object({
    salida_id: z.number().int().positive(),
    // Sin cantidad = todo lo que sigue en obra de esa salida.
    cantidad:  z.number().positive().optional(),
  })).min(1).max(200),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nota:  z.string().max(500).nullish(),
})

const bool = (v?: string) => v === '1' || v === 'true'

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

    const estados = (q.estados ?? '').split(',').map(s => s.trim()).filter((s): s is typeof ESTADOS[number] => (ESTADOS as readonly string[]).includes(s))
    if (estados.length)  query = query.in('estado', estados)
    else if (q.estado)   query = query.eq('estado', q.estado)
    if (q.sentido)       query = query.eq('sentido', q.sentido)
    if (q.origen)        query = query.eq('origen', q.origen)
    if (q.obra_cod)      query = query.eq('obra_cod', q.obra_cod)
    if (q.material_id)   query = query.eq('material_id', q.material_id)
    if (q.desde)         query = query.gte('fecha', q.desde)
    if (q.hasta)         query = query.lte('fecha', q.hasta)
    if (bool(q.en_obra)) query = query.eq('sentido', 'salida').in('estado', [...VIVOS]).gt('en_obra', 0)
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
    // Vista agregada, no filas crudas (§5.7): una fila por obra.
    supabase.from('v_herr_entregas_obras').select('cod, n, n_pendientes, n_en_obra, cant_en_obra, n_devoluciones, ultima').order('n', { ascending: false }),
    // Si esta vista tiene filas, el `exception when others` del trigger se tragó
    // un error y hay herramientas que salieron sin quedar registradas.
    supabase.from('v_herr_entregas_faltantes').select('item_id', { count: 'exact', head: true }),
  ])

  const lista = (obras.data ?? []) as { cod: string; n: number; n_pendientes: number; n_en_obra: number; cant_en_obra: number; n_devoluciones: number; ultima: string | null }[]

  return c.json({
    pendientes:   pendientes.count ?? 0,
    revisar:      revisar.count ?? 0,
    obras:        lista.length,
    en_obra:      lista.reduce((s, o) => s + Number(o.n_en_obra ?? 0), 0),
    devoluciones: lista.reduce((s, o) => s + Number(o.n_devoluciones ?? 0), 0),
    faltantes:    faltantes.count ?? 0,
    obras_lista:  lista,
  })
})

// PATCH /api/herramientas/entregas/bulk — mismo cambio de estado para varias.
// Va ANTES de /entregas/:id: si no, "bulk" matchea como id.
entregas.patch(
  '/entregas/bulk',
  requirePermiso('herramientas', 'actualizacion'),
  zValidator('json', BulkSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const { data, error } = await supabase
      .from('herr_entregas')
      .update({
        estado:       dto.estado,
        ...(dto.nota !== undefined ? { nota: dto.nota } : {}),
        resuelto_por: c.get('user').id,
        resuelto_el:  new Date().toISOString(),
        updated_by:   c.get('user').id,
      })
      .in('id', dto.ids)
      .neq('estado', 'anulada')
      .select('id')
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ actualizadas: data?.length ?? 0, pedidas: dto.ids.length })
  },
)

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
        // `nota` SOLO se escribe si el body la manda explícitamente: escribirla
        // siempre borraba la nota del trigger (por qué quedó en 'revisar').
        ...(dto.nota !== undefined ? { nota: dto.nota } : {}),
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

// POST /api/herramientas/entregas/retornos — la herramienta volvió al pañol.
// RPC SECURITY DEFINER (siempre con el cliente admin, §9): lockea cada salida
// y rechaza devolver más de lo que sigue en obra.
entregas.post(
  '/entregas/retornos',
  requirePermiso('herramientas', 'actualizacion'),
  zValidator('json', RetornoSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const { data, error } = await supabase.rpc('registrar_retorno_herramientas', {
      p_items:   dto.items,
      p_fecha:   dto.fecha,
      p_nota:    dto.nota ?? null,
      p_user_id: c.get('user').id,
    })
    if (error) {
      const msg = error.message || ''
      const code = ['SIN_ITEMS', 'SALIDA_NO_EXISTE', 'SALIDA_NO_DEVOLVIBLE', 'CANTIDAD_INVALIDA'].find(k => msg.includes(k))
      if (code) return c.json({ error: code, detail: (error as { details?: string }).details ?? null }, 400)
      return c.json({ error: msg }, 500)
    }
    return c.json({ devoluciones: data ?? [] }, 201)
  },
)

export default entregas
