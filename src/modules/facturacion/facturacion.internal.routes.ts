import { Hono } from 'hono'
import { emisionService } from './emision.service.js'

// Reconciliación de facturas de venta con ARCA, disparada por el Cron Job de
// Render (mismo patrón que gps-sync.internal.routes.ts): sin authMiddleware,
// `Authorization: Bearer ${CRON_SECRET}`.
//
// Toma las facturas `error_reconciliar` y las `emitiendo` quietas hace más de
// 2 minutos del ambiente del proceso y las resuelve contra ARCA
// (FECompUltimoAutorizado / FECompConsultar). Sin ARCA configurado no hace nada.

const internal = new Hono()

internal.post('/arca-reconciliar', async (c) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('Authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: 'UNAUTHORIZED' }, 401)
  }
  try {
    const r = await emisionService.reconciliarPendientes()
    return c.json({ success: true, ...r })
  } catch (err) {
    console.error('[internal][arca-reconciliar] failed:', err)
    return c.json({ success: false, error: String(err) }, 500)
  }
})

export default internal
