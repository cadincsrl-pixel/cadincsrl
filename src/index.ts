import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware } from './middleware/auth.js'
import { auditMiddleware } from './middleware/audit.js'


import categoriasRoutes from './modules/categorias/categorias.routes.js'
import obrasRoutes from './modules/obras/obras.routes.js'
import personalRoutes from './modules/personal/personal.routes.js'
import horasRoutes from './modules/horas/horas.routes.js'
import hsExtrasRoutes from './modules/hs-extras/hs-extras.routes.js'
import asignacionesRoutes from './modules/asignaciones/asignaciones.routes.js'
import cierresRoutes from './modules/cierres/cierres.routes.js'
import tarifasRoutes from './modules/tarifas/tarifas.routes.js'
import contratistasRoutes from './modules/contratistas/contratistas.routes.js'
import choferesRoutes     from './modules/logistica/choferes/choferes.routes.js'
import camionesRoutes     from './modules/logistica/camiones/camiones.routes.js'
import bateasRoutes        from './modules/logistica/bateas/bateas.routes.js'
import lugaresRoutes      from './modules/logistica/lugares/lugares.routes.js'
import viajesRoutes       from './modules/logistica/viajes/viajes.routes.js'
import liquidacionesRoutes from './modules/logistica/liquidaciones/liquidaciones.routes.js'
import tramosRoutes        from './modules/logistica/tramos/tramos.routes.js'
import logTarifasRoutes    from './modules/logistica/tarifas/tarifas.routes.js'
import empresasRoutes      from './modules/logistica/empresas/empresas.routes.js'
import cobrosRoutes        from './modules/logistica/cobros/cobros.routes.js'
import gastosLogRoutes     from './modules/logistica/gastos/gastos.routes.js'
import rentabilidadRoutes  from './modules/logistica/rentabilidad/rentabilidad.routes.js'
import logNotifRoutes      from './modules/logistica/notificaciones/notificaciones.routes.js'
import camionServicesRoutes from './modules/logistica/camion-services/camion-services.routes.js'
import gpsSyncRoutes        from './modules/logistica/gps-sync/gps-sync.routes.js'
import gpsInternalRoutes    from './modules/logistica/gps-sync/gps-sync.internal.routes.js'
import mapsRoutes           from './modules/logistica/maps/maps.routes.js'
import authRoutes from './modules/auth/auth.routes.js'
import usuariosRoutes from './modules/auth/usuarios.routes.js'
import herramientasRoutes from './modules/herramientas/herramientas.routes.js'
import catObraRoutes from './modules/cat-obra/cat-obra.routes.js'
import certificacionesRoutes from './modules/certificaciones/certificaciones.routes.js'
import solicitudesRoutes from './modules/solicitudes/solicitudes.routes.js'
import proveedoresRoutes from './modules/proveedores/proveedores.routes.js'
import facturasCompraRoutes from './modules/facturas-compra/facturas-compra.routes.js'
import stockRoutes from './modules/stock/stock.routes.js'
import stockProveedorRoutes from './modules/stock-proveedor/stock-proveedor.routes.js'
import adminRoutes from './modules/admin/admin.routes.js'
import remitosEnvioRoutes from './modules/remitos-envio/remitos-envio.routes.js'
import { cajaRoutes } from './modules/caja/caja.routes.js'
import flotaRoutes from './modules/flota/flota.routes.js'
import flotaGpsInternalRoutes from './modules/flota/gps-sync/flota-gps-sync.internal.routes.js'


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

// Audit middleware — loguea acciones POST/PATCH/DELETE exitosas
// Debe declararse ANTES de las rutas para que Hono lo encadene
app.use('/api/*', auditMiddleware)

// Rutas
app.route('/api/categorias', categoriasRoutes)
app.route('/api/obras', obrasRoutes)
app.route('/api/personal', personalRoutes)
app.route('/api/horas', horasRoutes)
app.route('/api/hs-extras', hsExtrasRoutes)
app.route('/api/asignaciones', asignacionesRoutes)
app.route('/api/cierres', cierresRoutes)
app.route('/api/tarifas', tarifasRoutes)
app.route('/api/contratistas', contratistasRoutes)
app.route('/api/logistica/choferes',      choferesRoutes)
app.route('/api/logistica/camiones',      camionesRoutes)
app.route('/api/logistica/bateas',         bateasRoutes)
app.route('/api/logistica/lugares',       lugaresRoutes)
app.route('/api/logistica/viajes',        viajesRoutes)
app.route('/api/logistica/liquidaciones', liquidacionesRoutes)
app.route('/api/logistica/tramos',        tramosRoutes)
app.route('/api/logistica/tarifas',       logTarifasRoutes)
app.route('/api/logistica/empresas',      empresasRoutes)
app.route('/api/logistica/cobros',        cobrosRoutes)
app.route('/api/logistica/gastos',        gastosLogRoutes)
app.route('/api/logistica/rentabilidad',  rentabilidadRoutes)
app.route('/api/logistica/notificaciones', logNotifRoutes)
app.route('/api/logistica/camion-services', camionServicesRoutes)
app.route('/api/logistica/gps',             gpsSyncRoutes)
app.route('/api/logistica/maps',            mapsRoutes)
app.route('/api/internal',                  gpsInternalRoutes)
app.route('/api/internal',                  flotaGpsInternalRoutes)
app.route('/api/me', authRoutes)
app.route('/api/usuarios', usuariosRoutes)
app.route('/api/herramientas', herramientasRoutes)
app.route('/api/cat-obra', catObraRoutes)
app.route('/api/certificaciones', certificacionesRoutes)
app.route('/api/solicitudes', solicitudesRoutes)
app.route('/api/proveedores', proveedoresRoutes)
app.route('/api/facturas-compra', facturasCompraRoutes)
app.route('/api/stock', stockRoutes)
app.route('/api/stock-proveedor', stockProveedorRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/remitos-envio', remitosEnvioRoutes)
app.route('/api/caja', cajaRoutes)
app.route('/api/flota', flotaRoutes)

// ── Manejo global de errores ──
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  console.error('Error no manejado:', err.message, err.stack)
  return c.json({ error: err.message || 'Error interno del servidor' }, 500)
})

// ── 404 ──
app.notFound((c) => {
  return c.json({ error: `Ruta no encontrada: ${c.req.path}` }, 404)
})




const port = Number(process.env.PORT) || 3001
console.log(`🚀 tarjaobra-backend corriendo en puerto ${port}`)

serve({ fetch: app.fetch, port })