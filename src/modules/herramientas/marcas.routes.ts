/**
 * Catálogo de marcas y modelos de herramientas.
 *
 *   GET    /api/herramientas/marcas              → lista con modelos embebidos
 *   POST   /api/herramientas/marcas              → nueva marca
 *   PATCH  /api/herramientas/marcas/:id          → editar marca
 *   DELETE /api/herramientas/marcas/:id          → soft delete (activo=false)
 *
 *   POST   /api/herramientas/marcas/:id/modelos  → nuevo modelo para esa marca
 *   PATCH  /api/herramientas/modelos/:id         → editar modelo
 *   DELETE /api/herramientas/modelos/:id         → soft delete
 *
 * Permisos: lectura abierta dentro del módulo. Mutaciones requieren
 * creación / actualización / eliminación de herramientas.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'

const marcas = new Hono()
marcas.use('*', authMiddleware)

const MarcaCreateSchema = z.object({
  nom:    z.string().min(1).max(80),
  orden:  z.number().int().optional(),
})

const MarcaUpdateSchema = z.object({
  nom:    z.string().min(1).max(80).optional(),
  orden:  z.number().int().optional(),
  activo: z.boolean().optional(),
})

const ModeloCreateSchema = z.object({
  nom: z.string().min(1).max(80),
})

const ModeloUpdateSchema = z.object({
  nom:    z.string().min(1).max(80).optional(),
  activo: z.boolean().optional(),
})

// GET /api/herramientas/marcas
marcas.get('/marcas', requirePermiso('herramientas', 'lectura'), async (c) => {
  const { data, error } = await supabase
    .from('herr_marcas')
    .select('*, modelos:herr_modelos(id, nom, activo)')
    .order('orden')

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// POST /api/herramientas/marcas
marcas.post('/marcas', requirePermiso('herramientas', 'creacion'), zValidator('json', MarcaCreateSchema), async (c) => {
  const dto    = c.req.valid('json')
  const userId = c.get('user').id

  const { data, error } = await supabase
    .from('herr_marcas')
    .insert({ nom: dto.nom, orden: dto.orden ?? 99, created_by: userId, updated_by: userId })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

// PATCH /api/herramientas/marcas/:id
marcas.patch('/marcas/:id', requirePermiso('herramientas', 'actualizacion'), zValidator('json', MarcaUpdateSchema), async (c) => {
  const id     = Number(c.req.param('id'))
  const dto    = c.req.valid('json')
  const userId = c.get('user').id
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

  const { data, error } = await supabase
    .from('herr_marcas')
    .update({ ...dto, updated_by: userId })
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// DELETE /api/herramientas/marcas/:id — soft delete
marcas.delete('/marcas/:id', requirePermiso('herramientas', 'eliminacion'), async (c) => {
  const id     = Number(c.req.param('id'))
  const userId = c.get('user').id
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

  const { error } = await supabase
    .from('herr_marcas')
    .update({ activo: false, updated_by: userId })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// POST /api/herramientas/marcas/:id/modelos
marcas.post('/marcas/:id/modelos', requirePermiso('herramientas', 'creacion'), zValidator('json', ModeloCreateSchema), async (c) => {
  const marcaId = Number(c.req.param('id'))
  const dto     = c.req.valid('json')
  const userId  = c.get('user').id
  if (!Number.isFinite(marcaId)) return c.json({ error: 'marca_id inválido' }, 400)

  const { data, error } = await supabase
    .from('herr_modelos')
    .insert({ marca_id: marcaId, nom: dto.nom, created_by: userId, updated_by: userId })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

// PATCH /api/herramientas/modelos/:id
marcas.patch('/modelos/:id', requirePermiso('herramientas', 'actualizacion'), zValidator('json', ModeloUpdateSchema), async (c) => {
  const id     = Number(c.req.param('id'))
  const dto    = c.req.valid('json')
  const userId = c.get('user').id
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

  const { data, error } = await supabase
    .from('herr_modelos')
    .update({ ...dto, updated_by: userId })
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// DELETE /api/herramientas/modelos/:id — soft delete
marcas.delete('/modelos/:id', requirePermiso('herramientas', 'eliminacion'), async (c) => {
  const id     = Number(c.req.param('id'))
  const userId = c.get('user').id
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

  const { error } = await supabase
    .from('herr_modelos')
    .update({ activo: false, updated_by: userId })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default marcas
