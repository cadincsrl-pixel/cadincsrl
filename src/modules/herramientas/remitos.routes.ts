/**
 * Routes de remitos de herramientas. Montado dentro de herramientas.routes.ts
 * antes que las rutas /:id para evitar colisión.
 *
 *   GET    /api/herramientas/remitos
 *   POST   /api/herramientas/remitos
 *   PATCH  /api/herramientas/remitos/:id/emitir
 *   DELETE /api/herramientas/remitos/:id
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'

const remitos = new Hono()
remitos.use('*', authMiddleware)

const ItemSchema = z.object({
  descripcion: z.string().min(1),
  cantidad:    z.number().positive(),
  unidad:      z.string().min(1).default('unidad'),
  obs:         z.string().nullable().optional(),
})

const CreateSchema = z.object({
  numero:  z.string().min(1),
  fecha:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  origen:  z.string().min(1),
  destino: z.string().min(1),
  obs:     z.string().nullable().optional(),
  items:   z.array(ItemSchema).min(1),
})

// GET /api/herramientas/remitos
remitos.get('/', requirePermiso('herramientas', 'lectura'), async (c) => {
  const { data, error } = await supabase
    .from('remitos')
    .select('*, items:remito_items(*)')
    .order('id', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// POST /api/herramientas/remitos
remitos.post('/', requirePermiso('herramientas', 'creacion'), zValidator('json', CreateSchema), async (c) => {
  const dto    = c.req.valid('json')
  const userId = c.get('user').id

  // 1. Insertar remito.
  const { data: remito, error: errR } = await supabase
    .from('remitos')
    .insert({
      numero:     dto.numero,
      fecha:      dto.fecha,
      origen:     dto.origen,
      destino:    dto.destino,
      obs:        dto.obs ?? null,
      created_by: userId,
      updated_by: userId,
    })
    .select()
    .single()

  if (errR) return c.json({ error: errR.message }, 500)

  // 2. Insertar items.
  const items = dto.items.map(it => ({
    remito_id:   remito.id,
    descripcion: it.descripcion,
    cantidad:    it.cantidad,
    unidad:      it.unidad,
    obs:         it.obs ?? null,
  }))
  const { error: errI } = await supabase.from('remito_items').insert(items)

  if (errI) {
    // Si fallan los items, borramos el remito para no dejar huérfano.
    await supabase.from('remitos').delete().eq('id', remito.id)
    return c.json({ error: errI.message }, 500)
  }

  // 3. Devolver con items embebidos para que el client invalide queries con la forma esperada.
  const { data: full } = await supabase
    .from('remitos')
    .select('*, items:remito_items(*)')
    .eq('id', remito.id)
    .single()

  return c.json(full ?? remito)
})

// PATCH /api/herramientas/remitos/:id/emitir
remitos.patch('/:id/emitir', requirePermiso('herramientas', 'actualizacion'), async (c) => {
  const id     = Number(c.req.param('id'))
  const userId = c.get('user').id

  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

  const { data, error } = await supabase
    .from('remitos')
    .update({ estado: 'emitido', updated_by: userId })
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// DELETE /api/herramientas/remitos/:id
remitos.delete('/:id', requirePermiso('herramientas', 'eliminacion'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

  // FK cascade en remito_items borra los items.
  const { error } = await supabase.from('remitos').delete().eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default remitos
