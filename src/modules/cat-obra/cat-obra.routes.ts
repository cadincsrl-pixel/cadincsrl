import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { createSupabaseClient } from '../../lib/supabase.js'

const catObra = new Hono()

catObra.use('*', authMiddleware)

// GET /api/cat-obra/all
catObra.get('/all', async (c) => {
  const supabase = createSupabaseClient(c.get('accessToken'))
  const { data, error } = await supabase
    .from('cat_obra')
    .select('*')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})


catObra.get('/:obraCod', async (c) => {
  const obraCod = c.req.param('obraCod')
  const semKey = c.req.query('sem_key')
  if (!semKey) return c.json({ error: 'Falta parámetro sem_key' }, 400)

  const supabase = createSupabaseClient(c.get('accessToken'))

  const { data, error } = await supabase
    .from('cat_obra')
    .select('*')
    .eq('obra_cod', obraCod)
    .eq('desde', semKey)

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

const UpsertSchema = z.object({
  obra_cod: z.string().min(1),
  leg: z.string().min(1),
  cat_id: z.number().int().positive(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

// PUT /api/cat-obra — asignar categoría a un trabajador en una obra+semana
catObra.put('/', zValidator('json', UpsertSchema), async (c) => {
  const dto = c.req.valid('json')
  const supabase = createSupabaseClient(c.get('accessToken'))
  const userId = c.get('user').id

  // Buscar si ya existe un registro para esta combinación
  const { data: existing } = await supabase
    .from('cat_obra')
    .select('id')
    .eq('obra_cod', dto.obra_cod)
    .eq('leg', dto.leg)
    .eq('desde', dto.desde)
    .single()

  if (existing) {
    // Actualizar
    const { data, error } = await supabase
      .from('cat_obra')
      .update({ cat_id: dto.cat_id, updated_by: userId })
      .eq('id', existing.id)
      .select()
      .single()

    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  } else {
    // Insertar
    const { data, error } = await supabase
      .from('cat_obra')
      .insert({
        obra_cod: dto.obra_cod,
        leg: dto.leg,
        cat_id: dto.cat_id,
        desde: dto.desde,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()

    if (error) return c.json({ error: error.message }, 500)
    return c.json(data, 201)
  }
})

export default catObra
