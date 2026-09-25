/**
 * Datos de la empresa (montado en `/api/empresa`, tanda 6, 20260929a).
 *
 * - GET: cualquier usuario logueado (los PDF de todos los módulos imprimen la
 *   razón social, el CUIT y el domicilio). Cache-Control privado de 5 min.
 * - PATCH: tab `admin.empresa` + flag `admin.configurar` (default false; el
 *   admin bypasea). La RPC vuelve a chequear el flag y rechaza el CUIT.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireFlag, requireTab } from '../../middleware/permission.js'
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { EmpresaHttpError, EmpresaPatchSchema, empresaService } from './empresa.service.js'

const empresa = new Hono()
empresa.use('*', authMiddleware)

const db = (c: any) => {
  const t = c.get('accessToken') as string | undefined
  return t ? createSupabaseClient(t) : supabase
}

function handler(fn: (c: any) => Promise<unknown>) {
  return async (c: any) => {
    try {
      return c.json(await fn(c))
    } catch (err) {
      if (err instanceof EmpresaHttpError) {
        const d = err.detail as { campo?: unknown } | undefined
        const campo = d && typeof d === 'object' && typeof d.campo === 'string' ? d.campo : undefined
        return c.json({ error: err.code, ...(campo ? { campo } : {}), ...(err.detail !== undefined ? { detail: err.detail } : {}) }, err.status as any)
      }
      throw err
    }
  }
}

empresa.get('/', async (c) => {
  c.header('Cache-Control', 'private, max-age=300')
  return c.json(await empresaService.obtener())
})

empresa.patch('/',
  requireTab('admin', 'empresa'),
  requireFlag('admin', 'configurar'),
  zValidator('json', EmpresaPatchSchema, (r, c) => {
    if (!r.success) {
      const issue = r.error.issues[0]
      const campo = issue?.path?.map(String).join('.') || null
      // Clave desconocida (strict): `cuit` tiene su propio código.
      const claves = issue?.code === 'unrecognized_keys' ? ((issue as { keys?: string[] }).keys ?? []) : []
      if (claves.includes('cuit')) return c.json({ error: 'CUIT_NO_EDITABLE' }, 400)
      const c2 = claves[0] ?? campo
      return c.json({ error: 'EMPRESA_INVALIDA', campo: c2, detail: { campo: c2, mensaje: issue?.message } }, 400)
    }
  }),
  handler(async (c) => empresaService.guardar(db(c), c.req.valid('json'), c.get('user').id)),
)

export default empresa
