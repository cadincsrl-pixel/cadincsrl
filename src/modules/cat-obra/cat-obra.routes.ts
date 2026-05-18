import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const catObra = new Hono()

catObra.use('*', authMiddleware)

// GET /api/cat-obra/all
catObra.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  const userId = c.get('user').id
  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed != null && allowed.length === 0) return c.json([])

  const supabase = createSupabaseClient(c.get('accessToken'))
  let q = supabase.from('cat_obra').select('*')
  if (allowed != null) q = q.in('obra_cod', allowed)
  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})


// Categoría efectiva (override de cat_obra) para cada leg en una obra,
// vigente al sem_key. cat_obra es persistente: una vez seteado para un leg,
// aplica hacia adelante hasta que se cargue otro override más reciente.
catObra.get('/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const semKey = c.req.query('sem_key')
  if (!semKey) return c.json({ error: 'Falta parámetro sem_key' }, 400)

  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')

  const supabase = createSupabaseClient(c.get('accessToken'))

  const { data, error } = await supabase
    .from('cat_obra')
    .select('*')
    .eq('obra_cod', obraCod)
    .lte('desde', semKey)
    .order('desde', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)

  // Quedarse con el más reciente por leg
  const seen = new Set<string>()
  const ultimoPorLeg = (data ?? []).filter((row: { leg: string }) => {
    if (seen.has(row.leg)) return false
    seen.add(row.leg)
    return true
  })
  return c.json(ultimoPorLeg)
})

const UpsertSchema = z.object({
  obra_cod: z.string().min(1),
  leg: z.string().min(1),
  cat_id: z.number().int().positive(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

// PUT /api/cat-obra — asignar categoría a un trabajador en una obra+semana.
// Acción de jefatura/RRHH: capataz NO puede.
catObra.put(
  '/',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UpsertSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
    const supabase = createSupabaseClient(c.get('accessToken'))

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
  },
)

export default catObra
