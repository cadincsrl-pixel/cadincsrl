import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { stockService } from './stock.service.js'
import {
  CreateRubroSchema, UpdateRubroSchema,
  CreateMaterialSchema, UpdateMaterialSchema,
  CreateMovimientoSchema,
  RechazarAjusteSchema,
  ComprobanteUploadUrlSchema,
} from './stock.schema.js'
import { randomUUID } from 'crypto'
import { supabase as supabaseAdmin } from '../../lib/supabase.js'

const stock = new Hono()
stock.use('*', authMiddleware)
stock.on(['GET'],            '*', requirePermiso('certificaciones', 'lectura'))
stock.on(['POST'],           '*', requirePermiso('certificaciones', 'creacion'))
stock.on(['PATCH', 'PUT'],   '*', requirePermiso('certificaciones', 'actualizacion'))
stock.on(['DELETE'],         '*', requirePermiso('certificaciones', 'eliminacion'))

// ── Rubros ──
stock.get('/rubros', async (c) => {
  return c.json(await stockService.getRubros(c.get('accessToken')))
})

stock.post('/rubros', zValidator('json', CreateRubroSchema), async (c) => {
  return c.json(await stockService.createRubro(c.req.valid('json'), c.get('accessToken')), 201)
})

stock.patch('/rubros/:id', zValidator('json', UpdateRubroSchema), async (c) => {
  return c.json(await stockService.updateRubro(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken')))
})

// ── Materiales ──
stock.get('/materiales', async (c) => {
  const rubro_id = c.req.query('rubro_id')
  return c.json(await stockService.getMateriales(c.get('accessToken'), rubro_id ? Number(rubro_id) : undefined))
})

stock.post('/materiales', zValidator('json', CreateMaterialSchema), async (c) => {
  return c.json(await stockService.createMaterial(c.req.valid('json'), c.get('accessToken'), c.get('user').id), 201)
})

stock.patch('/materiales/:id', zValidator('json', UpdateMaterialSchema), async (c) => {
  return c.json(await stockService.updateMaterial(Number(c.req.param('id')), c.req.valid('json'), c.get('accessToken'), c.get('user').id))
})

stock.delete('/materiales/:id', async (c) => {
  return c.json(await stockService.deleteMaterial(Number(c.req.param('id')), c.get('accessToken'), c.get('user').id))
})

// ── Movimientos ──
stock.get('/movimientos', async (c) => {
  const material_id = c.req.query('material_id')
  return c.json(await stockService.getMovimientos(c.get('accessToken'), material_id ? Number(material_id) : undefined))
})

stock.post('/movimientos', zValidator('json', CreateMovimientoSchema), async (c) => {
  const dto = c.req.valid('json')
  // Cualquier usuario con `actualizacion` en certificaciones puede DECLARAR
  // un ajuste — el control real está en la aprobación posterior. Esto
  // permite al encargado del depósito (sin permiso de aprobar) declarar
  // diferencias sin pedir permiso a un admin.
  return c.json(await stockService.createMovimiento(dto, c.get('accessToken'), c.get('user').id), 201)
})

// ─────────────────────────────────────────────────────────────────────────
// Ajustes con doble aprobación
// ─────────────────────────────────────────────────────────────────────────

// Guard: requiere capacidad `aprobar_ajustes_stock` o ser admin.
async function requireAprobador(c: any): Promise<true | Response> {
  const supabase = createSupabaseClient(c.get('accessToken'))
  const { data: profile } = await supabase
    .from('profiles')
    .select('rol, permisos')
    .eq('id', c.get('user').id)
    .single()
  if (profile?.rol === 'admin') return true
  const perm = (profile?.permisos as any)?.certificaciones
  if (perm?.aprobar_ajustes_stock === true) return true
  return c.json({ error: 'No tenés permiso para aprobar ajustes de stock' }, 403)
}

// GET /api/stock/ajustes-pendientes — solo aprobadores ven la lista.
stock.get('/ajustes-pendientes', async (c) => {
  const guard = await requireAprobador(c)
  if (guard !== true) return guard
  return c.json(await stockService.listAjustesPendientes(c.get('accessToken')))
})

// POST /api/stock/movimientos/:id/aprobar
stock.post('/movimientos/:id/aprobar', async (c) => {
  const guard = await requireAprobador(c)
  if (guard !== true) return guard
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)
  try {
    const data = await stockService.aprobarAjuste(id, c.get('accessToken'), c.get('user').id)
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Error al aprobar' }, 400)
  }
})

// POST /api/stock/movimientos/:id/rechazar
stock.post('/movimientos/:id/rechazar', zValidator('json', RechazarAjusteSchema), async (c) => {
  const guard = await requireAprobador(c)
  if (guard !== true) return guard
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)
  const dto = c.req.valid('json')
  try {
    const data = await stockService.rechazarAjuste(id, dto.rechazo_motivo, c.get('accessToken'), c.get('user').id)
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Error al rechazar' }, 400)
  }
})

// ─────────────────────────────────────────────────────────────────────────
// Comprobantes de ajustes (bucket stock-ajustes-docs, privado)
// ─────────────────────────────────────────────────────────────────────────

const BUCKET_AJUSTES = 'stock-ajustes-docs'

// POST /api/stock/comprobante-upload-url — devuelve signed URL para subir foto/PDF.
stock.post('/comprobante-upload-url', zValidator('json', ComprobanteUploadUrlSchema), async (c) => {
  const dto    = c.req.valid('json')
  const userId = c.get('user').id

  // Validar mime y size acá también (el bucket ya lo valida pero damos mensaje claro).
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
  if (!ALLOWED.has(dto.mime_type))                  return c.json({ error: 'MIME_NO_PERMITIDO' }, 400)
  if (dto.size_bytes > 5 * 1024 * 1024)              return c.json({ error: 'TAMAÑO_INVALIDO'  }, 400)

  const ext  = dto.mime_type === 'application/pdf' ? 'pdf' : dto.mime_type.split('/')[1]
  const path = `ajuste/${userId}/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from(BUCKET_AJUSTES).createSignedUploadUrl(path)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ storage_path: path, token: data.token, signed_url: data.signedUrl })
})

// GET /api/stock/comprobante-url?path=... — signed URL de lectura (15 min).
stock.get('/comprobante-url', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path requerido' }, 400)
  const { data, error } = await supabaseAdmin.storage.from(BUCKET_AJUSTES).createSignedUrl(path, 900)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ url: data.signedUrl })
})

export default stock
