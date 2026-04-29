import { Hono } from 'hono'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { createSupabaseClient } from '../../../lib/supabase.js'

const notif = new Hono()

notif.use('*', authMiddleware)
notif.on(['GET'], '*', requirePermiso('logistica', 'lectura'))

// GET /api/logistica/notificaciones/documentos
// Devuelve docs de vehículos con vence_el dentro de un rango razonable
// (-365 días → +60 días) para alimentar la campana del topbar.
// La clasificación (vencido / por vencer / vigente) se hace en frontend.
notif.get('/documentos', async (c) => {
  const sb = createSupabaseClient(c.get('accessToken'))

  const hoy = new Date()
  const haceUnAnio = new Date(hoy)
  haceUnAnio.setDate(haceUnAnio.getDate() - 365)
  const en60Dias = new Date(hoy)
  en60Dias.setDate(en60Dias.getDate() + 60)

  const { data, error } = await sb
    .from('v_vehiculo_documentos_vencimientos')
    .select('*')
    .gte('vence_el', haceUnAnio.toISOString().slice(0, 10))
    .lte('vence_el', en60Dias.toISOString().slice(0, 10))
    .order('vence_el', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

export default notif
