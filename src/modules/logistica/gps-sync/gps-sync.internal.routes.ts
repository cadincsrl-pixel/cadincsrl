import { Hono } from 'hono'
import { gpsSyncService } from './gps-sync.service.js'

// Endpoints internos disparados por el Cron Job de Render. NO usan
// authMiddleware (no hay JWT de usuario). El cron de Render ejecuta `curl`
// con header `Authorization: Bearer ${CRON_SECRET}` y nosotros validamos
// contra la env var del mismo nombre.
//
// Ref: https://render.com/docs/cronjobs

const internal = new Hono()

internal.post('/sync-gps', async (c) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('Authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: 'UNAUTHORIZED' }, 401)
  }
  try {
    const resumen = await gpsSyncService.syncCron()
    return c.json({
      success: true,
      total:        resumen.total,
      ok:           resumen.ok,
      sin_cambio:   resumen.sin_cambio,
      no_match:     resumen.no_match,
      error:        resumen.error,
      duracion_ms:  resumen.duracion_ms,
    })
  } catch (err) {
    console.error('[internal][sync-gps] failed:', err)
    return c.json({ success: false, error: String(err) }, 500)
  }
})

export default internal
