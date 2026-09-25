/**
 * Catálogos compartidos (montado en `/api/catalogos`, tanda 6, 20260929f).
 *
 * Jurisdicciones: las usan Compras (tributos de la factura) y Ventas
 * (retenciones), y Contabilidad las muestra en los mapeos.
 *   - GET: lectura en pagos, facturacion O contabilidad.
 *   - POST/PATCH: flag `configurar` en pagos O en facturacion (admin
 *     bypasea). La RPC lo vuelve a chequear. Sin DELETE: se desactivan.
 *     No pide tab: el editor vive en las dos Configuraciones.
 */
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermisoOr, tieneFlag } from '../../middleware/permission.js'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import {
  CatalogosHttpError, JurisdiccionCreateSchema, JurisdiccionUpdateSchema, jurisdiccionesService,
} from './catalogos.service.js'

const cat = new Hono()
cat.use('*', authMiddleware)

const lectura = requirePermisoOr([
  { modulo: 'pagos', accion: 'lectura' },
  { modulo: 'facturacion', accion: 'lectura' },
  { modulo: 'contabilidad', accion: 'lectura' },
])

/** `configurar` en pagos o en facturacion (403 SIN_PERMISO { flag }, como requireFlag). */
const configurar = createMiddleware(async (c, next) => {
  const uid = c.get('user').id as string
  if (await tieneFlag(uid, 'pagos', 'configurar', false) || await tieneFlag(uid, 'facturacion', 'configurar', false)) {
    return next()
  }
  return c.json({ error: 'SIN_PERMISO', detail: { flag: 'configurar' } }, 403)
})

const db = (c: any) => {
  const t = c.get('accessToken') as string | undefined
  return t ? createSupabaseClient(t) : supabase
}
const uid = (c: any): string => c.get('user').id

function handler(fn: (c: any) => Promise<unknown>, status = 200) {
  return async (c: any) => {
    try {
      return c.json(await fn(c), status)
    } catch (err) {
      if (err instanceof CatalogosHttpError) {
        const d = err.detail as { campo?: unknown } | undefined
        const campo = d && typeof d === 'object' && typeof d.campo === 'string' ? d.campo : undefined
        return c.json({ error: err.code, ...(campo ? { campo } : {}), ...(err.detail !== undefined ? { detail: err.detail } : {}) }, err.status as any)
      }
      throw err
    }
  }
}

/** Validación del body → 400 JURISDICCION_INVALIDA { campo }. */
function valida<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      const campo = claves[0] ?? (issue?.path?.map(String).join('.') || null)
      return c.json({ error: 'JURISDICCION_INVALIDA', campo, detail: { campo, mensaje: issue?.message ?? 'dato inválido' } }, 400)
    }
  })
}

const idParam = (c: any) => {
  const n = Number(c.req.param('id'))
  if (!Number.isInteger(n) || n <= 0) throw new CatalogosHttpError(400, 'JURISDICCION_INVALIDA', { campo: 'id' })
  return n
}

const esBool = (v: string | undefined) => v === '1' || v === 'true'

cat.get('/jurisdicciones', lectura, handler(async (c) =>
  jurisdiccionesService.listar(esBool(c.req.query('incluir_inactivas')), db(c))))

cat.get('/jurisdicciones/sin-normalizar', lectura, handler(async (c) =>
  jurisdiccionesService.sinNormalizar(db(c))))

cat.post('/jurisdicciones', lectura, configurar, valida(JurisdiccionCreateSchema), handler(async (c) =>
  jurisdiccionesService.crear(c.req.valid('json'), uid(c), db(c)), 201))

cat.patch('/jurisdicciones/:id', lectura, configurar, valida(JurisdiccionUpdateSchema), handler(async (c) =>
  jurisdiccionesService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

export default cat
