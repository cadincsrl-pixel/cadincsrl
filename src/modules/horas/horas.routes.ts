import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, esCapataz } from '../../middleware/permission.js'
import { horasService } from './horas.service.js'
import { calcularCostoObra, viernesISO } from './costo-obra.js'
import { UpsertHoraSchema, UpsertHorasLoteSchema } from './horas.schema.js'
import { supabase, createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const horas = new Hono()

horas.use('*', authMiddleware)


horas.get('/all', requirePermiso('tarja', 'lectura'), async (c) => {
  // Usar cliente admin + paginación para superar el max-rows de PostgREST (1000 por defecto).
  const desde = c.req.query('desde')
  const hasta  = c.req.query('hasta')
  const userId = c.get('user').id

  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed != null && allowed.length === 0) return c.json([])

  const PAGE = 1000
  const all: any[] = []
  let from = 0

  while (true) {
    let q = supabase
      .from('horas')
      .select('*')
      .order('fecha')
      .range(from, from + PAGE - 1)
    if (desde) q = q.gte('fecha', desde)
    if (hasta)  q = q.lte('fecha', hasta)
    if (allowed != null) q = q.in('obra_cod', allowed)

    const { data, error } = await q
    if (error) return c.json({ error: error.message }, 500)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  return c.json(all)
})


// GET /costo-obra?obra_cod=X&desde=&hasta= — costo de MANO DE OBRA de una
// obra, semana por semana, con el cálculo canónico (ver costo-obra.ts).
// Nació para el bot de WhatsApp: "¿cuánto se gastó en la obra X?" no tenía
// endpoint y el bot respondía solo materiales (2026-08-06).
horas.get('/costo-obra',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true, true),
  async (c) => {
    const obraCod = c.req.query('obra_cod')
    if (!obraCod) return c.json({ error: 'OBRA_REQUERIDA' }, 400)
    const desde = c.req.query('desde')
    const hasta = c.req.query('hasta')
    const userId = c.get('user').id

    const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
    if (allowed != null && !allowed.includes(obraCod)) return c.json({ error: 'SIN_ACCESO_OBRA' }, 403)

    // Horas de la obra: cliente admin + paginación (puede superar 1000 filas).
    const PAGE = 1000
    const horasObra: any[] = []
    let from = 0
    while (true) {
      let q = supabase.from('horas')
        .select('leg, fecha, horas')
        .eq('obra_cod', obraCod)
        .gt('horas', 0)
        .order('fecha')
        .range(from, from + PAGE - 1)
      if (desde) q = q.gte('fecha', desde)
      if (hasta) q = q.lte('fecha', hasta)
      const { data, error } = await q
      if (error) return c.json({ error: error.message }, 500)
      if (!data || data.length === 0) break
      horasObra.push(...data)
      if (data.length < PAGE) break
      from += PAGE
    }

    const [extras, personal, categorias, tarifas, catObra] = await Promise.all([
      supabase.from('tarja_hs_extras').select('leg, sem_key, hs').eq('obra_cod', obraCod),
      supabase.from('personal').select('leg, cat_id, personal_cat_historial(cat_id, desde)'),
      supabase.from('categorias').select('id, vh, categoria_tarifas(vh, desde)'),
      supabase.from('tarifas').select('cat_id, vh, desde').eq('obra_cod', obraCod),
      supabase.from('cat_obra').select('leg, cat_id, desde').eq('obra_cod', obraCod),
    ])
    for (const r of [extras, personal, categorias, tarifas, catObra]) {
      if (r.error) return c.json({ error: r.error.message }, 500)
    }

    // hs_extras filtradas al rango pedido (por sem_key) si vino rango.
    let extrasRows = (extras.data ?? []) as { leg: string; sem_key: string; hs: number }[]
    if (desde) extrasRows = extrasRows.filter(e => e.sem_key.slice(0, 10) >= viernesISO(desde))
    if (hasta) extrasRows = extrasRows.filter(e => e.sem_key.slice(0, 10) <= hasta)

    // Hoy en hora argentina (UTC-3 fijo, sin DST): el server corre en UTC.
    const hoyISO = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)

    const resultado = calcularCostoObra({
      horas: horasObra,
      hsExtras: extrasRows,
      personal: (personal.data ?? []) as any,
      categorias: (categorias.data ?? []) as any,
      tarifas: (tarifas.data ?? []) as any,
      catObra: (catObra.data ?? []) as any,
      hoyISO,
    })

    return c.json({ obra_cod: obraCod, desde: desde ?? null, hasta: hasta ?? null, ...resultado })
  })


horas.get('/trabajador/:leg', requirePermiso('tarja', 'lectura'), async (c) => {
  const leg   = c.req.param('leg')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const supabase = createSupabaseClient(token)

  const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
  if (allowed != null && allowed.length === 0) return c.json([])

  let query = supabase
    .from('horas')
    .select('*')
    .eq('leg', leg)
    .order('fecha')

  if (desde) query = query.gte('fecha', desde)
  if (hasta) query = query.lte('fecha', hasta)
  if (allowed != null) query = query.in('obra_cod', allowed)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})


// GET /api/horas/:obraCod?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
horas.get('/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const token = c.get('accessToken')
  const userId = c.get('user').id

  await validarObraDelUsuario(userId, obraCod, 'tarja')

  if (desde && hasta) {
    const data = await horasService.getBySemana(obraCod, desde, hasta, token)
    return c.json(data)
  }

  const data = await horasService.getByObra(obraCod, token)
  return c.json(data)
})

// Helper: si el user es capataz puro, solo puede tocar horas con
// fecha = hoy (ni pasado ni futuro). Para el resto de roles no aplica.
// Se aplica en los endpoints PUT (upsert individual y lote). DELETE
// semana ya está bloqueado para capataces por requireFlag('ver_pii', true).
function fechaHoyArgentina(): string {
  // Server puede correr en UTC, capatazes operan en hora local de Argentina.
  // Forzamos timezone Argentina y devolvemos YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year:  'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

// PUT /api/horas — upsert individual
horas.put('/', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpsertHoraSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')

  // Capataz puede cargar SOLO el día actual.
  if (await esCapataz(userId) && dto.fecha !== fechaHoyArgentina()) {
    return c.json({
      error:  'FECHA_FUERA_DE_RANGO',
      detail: 'Como capataz solo podés cargar horas del día actual.',
    }, 403)
  }

  const data = await horasService.upsert(dto, token, userId)
  return c.json(data)
})

// PUT /api/horas/lote — upsert en lote
horas.put('/lote', requirePermiso('tarja', 'actualizacion'), zValidator('json', UpsertHorasLoteSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')

  if (await esCapataz(userId)) {
    const hoy = fechaHoyArgentina()
    const fueraDeRango = dto.horas.filter(h => h.fecha !== hoy)
    if (fueraDeRango.length > 0) {
      return c.json({
        error:  'FECHA_FUERA_DE_RANGO',
        detail: `Como capataz solo podés cargar horas del día actual (${hoy}). ${fueraDeRango.length} línea(s) están fuera del rango.`,
      }, 403)
    }
  }

  const data = await horasService.upsertLote(dto, token, userId)
  return c.json(data)
})

// DELETE /api/horas/:obraCod/semana?desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&leg=LEG]
// El capataz NO debería poder borrar la semana entera (solo carga horas).
horas.delete('/:obraCod/semana',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
  const obraCod = c.req.param('obraCod')
  const desde = c.req.query('desde')
  const hasta = c.req.query('hasta')
  const leg = c.req.query('leg')
  if (!desde || !hasta) return c.json({ error: 'Faltan parámetros desde/hasta' }, 400)
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')
  const supabase = createSupabaseClient(token)

  let q = supabase
    .from('horas')
    .delete()
    .eq('obra_cod', obraCod)
    .gte('fecha', desde)
    .lte('fecha', hasta)

  if (leg) q = q.eq('leg', leg)

  const { error } = await q
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
  },
)


export default horas
