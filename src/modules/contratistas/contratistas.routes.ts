import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag } from '../../middleware/permission.js'
import { contratistasService } from './contratistas.service.js'
import {
  CreateContratistaSchema,
  UpdateContratistaSchema,
  AsigContratistaSchema,
  CertificacionSchema,
  DniUploadUrlSchema,
  DniRegistrarSchema,
} from './contratistas.schema.js'
import { createSupabaseClient } from '../../lib/supabase.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const contratistas = new Hono()

contratistas.use('*', authMiddleware)

// ── CRUD Contratistas ──
// El catálogo de contratistas es transversal (no per-obra), pero la edición
// es de jefatura, así que el capataz puede leer pero no mutar.
contratistas.get('/', requirePermiso('tarja', 'lectura'), async (c) => {
  const token = c.get('accessToken')
  const data = await contratistasService.getAll(token)
  return c.json(data)
})

contratistas.get('/:id', requirePermiso('tarja', 'lectura'), async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const data = await contratistasService.getById(id, token)
  return c.json(data)
})

contratistas.post(
  '/',
  requirePermiso('tarja', 'creacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', CreateContratistaSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await contratistasService.create(dto, token, userId)
    return c.json(data, 201)
  },
)

contratistas.patch(
  '/:id',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UpdateContratistaSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    const data = await contratistasService.update(id, dto, token, userId)
    return c.json(data)
  },
)

contratistas.delete(
  '/:id',
  requirePermiso('tarja', 'eliminacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const token = c.get('accessToken')
    const data = await contratistasService.delete(id, token)
    return c.json(data)
  },
)

// ── DNI adjunto del contratista (foto/PDF, bucket contratista-docs) ──
// Mismo gating que la edición del contratista (jefatura con ver_pii). El DNI
// es PII → el GET de la URL firmada también exige ver_pii.
contratistas.post(
  '/:id/dni/upload-url',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', DniUploadUrlSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const data = await contratistasService.dniUploadUrl(id, c.req.valid('json'))
    return c.json(data)
  },
)

contratistas.post(
  '/:id/dni',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', DniRegistrarSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const data = await contratistasService.dniRegistrar(id, c.req.valid('json'), c.get('user').id, c.get('accessToken'))
    return c.json(data, 201)
  },
)

contratistas.get(
  '/:id/dni/signed-url',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const data = await contratistasService.dniSignedUrl(id, c.get('accessToken'))
    return c.json(data)
  },
)

contratistas.delete(
  '/:id/dni',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    const data = await contratistasService.dniDelete(id, c.get('accessToken'), c.get('user').id)
    return c.json(data)
  },
)

// ── Asignaciones a obras ──
contratistas.get('/asig/:obraCod', requirePermiso('tarja', 'lectura'), async (c) => {
  const obraCod = c.req.param('obraCod')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')
  const data = await contratistasService.getAsigByObra(obraCod, token)
  return c.json(data)
})

contratistas.post('/asig', requirePermiso('tarja', 'actualizacion'), requireFlag('tarja', 'ver_pii', true), zValidator('json', AsigContratistaSchema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
  const data = await contratistasService.asignar(dto, token, userId)
  return c.json(data, 201)
})

contratistas.delete('/asig/:obraCod/:contratId', requirePermiso('tarja', 'actualizacion'), requireFlag('tarja', 'ver_pii', true), async (c) => {
  const obraCod = c.req.param('obraCod')
  const contratId = Number(c.req.param('contratId'))
  if (isNaN(contratId)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const userId = c.get('user').id
  await validarObraDelUsuario(userId, obraCod, 'tarja')
  const data = await contratistasService.desasignar(obraCod, contratId, token)
  return c.json(data)
})

// ── Certificaciones ──
// Las certificaciones exponen montos: capataz NO ve.
contratistas.get(
  '/cert/all',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true, true),
  async (c) => {
    const userId = c.get('user').id
    const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
    if (allowed != null && allowed.length === 0) return c.json([])

    const supabase = createSupabaseClient(c.get('accessToken'))
    const { data, error } = allowed != null
      ? await supabase.rpc('certificaciones_de_obras', { p_obras: allowed })
      : await supabase.from('certificaciones').select('*').range(0, 99999)
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  },
)

contratistas.get(
  '/cert/:obraCod',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true, true),
  async (c) => {
    const obraCod = c.req.param('obraCod')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, obraCod, 'tarja')
    const data = await contratistasService.getCertByObra(obraCod, token)
    return c.json(data)
  },
)

// PUT /cert — registrar/actualizar montos certificados: jefatura.
contratistas.put(
  '/cert',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', CertificacionSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
    const data = await contratistasService.upsertCert(dto, token, userId)
    return c.json(data)
  },
)

export default contratistas
