import { Hono } from 'hono'
import { authMiddleware } from '../../middleware/auth.js'
import { supabase } from '../../lib/supabase.js'
import { auditService } from './audit.service.js'
import { preciosService } from './precios.service.js'

const admin = new Hono()
admin.use('*', authMiddleware)

// Solo admins
admin.use('*', async (c, next) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('rol')
    .eq('id', c.get('user').id)
    .single()
  if (profile?.rol !== 'admin') {
    return c.json({ error: 'Acceso denegado' }, 403)
  }
  await next()
})

admin.get('/audit', async (c) => {
  const num = (v: string | undefined) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const { items, total } = await auditService.getAll({
    user_id: c.req.query('user_id') || undefined,
    modulo:  c.req.query('modulo') || undefined,
    accion:  c.req.query('accion') || undefined,
    q:       c.req.query('q') || undefined,
    desde:   c.req.query('desde') || undefined,
    hasta:   c.req.query('hasta') || undefined,
    excluir: (c.req.query('excluir') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    limit:   num(c.req.query('limit')),
    offset:  num(c.req.query('offset')),
  })
  // Paginado: `total` es el conteo con los mismos filtros, para que la
  // pantalla pueda decir "1–500 de 12.345" y pedir la página siguiente.
  return c.json({ items, total })
})

// GET /api/admin/precios — todo cambio de precio, de los dos orígenes.
// El dueño controlando a quien compra: quién tocó qué precio, cuándo y de
// cuánto a cuánto. Mismo criterio que /audit: solo admin (guarda del router).
admin.get('/precios', async (c) => {
  const num = (v: string | undefined) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const { items, total } = await preciosService.getAll({
    user_id:  c.req.query('user_id') || undefined,
    tipo:     c.req.query('tipo') || undefined,
    obra_cod: c.req.query('obra_cod') || undefined,
    fuente:   c.req.query('fuente') || undefined,
    q:        c.req.query('q') || undefined,
    desde:    c.req.query('desde') || undefined,
    hasta:    c.req.query('hasta') || undefined,
    limit:    num(c.req.query('limit')),
    offset:   num(c.req.query('offset')),
  })
  return c.json({ items, total })
})

export default admin
