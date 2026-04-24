import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'
import { solicitudesService, HttpError } from './solicitudes.service.js'
import {
  CreateSolicitudSchema, UpdateSolicitudSchema,
  ComprarItemSchema, DespacharItemSchema, EnviarItemSchema, EditarItemSchema,
} from './solicitudes.schema.js'

// Variable de contexto usada por el gate de despacho forzado.
// Declaration merging: se suma a las variables declaradas en auth.ts.
declare module 'hono' {
  interface ContextVariableMap {
    forzarSinStock: boolean
  }
}

const solicitudes = new Hono()
solicitudes.use('*', authMiddleware)
solicitudes.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
solicitudes.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
solicitudes.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
solicitudes.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

// ── Solicitudes CRUD ──
solicitudes.get('/', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return c.json(await solicitudesService.getAll(c.get('accessToken'), obra_cod))
})

solicitudes.get('/:id', async (c) => {
  return c.json(await solicitudesService.getById(Number(c.req.param('id')), c.get('accessToken')))
})

solicitudes.post('/', zValidator('json', CreateSolicitudSchema), async (c) => {
  try {
    const dto = c.req.valid('json')
    const data = await solicitudesService.create(dto, c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    console.error('[POST /solicitudes] ERROR:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

solicitudes.patch('/:id', zValidator('json', UpdateSolicitudSchema), async (c) => {
  const data = await solicitudesService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id)
  return c.json(data)
})

solicitudes.delete('/:id', async (c) => {
  return c.json(await solicitudesService.delete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// Helper: las acciones de ítems devuelven 404 si no encuentran el ítem.
// Si el service lanza HttpError (camino RPC con error mapeado), respetamos
// status/code/detail. Si es un Error común (camino legacy), mantenemos el
// mapeo histórico por mensaje.
function itemHandler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return c.json(data)
    } catch (err: any) {
      if (err instanceof HttpError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      if (err.message?.includes('no encontrado') || err.message?.includes('ya fue')) {
        return c.json({ error: err.message }, 404)
      }
      return c.json({ error: err.message }, 500)
    }
  }
}

// Lee `profiles.permisos` del usuario y evalúa si tiene un permiso ad-hoc.
// Útil para chequeos condicionales al body (ej. forzar_sin_stock) que no
// pueden expresarse con un middleware estático.
async function tienePermisoExtra(userId: string, modulo: string, flag: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('rol, permisos')
    .eq('id', userId)
    .single()
  if (!profile) return false
  if (profile.rol === 'admin') return true
  const permisos = profile.permisos as Record<string, Record<string, boolean>> | null
  return permisos?.[modulo]?.[flag] === true
}

// ── Acciones sobre ítems ──
solicitudes.post('/items/:itemId/comprar', zValidator('json', ComprarItemSchema), itemHandler(async (c) => {
  return solicitudesService.comprarItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
}))

// POST /items/:itemId/despachar
// Cadena de middlewares:
//   1. zValidator              → parsea el body.
//   2. gate de permiso extra   → si body.forzar_sin_stock, requiere
//      certificaciones.forzar_despacho; guarda el flag en el context.
//   3. itemHandler             → invoca el service y mapea errores
//      igual que los demás endpoints de /items (DRY).
solicitudes.post('/items/:itemId/despachar',
  zValidator('json', DespacharItemSchema),
  async (c, next) => {
    const body = c.req.valid('json')
    const forzar = body.forzar_sin_stock === true
    if (forzar) {
      const tiene = await tienePermisoExtra(
        c.get('user').id, 'certificaciones', 'forzar_despacho',
      )
      if (!tiene) return c.json({ error: 'SIN_PERMISO_FORZAR' }, 403)
    }
    // Flag autorizado: guardarlo en el context para el handler final.
    c.set('forzarSinStock', forzar)
    await next()
  },
  itemHandler(async (c) => {
    return solicitudesService.despacharItem(
      Number(c.req.param('itemId')),
      c.req.valid('json'),
      c.get('accessToken'),
      c.get('user').id,
      c.get('forzarSinStock') ?? false,
    )
  }),
)

solicitudes.post('/items/:itemId/enviar', zValidator('json', EnviarItemSchema), itemHandler(async (c) => {
  return solicitudesService.enviarItem(
    Number(c.req.param('itemId')), c.req.valid('json').fecha_envio, c.get('accessToken')
  )
}))

solicitudes.post('/items/:itemId/rechazar', itemHandler(async (c) => {
  return solicitudesService.rechazarItem(
    Number(c.req.param('itemId')), c.get('accessToken')
  )
}))

solicitudes.post('/items/:itemId/revertir', itemHandler(async (c) => {
  return solicitudesService.revertirItem(
    Number(c.req.param('itemId')), c.get('accessToken')
  )
}))

solicitudes.patch('/items/:itemId', zValidator('json', EditarItemSchema), itemHandler(async (c) => {
  return solicitudesService.editarItem(
    Number(c.req.param('itemId')), c.req.valid('json'), c.get('accessToken'), c.get('user').id
  )
}))

export default solicitudes
