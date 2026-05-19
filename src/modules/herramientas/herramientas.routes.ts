import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'
import { fotosPorHerramienta, fotosPorId } from './herramienta-fotos.routes.js'
import remitosRoutes from './remitos.routes.js'

const herramientas = new Hono()
herramientas.use('*', authMiddleware)

// Sub-routers. Montados ANTES de las rutas dinámicas /:id para que las URLs
// estáticas tengan prioridad:
//   - /api/herramientas/:id/fotos/...    (galería de una herramienta)
//   - /api/herramientas/fotos/:fotoId... (operaciones por foto)
//   - /api/herramientas/remitos/...      (remitos de movimiento)
herramientas.route('/', fotosPorHerramienta)
herramientas.route('/fotos', fotosPorId)
herramientas.route('/remitos', remitosRoutes)


// GET /api/herramientas/config
herramientas.get('/config', requirePermiso('herramientas', 'lectura'), async (c) => {
  const [tipos, estados, movTipos] = await Promise.all([
    supabase.from('herr_tipos').select('*').eq('activo', true).order('orden'),
    supabase.from('herr_estados').select('*').eq('activo', true).order('orden'),
    supabase.from('herr_mov_tipos').select('*').eq('activo', true).order('orden'),
  ])

  if (tipos.error || estados.error || movTipos.error) {
    console.error('[GET /herramientas/config] db error:', {
      tipos: tipos.error?.message, estados: estados.error?.message, movTipos: movTipos.error?.message,
    })
  }

  return c.json({
    tipos:    tipos.data    ?? [],
    estados:  estados.data  ?? [],
    movTipos: movTipos.data ?? [],
  })
})

// GET /api/herramientas/stats
herramientas.get('/stats', requirePermiso('herramientas', 'lectura'), async (c) => {
  const { data: herrs } = await supabase
    .from('herramientas')
    .select('estado_key, obra_cod')
    .eq('activo', true)

  const { data: movs } = await supabase
    .from('herr_movimientos')
    .select(`
      *,
      herramienta:herramientas(id, codigo, nom),
      tipo:herr_mov_tipos(key, nom, icono, color),
      obra_origen:obras!herr_movimientos_obra_origen_cod_fkey(cod, nom),
      obra_destino:obras!herr_movimientos_obra_destino_cod_fkey(cod, nom)
    `)
    .order('fecha', { ascending: false })
    .limit(10)

  const total       = herrs?.length ?? 0
  const disponibles = herrs?.filter(h => h.estado_key === 'disponible').length ?? 0
  const enUso       = herrs?.filter(h => h.estado_key === 'uso').length ?? 0
  const enRep       = herrs?.filter(h => h.estado_key === 'reparacion').length ?? 0
  const bajas       = herrs?.filter(h => h.estado_key === 'baja').length ?? 0
  const enObras     = new Set(herrs?.filter(h => h.obra_cod).map(h => h.obra_cod)).size

  return c.json({
    total, disponibles, enUso, enRep, bajas, enObras,
    ultimosMovimientos: movs ?? [],
  })
})

// GET /api/herramientas/movimientos/all
herramientas.get('/movimientos/all', requirePermiso('herramientas', 'lectura'), async (c) => {
  const { data, error } = await supabase
    .from('herr_movimientos')
    .select(`
      *,
      herramienta:herramientas(id, codigo, nom),
      tipo:herr_mov_tipos(key, nom, icono, color),
      obra_origen:obras!herr_movimientos_obra_origen_cod_fkey(cod, nom),
      obra_destino:obras!herr_movimientos_obra_destino_cod_fkey(cod, nom)
    `)
    .order('fecha', { ascending: false })
    .limit(200)

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// POST /api/herramientas/movimientos
//
// `tipo_key` debe ser uno de los 7 valores del flujo de inventario.
// El handler usa `estadoMap[tipo_key]` para derivar el nuevo estado de la
// herramienta — si llegaba un string libre, quedaba con estado undefined
// y se generaba data inconsistente. Acotamos al enum.
const TIPOS_MOV = ['alta','asignacion','traslado','devolucion','reparacion','retorno_rep','baja'] as const
// `responsable_user_id` y `responsable_leg` son FK opcionales — el frontend
// puede pasar cualquiera (o ninguno, para data legacy). Si vienen, el
// backend resuelve el nombre y lo guarda en `responsable` como snapshot.
const MovSchema = z.object({
  herramienta_id:       z.number(),
  tipo_key:             z.enum(TIPOS_MOV),
  obra_origen_cod:      z.string().nullable().optional(),
  obra_destino_cod:     z.string().nullable().optional(),
  responsable:          z.string().optional(),
  responsable_user_id:  z.string().uuid().nullable().optional(),
  responsable_leg:      z.string().nullable().optional(),
  obs:                  z.string().optional(),
  fecha:                z.string().datetime().optional(),
})

herramientas.post('/movimientos', requirePermiso('herramientas', 'actualizacion'), zValidator('json', MovSchema), async (c) => {
  const dto = c.req.valid('json')
  const userId = c.get('user').id

  // Estado según tipo
  const estadoMap: Record<string, string> = {
    alta:        'disponible',
    asignacion:  'uso',
    traslado:    'uso',
    devolucion:  'disponible',
    reparacion:  'reparacion',
    retorno_rep: 'disponible',
    baja:        'baja',
  }

  const nuevoEstado = estadoMap[dto.tipo_key]

  // La obra actual de la herramienta es siempre el destino
  // Si no hay destino (reparacion, baja), mantener la obra actual
  const nuevaObra = dto.obra_destino_cod !== undefined
    ? dto.obra_destino_cod
    : undefined

  // Resolver snapshot del nombre desde la FK si vino una. La columna
  // `responsable` text queda como display cache; lookups por FK siguen
  // andando contra profiles/personal cuando se necesite detalle.
  let responsableSnapshot = dto.responsable ?? ''
  if (dto.responsable_user_id) {
    const { data } = await supabase
      .from('profiles')
      .select('nombre')
      .eq('id', dto.responsable_user_id)
      .maybeSingle()
    if (data?.nombre) responsableSnapshot = data.nombre
  } else if (dto.responsable_leg) {
    const { data } = await supabase
      .from('personal')
      .select('nom')
      .eq('leg', dto.responsable_leg)
      .maybeSingle()
    if (data?.nom) responsableSnapshot = data.nom
  }

  const { data: mov, error: movErr } = await supabase
    .from('herr_movimientos')
    .insert({
      herramienta_id:      dto.herramienta_id,
      tipo_key:            dto.tipo_key,
      obra_origen_cod:     dto.obra_origen_cod  ?? null,
      obra_destino_cod:    dto.obra_destino_cod ?? null,
      responsable:         responsableSnapshot,
      responsable_user_id: dto.responsable_user_id ?? null,
      responsable_leg:     dto.responsable_leg     ?? null,
      obs:                 dto.obs ?? '',
      fecha:               dto.fecha ?? new Date().toISOString(),
      created_by:          userId,
      updated_by:          userId,
    })
    .select()
    .single()

  if (movErr) return c.json({ error: movErr.message }, 500)

  // Actualizar herramienta
  const updatePayload: Record<string, any> = { updated_by: userId }
  if (nuevoEstado)             updatePayload.estado_key  = nuevoEstado
  if (nuevaObra !== undefined) updatePayload.obra_cod    = nuevaObra
  if (responsableSnapshot)     updatePayload.responsable = responsableSnapshot

  await supabase.from('herramientas').update(updatePayload).eq('id', dto.herramienta_id)

  return c.json(mov, 201)
})

// POST /api/herramientas/config/tipos
herramientas.post('/config/tipos', requirePermiso('herramientas', 'creacion'), async (c) => {
  const body = await c.req.json()
  const userId = c.get('user').id
  const { data, error } = await supabase
    .from('herr_tipos')
    .insert({ nom: body.nom, icono: body.icono ?? null, orden: body.orden ?? 99, created_by: userId, updated_by: userId })
    .select().single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

// PATCH /api/herramientas/config/tipos/:id
herramientas.patch('/config/tipos/:id', requirePermiso('herramientas', 'actualizacion'), async (c) => {
  const id   = Number(c.req.param('id'))
  const body = await c.req.json()
  const userId = c.get('user').id
  const { data, error } = await supabase
    .from('herr_tipos')
    .update({ nom: body.nom, icono: body.icono ?? null, updated_by: userId })
    .eq('id', id).select().single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// DELETE /api/herramientas/config/tipos/:id
herramientas.delete('/config/tipos/:id', requirePermiso('herramientas', 'eliminacion'), async (c) => {
  const id = Number(c.req.param('id'))
  const { error } = await supabase.from('herr_tipos').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// PATCH /api/herramientas/config/mov-tipos/:key
herramientas.patch('/config/mov-tipos/:key', requirePermiso('herramientas', 'actualizacion'), async (c) => {
  const key  = c.req.param('key')
  const body = await c.req.json()
  const userId = c.get('user').id
  const { data, error } = await supabase
    .from('herr_mov_tipos')
    .update({ nom: body.nom, icono: body.icono ?? null, descripcion: body.descripcion ?? null, updated_by: userId })
    .eq('key', key).select().single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// ══════════════════════════════════════════════════
// RUTAS DINÁMICAS — siempre al final
// ══════════════════════════════════════════════════

// GET /api/herramientas
herramientas.get('/', requirePermiso('herramientas', 'lectura'), async (c) => {
  const { data, error } = await supabase
    .from('herramientas')
    .select(`
      *,
      tipo:herr_tipos(id, nom, icono),
      estado:herr_estados(key, nom, color, icono),
      obra:obras(cod, nom)
    `)
    .eq('activo', true)
    .order('codigo')

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// POST /api/herramientas
const CreateSchema = z.object({
  codigo:        z.string().min(1),
  nom:           z.string().min(1),
  tipo_id:       z.number().optional(),
  marca:         z.string().optional(),
  modelo:        z.string().optional(),
  serie:         z.string().optional(),
  fecha_ingreso: z.string().optional(),
  obs:           z.string().optional(),
})

herramientas.post('/', requirePermiso('herramientas', 'creacion'), zValidator('json', CreateSchema), async (c) => {
  const dto = c.req.valid('json')
  const userId = c.get('user').id

  const { data: herr, error: herrErr } = await supabase
    .from('herramientas')
    .insert({ ...dto, estado_key: 'disponible', created_by: userId, updated_by: userId })
    .select()
    .single()

  if (herrErr) return c.json({ error: herrErr.message }, 500)

  await supabase.from('herr_movimientos').insert({
    herramienta_id: herr.id,
    tipo_key:       'alta',
    responsable:    'Sistema',
    obs:            'Alta inicial en sistema',
    created_by:     userId,
    updated_by:     userId,
  })

  return c.json(herr, 201)
})

// GET /api/herramientas/:id/movimientos
herramientas.get('/:id/movimientos', requirePermiso('herramientas', 'lectura'), async (c) => {
  const id = Number(c.req.param('id'))

  const { data, error } = await supabase
    .from('herr_movimientos')
    .select(`
      *,
      tipo:herr_mov_tipos(key, nom, icono, color),
      obra_origen:obras!herr_movimientos_obra_origen_cod_fkey(cod, nom),
      obra_destino:obras!herr_movimientos_obra_destino_cod_fkey(cod, nom)
    `)
    .eq('herramienta_id', id)
    .order('fecha', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// GET /api/herramientas/:id
herramientas.get('/:id', requirePermiso('herramientas', 'lectura'), async (c) => {
  const id = Number(c.req.param('id'))

  const { data, error } = await supabase
    .from('herramientas')
    .select(`
      *,
      tipo:herr_tipos(id, nom, icono),
      estado:herr_estados(key, nom, color, icono),
      obra:obras(cod, nom)
    `)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// PATCH /api/herramientas/:id
const UpdateSchema = z.object({
  nom:           z.string().min(1).optional(),
  tipo_id:       z.number().optional(),
  marca:         z.string().optional(),
  modelo:        z.string().optional(),
  serie:         z.string().optional(),
  fecha_ingreso: z.string().optional(),
  obs:           z.string().optional(),
})

herramientas.patch('/:id', requirePermiso('herramientas', 'actualizacion'), zValidator('json', UpdateSchema), async (c) => {
  const id  = Number(c.req.param('id'))
  const dto = c.req.valid('json')
  const userId = c.get('user').id

  const { data, error } = await supabase
    .from('herramientas')
    .update({ ...dto, updated_by: userId })
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// DELETE /api/herramientas/:id
herramientas.delete('/:id', requirePermiso('herramientas', 'eliminacion'), async (c) => {
  const id = Number(c.req.param('id'))
  const userId = c.get('user').id

  const { error } = await supabase
    .from('herramientas')
    .update({ activo: false, estado_key: 'baja', updated_by: userId })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default herramientas
