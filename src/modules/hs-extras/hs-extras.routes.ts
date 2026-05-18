import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { hsExtrasService } from './hs-extras.service.js'
import { UpsertHsExtraSchema, UpsertHsExtrasLoteSchema } from './hs-extras.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const hsExtras = new Hono()

hsExtras.use('*', authMiddleware)

// GET /api/hs-extras/all — todas las hs extras (vistas globales).
// Debe declararse ANTES de /:obra_cod para que Hono no lo matchee como "obra_cod='all'".
hsExtras.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  const userId = c.get('user').id
  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed != null && allowed.length === 0) return c.json([])

  // Si admin, delegar al service (sin filtro). Si no, filtrar por obras.
  if (allowed == null) {
    const token = c.get('accessToken')
    const data = await hsExtrasService.getAll(token)
    return c.json(data)
  }

  const supabase = createSupabaseClient(c.get('accessToken'))
  const { data, error } = await supabase
    .from('tarja_hs_extras')
    .select('*')
    .in('obra_cod', allowed)
    .order('sem_key')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// GET /api/hs-extras/:obra_cod?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
hsExtras.get('/:obra_cod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obra_cod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')

  const data = await hsExtrasService.getByObra(obraCod, desde, hasta, token)
  return c.json(data)
})

// PUT /api/hs-extras — upsert individual
// IMPORTANTE: /lote debe declararse ANTES de este handler para que Hono no lo
// resuelva con este y devuelva 400 de zod (body distinto). Lo cumple el orden abajo.
hsExtras.put(
  '/lote',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UpsertHsExtrasLoteSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
    const data = await hsExtrasService.upsertLote(dto, token, userId)
    return c.json(data)
  },
)

hsExtras.put(
  '/',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UpsertHsExtraSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
    const data = await hsExtrasService.upsert(dto, token, userId)
    return c.json(data)
  },
)

// DELETE /api/hs-extras/:id
hsExtras.delete('/:id',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
  const idParam = c.req.param('id')
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'id inválido' }, 400)
  }
  const token = c.get('accessToken')
  const userId = c.get('user').id

  // Validar acceso a la obra del registro antes de borrar.
  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed != null) {
    const supabase = createSupabaseClient(token)
    const { data: row, error } = await supabase
      .from('tarja_hs_extras')
      .select('obra_cod')
      .eq('id', id)
      .maybeSingle()
    if (error) return c.json({ error: error.message }, 500)
    if (!row) return c.json({ error: 'Registro inexistente' }, 404)
    if (!allowed.includes(row.obra_cod)) {
      throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
    }
  }

  const data = await hsExtrasService.deleteById(id, token)
  return c.json(data)
})

export default hsExtras
