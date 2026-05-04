import { Hono } from 'hono'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso } from '../../../middleware/permission.js'
import { createSupabaseClient } from '../../../lib/supabase.js'

const notif = new Hono()

notif.use('*', authMiddleware)
notif.on(['GET'], '*', requirePermiso('logistica', 'lectura'))

// Ventana de fechas para los endpoints de campana: docs vencidos en
// el último año (-365d) y por vencer en los próximos 60 días.
function ventanaFechas() {
  const hoy = new Date()
  const haceUnAnio = new Date(hoy)
  haceUnAnio.setDate(haceUnAnio.getDate() - 365)
  const en60Dias = new Date(hoy)
  en60Dias.setDate(en60Dias.getDate() + 60)
  return {
    desde: haceUnAnio.toISOString().slice(0, 10),
    hasta: en60Dias.toISOString().slice(0, 10),
  }
}

// GET /api/logistica/notificaciones/documentos
// Documentos de vehículos (camiones + bateas) con vence_el cargado
// y dentro de la ventana relevante. La clasificación
// (vencido / por vencer / vigente) se hace en frontend.
notif.get('/documentos', async (c) => {
  const sb = createSupabaseClient(c.get('accessToken'))
  const { desde, hasta } = ventanaFechas()

  const { data, error } = await sb
    .from('v_vehiculo_documentos_vencimientos')
    .select('*')
    .gte('vence_el', desde)
    .lte('vence_el', hasta)
    .order('vence_el', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// GET /api/logistica/notificaciones/documentos-choferes
// Documentos de choferes (DNI, licencia, libreta sanitaria, etc.)
// con vence_el cargado y dentro de la ventana relevante.
notif.get('/documentos-choferes', async (c) => {
  const sb = createSupabaseClient(c.get('accessToken'))
  const { desde, hasta } = ventanaFechas()

  const { data, error } = await sb
    .from('v_chofer_documentos_vencimientos')
    .select('*')
    .gte('vence_el', desde)
    .lte('vence_el', hasta)
    .order('vence_el', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// GET /api/logistica/notificaciones/camion-services
// Camiones con service "próximo" (≤ 2000 km del próximo) o "vencido"
// (km_actuales >= km_proximo). El umbral está hardcodeado en la vista
// v_camion_service_estado para mantenerlo en SQL y consistente.
notif.get('/camion-services', async (c) => {
  const sb = createSupabaseClient(c.get('accessToken'))
  const { data, error } = await sb
    .from('v_camion_service_estado')
    .select('*')
    .in('estado', ['proximo', 'vencido'])
    .order('km_restantes', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

export default notif
