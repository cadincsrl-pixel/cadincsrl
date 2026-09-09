import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, puedeActualizarCatalogo } from '../../middleware/permission.js'
import { supabase } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached } from '../../lib/obras-usuario.js'
import { solicitudesService, HttpError } from './solicitudes.service.js'
import {
  CreateSolicitudSchema, UpdateSolicitudSchema,
  ComprarItemSchema, DespacharItemSchema, EnviarItemSchema, EditarItemSchema,
  ResolverStockClienteSchema, ProponerPrecioSchema, RechazarPrecioSchema,
} from './solicitudes.schema.js'

// Variable de contexto usada por el gate de despacho forzado.
// Declaration merging: se suma a las variables declaradas en auth.ts.
declare module 'hono' {
  interface ContextVariableMap {
    forzarSinStock: boolean
    sinPrecioAlResolver: boolean
  }
}

const solicitudes = new Hono()
solicitudes.use('*', authMiddleware)
solicitudes.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
solicitudes.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
solicitudes.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
solicitudes.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

// Helper: el service tira HttpError(403,'OBRA_SIN_ACCESO') cuando el user
// pidió/operó sobre una obra a la que no está asignado. Lo mapeamos a JSON.
function withAccess<T>(fn: () => Promise<T>) {
  return async (c: any) => {
    try {
      const data = await fn()
      return c.json(data)
    } catch (err: any) {
      if (err instanceof HttpError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      throw err
    }
  }
}

// ── Solicitudes CRUD ──
solicitudes.get('/', async (c) => {
  const obra_cod = c.req.query('obra_cod')
  return withAccess(() =>
    solicitudesService.getAll(c.get('accessToken'), c.get('user').id, obra_cod),
  )(c)
})

// GET /pendientes — vista liviana para la campana de notificaciones (id,
// obra, fecha, cantidad de ítems por comprar). Declarada ANTES de /:id
// para que "pendientes" no matchee como parámetro.
solicitudes.get('/pendientes', async (c) => {
  return withAccess(() =>
    solicitudesService.getPendientes(c.get('accessToken'), c.get('user').id),
  )(c)
})

solicitudes.get('/:id', async (c) => {
  return withAccess(() =>
    solicitudesService.getById(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id),
  )(c)
})

solicitudes.post('/', zValidator('json', CreateSolicitudSchema), async (c) => {
  try {
    const dto = c.req.valid('json')
    const data = await solicitudesService.create(dto, c.get('accessToken'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.code }
      if (err.detail !== undefined) body.detail = err.detail
      return c.json(body, err.status as any)
    }
    console.error('[POST /solicitudes] ERROR:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

solicitudes.patch('/:id', zValidator('json', UpdateSolicitudSchema), async (c) => {
  return withAccess(() =>
    solicitudesService.update(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id),
  )(c)
})

solicitudes.delete('/:id', async (c) => {
  return withAccess(() =>
    solicitudesService.delete(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id),
  )(c)
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

/**
 * ¿Esta persona puede tipear el precio al resolver? Default TRUE: el flag
 * `precio_al_resolver` se APAGA a propósito para quien maneja el depósito
 * pero no los números (Sosa, 09/09). Apagado, resuelve igual y el renglón
 * queda esperando precio para que lo cargue quien corresponde — antes ponía
 * "11" o "1" para salir del paso y eso terminaba facturado.
 */
async function puedePonerPrecioAlResolver(userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('profiles').select('rol, permisos').eq('id', userId).single()
  if (!profile) return false
  if (profile.rol === 'admin') return true
  const permisos = profile.permisos as Record<string, Record<string, unknown>> | null
  return permisos?.certificaciones?.precio_al_resolver !== false
}

// Guard: las acciones de resolución de items (comprar/despachar/enviar/
// rechazar/revertir) son del comprador o encargado de depósito, no del
// jefe de obra. Se chequea con el flag `certificaciones.resolver_items`.
async function requireResolverItems(c: any, next: any) {
  const tiene = await tienePermisoExtra(c.get('user').id, 'certificaciones', 'resolver_items')
  if (!tiene) return c.json({ error: 'SIN_PERMISO_RESOLVER' }, 403)
  await next()
}

// Guard: valida que el usuario tenga acceso a la obra de la solicitud del ítem.
// Las acciones de resolución operan sobre :itemId, no sobre la solicitud, así
// que requirePermiso (módulo) y requireResolverItems (flag) no alcanzan: un
// usuario con obras_scope acotado no debe resolver ítems de obras ajenas.
// Consistente con el obra-scope que ya validan getById/update/delete.
// Si getObrasDelUsuarioCached devuelve null (admin/sin restricción), pasa.
async function requireItemObraScope(c: any, next: any) {
  const allowed = await getObrasDelUsuarioCached(c.get('user').id, 'certificaciones')
  if (allowed != null) {
    const itemId = Number(c.req.param('itemId'))
    const { data, error } = await supabase
      .from('solicitud_compra_item')
      .select('solicitud_compra(obra_cod)')
      .eq('id', itemId)
      .maybeSingle()
    if (error) return c.json({ error: error.message }, 500)
    if (!data) return c.json({ error: 'ITEM_NO_EXISTE' }, 404)
    const obraCod = (data as any).solicitud_compra?.obra_cod
    if (!obraCod || !allowed.includes(obraCod)) {
      return c.json({ error: 'OBRA_SIN_ACCESO' }, 403)
    }
  }
  await next()
}

// ── Acciones sobre ítems ──

// GET /items/:itemId/eventos — historial de transiciones del ítem (timeline).
// Solo lectura: requirePermiso('certificaciones','lectura') ya aplica a GET /*
// (línea 23). Gateamos por obra con requireItemObraScope (no requiere
// resolver_items: ver el historial es lectura, no resolución).
solicitudes.get('/items/:itemId/eventos', requireItemObraScope, itemHandler(async (c) => {
  return solicitudesService.getItemEventos(Number(c.req.param('itemId')), c.get('accessToken'))
}))

// POST /items/:itemId/stock-cliente — resuelve el ítem con material del
// CLIENTE administrado en depósito (ledger stock_cliente). No factura: el
// material ya es del cliente (RPC resolver_item_stock_cliente, sin MCC).
solicitudes.post('/items/:itemId/stock-cliente', requireResolverItems, requireItemObraScope, zValidator('json', ResolverStockClienteSchema), itemHandler(async (c) => {
  return solicitudesService.resolverItemStockCliente(
    Number(c.req.param('itemId')), c.req.valid('json').stock_item_id, c.get('user').id
  )
}))

// GET /items/:itemId/sugerencia-precio?proveedor_id= — catalogo, ultima compra
// y ultima compra a este proveedor, con unidades y compatibilidad (20260911).
solicitudes.get('/items/:itemId/sugerencia-precio', requireItemObraScope, itemHandler(async (c) => {
  const prov = Number(c.req.query('proveedor_id'))
  return solicitudesService.sugerenciaPrecio(
    Number(c.req.param('itemId')), Number.isInteger(prov) && prov > 0 ? prov : null,
  )
}))

solicitudes.post('/items/:itemId/comprar', requireResolverItems, requireItemObraScope, zValidator('json', ComprarItemSchema), itemHandler(async (c) => {
  const dto = c.req.valid('json')
  if (dto.actualizar_catalogo && !(await puedeActualizarCatalogo(c.get('user').id))) {
    throw new HttpError(403, 'SIN_PERMISO_CATALOGO')
  }
  // Sin `precio_al_resolver` la compra entra SIN precio, marcada como
  // esperando: no se rechaza el pedido —la compra se hizo igual— y tampoco se
  // guarda un precio que esa persona no tiene por qué decidir.
  const conPrecio = await puedePonerPrecioAlResolver(c.get('user').id)
  const limpio = conPrecio ? dto : { ...dto, precio_unit: 0, esperando_precio: true, actualizar_catalogo: false }
  return solicitudesService.comprarItem(
    Number(c.req.param('itemId')), limpio, c.get('accessToken'), c.get('user').id
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
  requireResolverItems,
  requireItemObraScope,
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
    // Sin `precio_al_resolver`, el despacho va en 0 y queda a tasar (que es
    // lo que el despacho ya admitía; acá se vuelve obligatorio para esa
    // persona en vez de depender de que se acuerde).
    c.set('sinPrecioAlResolver', !(await puedePonerPrecioAlResolver(c.get('user').id)))
    await next()
  },
  itemHandler(async (c) => {
    const body = c.req.valid('json')
    return solicitudesService.despacharItem(
      Number(c.req.param('itemId')),
      c.get('sinPrecioAlResolver') ? { ...body, precio_unit: 0 } : body,
      c.get('accessToken'),
      c.get('user').id,
      c.get('forzarSinStock') ?? false,
    )
  }),
)

// POST /items/:itemId/recibir-devolucion
// La obra devuelve una herramienta al pañol. No pasa por comprar/despachar:
// ver el comentario largo en solicitudesService.recibirDevolucion.
solicitudes.post('/items/:itemId/recibir-devolucion', requireResolverItems, requireItemObraScope, itemHandler(async (c) => {
  return solicitudesService.recibirDevolucion(
    Number(c.req.param('itemId')), c.get('accessToken'), c.get('user').id
  )
}))

solicitudes.post('/items/:itemId/enviar', requireResolverItems, requireItemObraScope, zValidator('json', EnviarItemSchema), itemHandler(async (c) => {
  return solicitudesService.enviarItem(
    Number(c.req.param('itemId')), c.req.valid('json').fecha_envio, c.get('accessToken'), c.get('user').id
  )
}))

solicitudes.post('/items/:itemId/rechazar', requireResolverItems, requireItemObraScope, itemHandler(async (c) => {
  return solicitudesService.rechazarItem(
    Number(c.req.param('itemId')), c.get('accessToken'), c.get('user').id
  )
}))

solicitudes.post('/items/:itemId/revertir', requireResolverItems, requireItemObraScope, itemHandler(async (c) => {
  return solicitudesService.revertirItem(
    Number(c.req.param('itemId')), c.get('accessToken'), c.get('user').id
  )
}))

// POST /items/:itemId/comprar-faltante — parte un ítem de_deposito con envío
// parcial: el original se cierra por lo enviado (devolviendo el resto al
// stock) y nace un ítem nuevo pendiente por el faltante, para comprarlo.
// RPC transaccional comprar_faltante_item (migración 20260806b).
solicitudes.post('/items/:itemId/comprar-faltante', requireResolverItems, requireItemObraScope, itemHandler(async (c) => {
  return solicitudesService.comprarFaltanteItem(
    Number(c.req.param('itemId')), c.get('user').id
  )
}))

// POST /items/:itemId/revertir-envio — deshace SOLO el envío: el item vuelve
// a su estado previo (comprado/de_deposito), manteniendo la compra. Limpia
// fecha_envio y desvincula del remito (borra el remito si queda vacío).
solicitudes.post('/items/:itemId/revertir-envio', requireResolverItems, requireItemObraScope, itemHandler(async (c) => {
  return solicitudesService.revertirEnvioItem(
    Number(c.req.param('itemId')), c.get('accessToken'), c.get('user').id
  )
}))

// PATCH /items/:itemId — edita campos de items YA resueltos (ej. corregir
// precio o proveedor luego de comprado). Es del comprador, no del jefe.
//
// Los campos que mueven LA CUENTA DEL CLIENTE (precio_unit y pagado_por)
// exigen además el flag certificaciones.cargar_precios — pedido del user
// (08/09): tocar lo que se le cobra a un cliente es decisión suya, no del
// comprador. Chequeo condicional al body, como forzar_sin_stock: proveedor y
// factura siguen siendo del comprador con resolver_items.
solicitudes.patch('/items/:itemId', requireResolverItems, requireItemObraScope, zValidator('json', EditarItemSchema), itemHandler(async (c) => {
  const dto = c.req.valid('json')
  if (dto.precio_unit !== undefined || dto.pagado_por !== undefined || dto.unidad !== undefined || dto.cantidad !== undefined) {
    const puede = await tienePermisoExtra(c.get('user').id, 'certificaciones', 'cargar_precios')
    if (!puede) throw new HttpError(403, 'SIN_PERMISO_CARGAR_PRECIOS')
  }
  return solicitudesService.editarItem(
    Number(c.req.param('itemId')), dto, c.get('accessToken'), c.get('user').id
  )
}))

// ─────────────────────────────────────────────────────────────────────────
// Precios propuestos: los carga quien compra, los aprueba el dueño (20260912o)
// ─────────────────────────────────────────────────────────────────────────
//
// Sin esto, el que tiene el dato choca contra el 403 de cargar_precios y el
// precio no entra nunca: Nicolás compra en cuenta corriente y POLLANO le pasa
// la cuenta una semana después. Proponer NO mueve la cuenta del cliente.

/** Guard del que aprueba: el mismo flag que ya permite cargar precios. */
async function requireCargarPrecios(c: any, next: any) {
  const puede = await tienePermisoExtra(c.get('user').id, 'certificaciones', 'cargar_precios')
  if (!puede) return c.json({ error: 'SIN_PERMISO_CARGAR_PRECIOS' }, 403)
  await next()
}

// GET /items/precios-propuestos — la bandeja del que aprueba.
solicitudes.get('/items/precios-propuestos', requireCargarPrecios, async (c) => {
  return c.json(await solicitudesService.listarPreciosPropuestos(c.get('accessToken')))
})

// POST /items/:itemId/proponer-precio — lo puede hacer quien resuelve compras.
solicitudes.post('/items/:itemId/proponer-precio',
  requireResolverItems, requireItemObraScope,
  zValidator('json', ProponerPrecioSchema), itemHandler(async (c) => {
  const dto = c.req.valid('json')
  return solicitudesService.proponerPrecio(
    Number(c.req.param('itemId')), dto.precio_unit, dto.obs ?? null,
    c.get('accessToken'), c.get('user').id,
  )
}))

// POST /items/:itemId/aprobar-precio · /rechazar-precio — solo el aprobador.
solicitudes.post('/items/:itemId/aprobar-precio', requireCargarPrecios, itemHandler(async (c) => {
  return solicitudesService.aprobarPrecio(
    Number(c.req.param('itemId')), c.get('accessToken'), c.get('user').id,
  )
}))

solicitudes.post('/items/:itemId/rechazar-precio',
  requireCargarPrecios, zValidator('json', RechazarPrecioSchema), itemHandler(async (c) => {
  return solicitudesService.rechazarPrecio(
    Number(c.req.param('itemId')), c.req.valid('json').motivo,
    c.get('accessToken'), c.get('user').id,
  )
}))

export default solicitudes
