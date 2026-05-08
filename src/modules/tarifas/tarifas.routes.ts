import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { tarifasService } from './tarifas.service.js'
import { CreateTarifaSchema } from './tarifas.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const tarifas = new Hono()

tarifas.use('*', authMiddleware)

// Lectura: capataz NO ve tarifas (no debería ver costos).
tarifas.get(
  '/all',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true),
  async (c) => {
    const userId = c.get('user').id
    const allowed = await getObrasDelUsuarioCached(userId)
    if (allowed != null && allowed.length === 0) return c.json([])

    const supabase = createSupabaseClient(c.get('accessToken'))
    let q = supabase
      .from('tarifas')
      .select('*')
      .order('desde')
    if (allowed != null) q = q.in('obra_cod', allowed)
    const { data, error } = await q
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  },
)


// GET /api/tarifas/:obraCod
tarifas.get(
  '/:obraCod',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true),
  async (c) => {
    const obraCod = c.req.param('obraCod')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, obraCod)
    const data = await tarifasService.getByObra(obraCod, token)
    return c.json(data)
  },
)

// PUT /api/tarifas — administración de tarifas: jefatura.
tarifas.put(
  '/',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  zValidator('json', CreateTarifaSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod)
    const data = await tarifasService.upsert(dto, token, userId)
    return c.json(data)
  },
)

// DELETE /api/tarifas/:id — administración: jefatura.
tarifas.delete(
  '/:id',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'solo_carga_horas', false),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const token = c.get('accessToken')
    const userId = c.get('user').id

    // Validar que la tarifa pertenezca a una obra del usuario antes de borrar.
    const allowed = await getObrasDelUsuarioCached(userId)
    if (allowed != null) {
      const supabase = createSupabaseClient(token)
      const { data: row, error } = await supabase
        .from('tarifas')
        .select('obra_cod')
        .eq('id', id)
        .maybeSingle()
      if (error) return c.json({ error: error.message }, 500)
      if (!row) return c.json({ error: 'Tarifa no encontrada' }, 404)
      if (!allowed.includes(row.obra_cod)) {
        throw new HTTPException(403, { message: 'OBRA_SIN_ACCESO' })
      }
    }

    const data = await tarifasService.delete(id, token)
    return c.json(data)
  },
)



export default tarifas
