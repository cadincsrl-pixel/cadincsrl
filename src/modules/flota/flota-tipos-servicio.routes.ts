import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { createSupabaseClient } from '../../lib/supabase.js'

const CreateSchema = z.object({
  nombre:          z.string().min(1).max(80),
  intervalo_km:    z.number().int().positive().nullable().optional(),
  intervalo_meses: z.number().int().positive().nullable().optional(),
  activo:          z.boolean().optional().default(true),
})

const UpdateSchema = z.object({
  nombre:          z.string().min(1).max(80).optional(),
  intervalo_km:    z.number().int().positive().nullable().optional(),
  intervalo_meses: z.number().int().positive().nullable().optional(),
  activo:          z.boolean().optional(),
})

const tipos = new Hono()
tipos.use('*', authMiddleware)

tipos.get(
  '/',
  requirePermiso('flota', 'lectura'),
  async (c) => {
    const sb = createSupabaseClient(c.get('accessToken'))
    const { data, error } = await sb
      .from('flota_tipos_servicio')
      .select('*')
      .order('nombre')
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  },
)

tipos.post(
  '/',
  requirePermiso('flota', 'creacion'),
  zValidator('json', CreateSchema),
  async (c) => {
    const sb = createSupabaseClient(c.get('accessToken'))
    const { data, error } = await sb
      .from('flota_tipos_servicio')
      .insert(c.req.valid('json'))
      .select()
      .single()
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data, 201)
  },
)

tipos.patch(
  '/:id',
  requirePermiso('flota', 'actualizacion'),
  zValidator('json', UpdateSchema),
  async (c) => {
    const sb = createSupabaseClient(c.get('accessToken'))
    const { data, error } = await sb
      .from('flota_tipos_servicio')
      .update(c.req.valid('json'))
      .eq('id', Number(c.req.param('id')))
      .select()
      .single()
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  },
)

tipos.delete(
  '/:id',
  requirePermiso('flota', 'eliminacion'),
  async (c) => {
    const sb = createSupabaseClient(c.get('accessToken'))
    const { error } = await sb
      .from('flota_tipos_servicio')
      .delete()
      .eq('id', Number(c.req.param('id')))
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ success: true })
  },
)

export default tipos
