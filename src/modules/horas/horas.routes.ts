import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { horasService } from './horas.service.js'
import { UpsertHoraSchema, UpsertHorasLoteSchema } from './horas.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'

const horas = new Hono()

horas.use('*', authMiddleware)


horas.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  const supabase = createSupabaseClient(c.get('accessToken'))
  const desde = c.req.query('desde')
  const hasta  = c.req.query('hasta')

  let query = supabase.from('horas').select('*').order('fecha').limit(50000)
  if (desde) query = query.gte('fecha', desde)
  if (hasta)  query = query.lte('fecha', hasta)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})


horas.get('/trabajador/:leg', requirePermiso('tarja', 'lectura'), async (c) => {
  const leg   = c.req.param('leg')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')
  const supabase = createSupabaseClient(token)

  let query = supabase
    .from('horas')
    .select('*')
    .eq('leg', leg)
    .order('fecha')

  if (desde) query = query.gte('fecha', desde)
  if (hasta) query = query.lte('fecha', hasta)

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
  const data = await horasService.upsert(dto, token, userId)
  return c.json(data)
})

// PUT /api/horas/lote — upsert en lote
horas.put('/lote', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpsertHorasLoteSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await horasService.upsertLote(dto, token, userId)
  return c.json(data)
})

// DELETE /api/horas/:obraCod/semana?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
horas.delete('/:obraCod/semana', requirePermiso('tarja', 'eliminacion'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  if (!desde || !hasta) return c.json({ error: 'Faltan parámetros desde/hasta' }, 400)
  const token = c.get('accessToken')
  const supabase = createSupabaseClient(token)

  const { error } = await supabase
    .from('horas')
    .delete()
    .eq('obra_cod', obraCod)
    .gte('fecha', desde)
    .lte('fecha', hasta)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})


export default horas
