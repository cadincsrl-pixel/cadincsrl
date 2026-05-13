import { Hono } from 'hono'
import { flotaGpsSyncService } from './flota-gps-sync.service.js'

// Endpoint interno disparado por el Cron Job de Render para sincronizar GPS
// de los vehículos del módulo Flota. NO usa authMiddleware (no hay JWT de
// usuario). Se valida con `Authorization: Bearer ${CRON_SECRET}`.
//
// Espejo de `gps-sync.internal.routes.ts` de logística (mismo CRON_SECRET).

const internal = new Hono()

internal.post('/sync-gps-flota', async (c) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('Authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: 'UNAUTHORIZED' }, 401)
  }
  try {
    const resumen = await flotaGpsSyncService.syncCron()
    return c.json({
      success:     true,
      total:       resumen.total,
      ok:          resumen.ok,
      sin_cambio:  resumen.sin_cambio,
      no_match:    resumen.no_match,
      error:       resumen.error,
      duracion_ms: resumen.duracion_ms,
    })
  } catch (err) {
    console.error('[internal][sync-gps-flota] failed:', err)
    return c.json({ success: false, error: String(err) }, 500)
  }
})

export default internal
