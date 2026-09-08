// Arranque del servidor. Las rutas viven en app.ts.
import 'dotenv/config'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { flushAuditoriaPendiente } from './middleware/audit.js'

const port = Number(process.env.PORT) || 3001
console.log(`🚀 tarjaobra-backend corriendo en puerto ${port}`)

serve({ fetch: app.fetch, port })
// Al apagarse (deploy en Render = SIGTERM), escribir la auditoría de tarja
// que quedó acumulada en memoria; si tarda más de 3 s, salir igual.
for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    const salir = () => process.exit(0)
    setTimeout(salir, 3000).unref()
    flushAuditoriaPendiente().then(salir, salir)
  })
}
