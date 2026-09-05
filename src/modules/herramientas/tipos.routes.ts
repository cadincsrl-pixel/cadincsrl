import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'
import { normTxt } from '../../lib/norm-txt.js'

/**
 * Catálogo de tipos de herramienta — la pestaña "Catálogo" de Herramientas.
 *
 * Un TIPO es una fila de `stock_materiales` con clase 'herramienta' (rubro
 * "Herramientas y máquinas"). Es lo que el pedido ofrece en el buscador y lo
 * que el ledger del pañol (`herr_entregas`) cuenta por `material_id`. Las
 * fichas HER-NNN del inventario viejo son otra cosa (una unidad física) y se
 * enganchan con el tipo en la fase 2 del pañol.
 *
 * Los endpoints de `/api/stock/materiales` piden permiso de Certificaciones;
 * acá alcanza con Herramientas: ver = lectura, crear / editar / baja =
 * actualizacion (decisión del user 2026-09-05: Sosa puede sumar un tipo).
 * Nada de acá toca precios ni stock: un tipo de herramienta no tiene precio.
 */
const tipos = new Hono()

const RUBRO_HERRAMIENTAS = 'Herramientas y máquinas'

const AliasSchema = z.array(z.string().max(120)).max(60)
const CrearSchema = z.object({
  nombre: z.string().trim().min(3).max(120),
  alias:  AliasSchema.optional(),
  obs:    z.string().max(500).nullish(),
})
const EditarSchema = z.object({
  nombre: z.string().trim().min(3).max(120).optional(),
  alias:  AliasSchema.optional(),
  activo: z.boolean().optional(),
  obs:    z.string().max(500).nullish(),
}).refine(d => Object.keys(d).length > 0, { message: 'Nada para cambiar' })

const FusionarSchema = z.object({ destino_id: z.number().int().positive() })

const ListQuerySchema = z.object({
  q:         z.string().max(120).optional(),
  inactivos: z.enum(['1', '0', 'true', 'false']).optional(),
})

type TipoRow = {
  id: number; nombre: string; alias: string[] | null; obs: string | null; activo: boolean; rubro_id: number | null
  created_at: string; updated_at: string
  en_obra: number; n_obras: number; sin_revisar: number; salidas: number; devoluciones: number; ultima: string | null; renglones: number
}

// Alias limpios: normalizados como los busca el pedido (norm_txt), sin
// repetidos, sin vacíos y sin el propio nombre.
function limpiarAlias(alias: string[] | undefined, nombre: string): string[] {
  const n = normTxt(nombre)
  const out: string[] = []
  for (const a of alias ?? []) {
    const v = normTxt(a)
    if (!v || v === n || out.includes(v)) continue
    out.push(v)
  }
  return out
}

async function rubroHerramientasId(): Promise<number | null> {
  const { data } = await supabase.from('stock_rubros').select('id').eq('nombre', RUBRO_HERRAMIENTAS).maybeSingle()
  return data?.id ?? null
}

// Tipos ACTIVOS que chocan con un nombre o alias (misma normalización que el
// buscador del pedido, así lo que acá es duplicado allá también lo sería).
async function chocan(nombre: string, alias: string[], exceptoId?: number) {
  const { data, error } = await supabase
    .from('stock_materiales')
    .select('id, nombre, alias')
    .eq('clase', 'herramienta')
    .eq('activo', true)
  if (error) throw new Error(error.message)
  const claves = new Set([normTxt(nombre), ...alias])
  return (data ?? [])
    .filter(m => m.id !== exceptoId)
    .filter(m => claves.has(normTxt(m.nombre)) || ((m.alias ?? []) as string[]).some(a => claves.has(normTxt(a))))
    .map(m => ({ id: m.id, nombre: m.nombre }))
}

async function leerTipo(id: number): Promise<TipoRow | null> {
  const { data, error } = await supabase.from('v_herr_tipos').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as TipoRow | null) ?? null
}

// GET /api/herramientas/tipos?q=&inactivos=1
// Son ~100 filas: se traen todas (lejos del techo de 1000) y el texto se
// filtra acá con normTxt sobre nombre + alias, igual que el buscador del pedido.
tipos.get('/tipos', requirePermiso('herramientas', 'lectura'), zValidator('query', ListQuerySchema), async (c) => {
  const { q, inactivos } = c.req.valid('query')
  let query = supabase.from('v_herr_tipos').select('*').order('nombre')
  if (!(inactivos === '1' || inactivos === 'true')) query = query.eq('activo', true)
  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  let rows = (data ?? []) as TipoRow[]
  const nq = q ? normTxt(q) : ''
  if (nq) {
    rows = rows.filter(r => normTxt(r.nombre).includes(nq) || (r.alias ?? []).some(a => normTxt(a).includes(nq)))
  }
  return c.json(rows)
})

// GET /api/herramientas/tipos/:id/entregas — salidas y retornos de un tipo
// (vivas), para el detalle. Un tipo tiene decenas de filas, no miles.
tipos.get('/tipos/:id/entregas', requirePermiso('herramientas', 'lectura'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'ID_INVALIDO' }, 400)
  const { data, error } = await supabase
    .from('herr_entregas')
    .select('*')
    .eq('material_id', id)
    .neq('estado', 'anulada')
    .order('fecha', { ascending: false })
    .order('id', { ascending: false })
    .limit(500)
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// POST /api/herramientas/tipos
tipos.post('/tipos', requirePermiso('herramientas', 'actualizacion'), zValidator('json', CrearSchema), async (c) => {
  const dto = c.req.valid('json')
  const nombre = dto.nombre.trim()
  const alias = limpiarAlias(dto.alias, nombre)

  const dup = await chocan(nombre, alias)
  if (dup.length > 0) return c.json({ error: 'TIPO_DUPLICADO', candidatos: dup }, 409)

  const rubroId = await rubroHerramientasId()
  const userId = c.get('user').id
  const { data, error } = await supabase
    .from('stock_materiales')
    .insert({
      nombre, alias, clase: 'herramienta', rubro_id: rubroId, unidad: 'unid', precio_ref: 0,
      obs: dto.obs ?? null, created_by: userId, updated_by: userId,
    })
    .select('id')
    .single()
  if (error) {
    // Índice único parcial `stock_materiales_nombre_norm_uidx` (fase 1 del catálogo).
    if (error.code === '23505') return c.json({ error: 'TIPO_DUPLICADO', candidatos: await chocan(nombre, []) }, 409)
    return c.json({ error: error.message }, 500)
  }
  return c.json(await leerTipo(data.id), 201)
})

// PATCH /api/herramientas/tipos/:id — nombre, alias, obs, alta/baja.
// Renombrar propaga a los renglones de pedido y al pañol que todavía llevan el
// nombre viejo (igual que hicieron las migraciones a mano), así "Salidas a
// obra" y los pedidos viejos muestran el nombre nuevo.
tipos.patch('/tipos/:id', requirePermiso('herramientas', 'actualizacion'), zValidator('json', EditarSchema), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'ID_INVALIDO' }, 400)
  const dto = c.req.valid('json')

  const { data: actual, error: errSel } = await supabase
    .from('stock_materiales').select('id, nombre, alias, clase').eq('id', id).maybeSingle()
  if (errSel) return c.json({ error: errSel.message }, 500)
  if (!actual || actual.clase !== 'herramienta') return c.json({ error: 'TIPO_NO_EXISTE' }, 404)

  const nombre = dto.nombre?.trim() ?? actual.nombre
  const alias = dto.alias !== undefined ? limpiarAlias(dto.alias, nombre) : limpiarAlias((actual.alias ?? []) as string[], nombre)

  if (dto.nombre !== undefined || dto.alias !== undefined || dto.activo === true) {
    const dup = await chocan(nombre, alias, id)
    if (dup.length > 0) return c.json({ error: 'TIPO_DUPLICADO', candidatos: dup }, 409)
  }

  const userId = c.get('user').id
  const cambios: Record<string, unknown> = { updated_by: userId, updated_at: new Date().toISOString() }
  if (dto.nombre !== undefined) cambios.nombre = nombre
  if (dto.alias  !== undefined) cambios.alias  = alias
  if (dto.activo !== undefined) cambios.activo = dto.activo
  if (dto.obs    !== undefined) cambios.obs    = dto.obs

  const { error } = await supabase.from('stock_materiales').update(cambios).eq('id', id)
  if (error) {
    if (error.code === '23505') return c.json({ error: 'TIPO_DUPLICADO', candidatos: await chocan(nombre, [], id) }, 409)
    return c.json({ error: error.message }, 500)
  }

  if (dto.nombre !== undefined && nombre !== actual.nombre) {
    const [r1, r2] = await Promise.all([
      supabase.from('solicitud_compra_item').update({ descripcion: nombre })
        .eq('material_id', id).eq('descripcion', actual.nombre),
      supabase.from('herr_entregas').update({ descripcion: nombre, descripcion_norm: normTxt(nombre), updated_at: new Date().toISOString() })
        .eq('material_id', id).eq('descripcion', actual.nombre),
    ])
    // El tipo ya quedó renombrado; si la propagación falla se avisa pero no se revierte.
    if (r1.error || r2.error) {
      return c.json({ ...(await leerTipo(id)), aviso: `El tipo se renombró pero no se pudo propagar a ${r1.error ? 'los pedidos' : 'el pañol'}: ${(r1.error ?? r2.error)?.message}` })
    }
  }

  return c.json(await leerTipo(id))
})

// POST /api/herramientas/tipos/:id/fusionar { destino_id } — el tipo :id se
// funde en destino_id y queda de baja: sus renglones de pedido, sus salidas y
// retornos del pañol y sus sinónimos pasan al destino (RPC transaccional
// `fusionar_tipo_herramienta`). Reescribe historia, por eso pide `eliminacion`
// y no `actualizacion` como el resto del catálogo.
tipos.post('/tipos/:id/fusionar', requirePermiso('herramientas', 'eliminacion'), zValidator('json', FusionarSchema), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'ID_INVALIDO' }, 400)
  const { destino_id } = c.req.valid('json')
  if (destino_id === id) return c.json({ error: 'FUSION_MISMO_TIPO' }, 400)

  const { data, error } = await supabase.rpc('fusionar_tipo_herramienta', {
    p_origen: id, p_destino: destino_id, p_user_id: c.get('user').id,
  })
  if (error) {
    const code = error.message.match(/ORIGEN_NO_ES_TIPO|DESTINO_NO_ES_TIPO|DESTINO_DE_BAJA|FUSION_MISMO_TIPO/)?.[0]
    if (code === 'ORIGEN_NO_ES_TIPO' || code === 'DESTINO_NO_ES_TIPO') return c.json({ error: code }, 404)
    if (code) return c.json({ error: code }, 409)
    return c.json({ error: error.message }, 500)
  }
  return c.json({ ...(data as Record<string, unknown>), tipo: await leerTipo(destino_id) })
})

export default tipos
