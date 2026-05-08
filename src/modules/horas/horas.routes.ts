import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { horasService } from './horas.service.js'
import { UpsertHoraSchema, UpsertHorasLoteSchema } from './horas.schema.js'
import { supabase, createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const horas = new Hono()

horas.use('*', authMiddleware)


horas.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  // Usar cliente admin + paginación para superar el max-rows de PostgREST (1000 por defecto).
  const desde = c.req.query('desde')
  const hasta  = c.req.query('hasta')
  const userId = c.get('user').id

  const allowed = await getObrasDelUsuarioCached(userId)
  if (allowed != null && allowed.length === 0) return c.json([])

  const PAGE = 1000
  const all: any[] = []
  let from = 0

  while (true) {
    let q = supabase
      .from('horas')
      .select('*')
      .order('fecha')
      .range(from, from + PAGE - 1)
    if (desde) q = q.gte('fecha', desde)
    if (hasta)  q = q.lte('fecha', hasta)
    if (allowed != null) q = q.in('obra_cod', allowed)

    const { data, error } = await q
    if (error) return c.json({ error: error.message }, 500)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  return c.json(all)
})


horas.get('/trabajador/:leg', requirePermiso('tarja', 'lectura'), async (c) => {
  const leg   = c.req.param('leg')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const supabase = createSupabaseClient(token)

  const allowed = await getObrasDelUsuarioCached(userId)
  if (allowed != null && allowed.length === 0) return c.json([])

  let query = supabase
    .from('horas')
    .select('*')
    .eq('leg', leg)
    .order('fecha')

  if (desde) query = query.gte('fecha', desde)
  if (hasta) query = query.lte('fecha', hasta)
  if (allowed != null) query = query.in('obra_cod', allowed)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})


// GET /api/horas/:obraCod?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
horas.get('/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')
  const userId = c.get('user').id

  await validarObraDelUsuario(userId, obraCod)

  if (desde && hasta) {
    const data = await horasService.getBySemana(obraCod, desde, hasta, token)
    return c.json(data)
  }

  const data = await horasService.getByObra(obraCod, token)
  return c.json(data)
})

// PUT /api/horas — upsert individual
horas.put('/', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpsertHoraSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod)
  const data = await horasService.upsert(dto, token, userId)
  return c.json(data)
})

// PUT /api/horas/lote — upsert en lote
horas.put('/lote', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpsertHorasLoteSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod)
  const data = await horasService.upsertLote(dto, token, userId)
  return c.json(data)
})

// DELETE /api/horas/:obraCod/semana?desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&leg=LEG]
horas.delete('/:obraCod/semana', requirePermiso('tarja', 'eliminacion'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const leg = c.req.query('leg')
  if (!desde || !hasta) return c.json({ error: 'Faltan parámetros desde/hasta' }, 400)
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod)
  const supabase = createSupabaseClient(token)

  let q = supabase
    .from('horas')
    .delete()
    .eq('obra_cod', obraCod)
    .gte('fecha', desde)
    .lte('fecha', hasta)

  if (leg) q = q.eq('leg', leg)

  const { error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})


export default horas
