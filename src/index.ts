import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware } from './middleware/auth.js'


import categoriasRoutes from './modules/categorias/categorias.routes.js'
import obrasRoutes from './modules/obras/obras.routes.js'
import personalRoutes from './modules/personal/personal.routes.js'
import horasRoutes from './modules/horas/horas.routes.js'
import asignacionesRoutes from './modules/asignaciones/asignaciones.routes.js'
import cierresRoutes from './modules/cierres/cierres.routes.js'
import tarifasRoutes from './modules/tarifas/tarifas.routes.js'
import contratistasRoutes from './modules/contratistas/contratistas.routes.js'
import choferesRoutes     from './modules/logistica/choferes/choferes.routes.js'
import camionesRoutes     from './modules/logistica/camiones/camiones.routes.js'
import lugaresRoutes      from './modules/logistica/lugares/lugares.routes.js'
import viajesRoutes       from './modules/logistica/viajes/viajes.routes.js'
import liquidacionesRoutes from './modules/logistica/liquidaciones/liquidaciones.routes.js'
import tramosRoutes        from './modules/logistica/tramos/tramos.routes.js'
import authRoutes from './modules/auth/auth.routes.js'
import usuariosRoutes from './modules/auth/usuarios.routes.js'
import herramientasRoutes from './modules/herramientas/herramientas.routes.js'
import catObraRoutes from './modules/cat-obra/cat-obra.routes.js'


const app = new Hono()

// ── Middleware global ──
app.use('*', logger())
app.use('*', cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  credentials: true,
}))

// ── Rutas públicas ──
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── Rutas protegidas ──
app.get('/api/me', authMiddleware, (c) => {
  const user = c.get('user')
  return c.json({ user })
})

// Rutas
app.route('/api/categorias', categoriasRoutes)
app.route('/api/obras', obrasRoutes)
app.route('/api/personal', personalRoutes)
app.route('/api/horas', horasRoutes)
app.route('/api/asignaciones', asignacionesRoutes)
app.route('/api/cierres', cierresRoutes)
app.route('/api/tarifas', tarifasRoutes)
app.route('/api/contratistas', contratistasRoutes)
app.route('/api/logistica/choferes',      choferesRoutes)
app.route('/api/logistica/camiones',      camionesRoutes)
app.route('/api/logistica/lugares',       lugaresRoutes)
app.route('/api/logistica/viajes',        viajesRoutes)
app.route('/api/logistica/liquidaciones', liquidacionesRoutes)
app.route('/api/logistica/tramos',        tramosRoutes)
app.route('/api/me', authRoutes)
app.route('/api/usuarios', usuariosRoutes)
app.route('/api/herramientas', herramientasRoutes)
app.route('/api/cat-obra', catObraRoutes)
// ── Manejo global de errores ──
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  console.error('Error no manejado:', err)
  return c.json({ error: 'Error interno del servidor' }, 500)
})

// ── 404 ──
app.notFound((c) => {
  return c.json({ error: `Ruta no encontrada: ${c.req.path}` }, 404)
})




const port = Number(process.env.PORT) || 3001
console.log(`🚀 tarjaobra-backend corriendo en puerto ${port}`)

serve({ fetch: app.fetch, port })