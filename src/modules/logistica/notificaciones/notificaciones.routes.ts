import { Hono } from 'hono'
import { authMiddleware } from '../../../middleware/auth.js'
import { requirePermiso, requirePermisoOr } from '../../../middleware/permission.js'
import { createSupabaseClient, supabase } from '../../../lib/supabase.js'

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
// Documentos con `vence_el` dentro de la ventana relevante, de las CINCO
// entidades que los tienen. La clasificación (vencido / por vencer / vigente)
// se hace en el frontend.
//
// Vive bajo /api/logistica por historia, pero ya no es solo de logística:
// camión y batea son de logística, flota es del módulo flota, máquina de
// alquiler y unidad de áridos. Por eso:
//  - la guarda acepta lectura en CUALQUIERA de esos módulos (antes exigía
//    logística, así que un usuario de flota o de alquiler no veía nunca sus
//    propios vencimientos en la campana);
//  - y las filas se filtran por los módulos que la persona realmente puede
//    leer, para no mostrarle las patentes de un módulo que no tiene.
const MODULO_DE_ENTIDAD: Record<string, string> = {
  camion: 'logistica', batea: 'logistica', flota: 'flota',
  maquina: 'alquiler', unidad: 'aridos',
}

notif.get(
  '/documentos',
  requirePermisoOr([
    { modulo: 'logistica', accion: 'lectura' },
    { modulo: 'flota',     accion: 'lectura' },
    { modulo: 'alquiler',  accion: 'lectura' },
    { modulo: 'aridos',    accion: 'lectura' },
  ]),
  async (c) => {
    const sb = createSupabaseClient(c.get('accessToken'))
    const { desde, hasta } = ventanaFechas()

    const { data, error } = await sb
      .from('v_vehiculo_documentos_vencimientos')
      .select('*')
      .gte('vence_el', desde)
      .lte('vence_el', hasta)
      .order('vence_el', { ascending: true })

    if (error) return c.json({ error: error.message }, 500)

    const { data: perfil } = await supabase
      .from('profiles').select('rol, permisos').eq('id', c.get('user').id).maybeSingle()
    if (perfil?.rol === 'admin') return c.json(data ?? [])

    const permisos = (perfil?.permisos ?? {}) as Record<string, Record<string, boolean>>
    const visibles = (data ?? []).filter(row => {
      const modulo = MODULO_DE_ENTIDAD[String(row.entidad)]
      return !!modulo && permisos[modulo]?.lectura === true
    })
    return c.json(visibles)
  },
)

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
