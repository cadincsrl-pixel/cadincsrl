import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, tieneFlag } from '../../middleware/permission.js'
import { sinPii, contratistasService, ContratError } from './contratistas.service.js'
import {
  CreateContratistaSchema,
  UpdateContratistaSchema,
  AsigContratistaSchema,
  FinalizarAsigSchema,
  CreatePresupuestoSchema,
  UpdatePresupuestoSchema,
  CertificacionSchema,
  UpdateCertificacionSchema,
  DocUploadUrlSchema,
  DocRegistrarSchema,
} from './contratistas.schema.js'
import { getObrasDelUsuarioCached, validarObraDelUsuario } from '../../lib/obras-usuario.js'

const contratistas = new Hono()

contratistas.use('*', authMiddleware)

// Errores tipados del service → { error, code?, ...detail }. Cualquier otro
// error sigue hasta el handler global de index.ts.
contratistas.onError((err, c) => {
  if (err instanceof ContratError) {
    return c.json(
      { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.detail ?? {}) },
      err.status,
    )
  }
  throw err
})

// Los ids de presupuesto/certificación no traen la obra en la URL: el scope
// se valida buscando primero la fila (404 si no existe).
async function validarScopePresupuesto(c: Context, id: number): Promise<void> {
  const p = await contratistasService.getPresupuesto(id, c.get('accessToken'))
  await validarObraDelUsuario(c.get('user').id, p.obra_cod, 'tarja')
}

async function validarScopeCert(c: Context, id: number): Promise<void> {
  const cert = await contratistasService.getCert(id, c.get('accessToken'))
  await validarObraDelUsuario(c.get('user').id, cert.obra_cod, 'tarja')
}

// ── CRUD Contratistas ──
// El catálogo de contratistas es transversal (no per-obra), pero la edición
// es de jefatura, así que el capataz puede leer pero no mutar.
// Sin ver_pii (explícito en false) el catálogo sale sin dni/cuil/cuit/cbu/…
// Default true por back-compat con perfiles que no tienen el flag seteado.
contratistas.get('/', requirePermiso('tarja', 'lectura'), async (c) => {
  const token = c.get('accessToken')
  const verPii = await tieneFlag(c.get('user').id, 'tarja', 'ver_pii', true)
  const data = await contratistasService.getAll(token)
  return c.json(verPii ? data : data.map(sinPii))
})

contratistas.get('/:id', requirePermiso('tarja', 'lectura'), async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
  const token = c.get('accessToken')
  const verPii = await tieneFlag(c.get('user').id, 'tarja', 'ver_pii', true)
  const data = await contratistasService.getById(id, token)
  return c.json(verPii ? data : sinPii(data))
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
  zValidator('json', DocUploadUrlSchema),
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
  zValidator('json', DocRegistrarSchema),
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
// Sin montos (los presupuestos van por /presupuestos con ver_costos): el
// capataz recibe las asignaciones completas.
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

// Finalizar / reactivar al contratista en la obra (historial intacto).
contratistas.patch(
  '/asig/:obraCod/:contratId',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', FinalizarAsigSchema),
  async (c) => {
    const obraCod = c.req.param('obraCod')
    const contratId = Number(c.req.param('contratId'))
    if (isNaN(contratId)) return c.json({ error: 'ID inválido' }, 400)
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, obraCod, 'tarja')
    const data = await contratistasService.finalizarAsig(obraCod, contratId, dto.finalizado, token, userId)
    return c.json(data)
  },
)

// Desasignar solo sin historial; con certificaciones o presupuestos → 409
// ASIG_CON_HISTORIAL (el camino es PATCH finalizado).
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

// ── Presupuestos (contrat_presupuestos) ──
// Exponen montos: leer = ver_costos (capataz → 403); mutar = ver_pii. Las
// rutas del adjunto van antes de las paramétricas de un segmento.
contratistas.post(
  '/presupuestos/:id/doc/upload-url',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', DocUploadUrlSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopePresupuesto(c, id)
    const data = await contratistasService.presupDocUploadUrl(id, c.req.valid('json'))
    return c.json(data)
  },
)

contratistas.post(
  '/presupuestos/:id/doc',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', DocRegistrarSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopePresupuesto(c, id)
    const data = await contratistasService.presupDocRegistrar(
      id, c.req.valid('json'), c.get('user').id, c.get('accessToken'),
    )
    return c.json(data, 201)
  },
)

contratistas.get(
  '/presupuestos/:id/doc/signed-url',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true, true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopePresupuesto(c, id)
    const data = await contratistasService.presupDocSignedUrl(id, c.get('accessToken'))
    return c.json(data)
  },
)

contratistas.delete(
  '/presupuestos/:id/doc',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopePresupuesto(c, id)
    const data = await contratistasService.presupDocDelete(id, c.get('accessToken'), c.get('user').id)
    return c.json(data)
  },
)

contratistas.get(
  '/presupuestos/:obraCod',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true, true),
  async (c) => {
    const obraCod = c.req.param('obraCod')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, obraCod, 'tarja')
    const data = await contratistasService.getPresupuestosByObra(obraCod, token)
    return c.json(data)
  },
)

contratistas.post(
  '/presupuestos',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', CreatePresupuestoSchema),
  async (c) => {
    const dto = c.req.valid('json')
    const token = c.get('accessToken')
    const userId = c.get('user').id
    await validarObraDelUsuario(userId, dto.obra_cod, 'tarja')
    const data = await contratistasService.createPresupuesto(dto, token, userId)
    return c.json(data, 201)
  },
)

contratistas.patch(
  '/presupuestos/:id',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UpdatePresupuestoSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopePresupuesto(c, id)
    const data = await contratistasService.updatePresupuesto(id, c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data)
  },
)

contratistas.delete(
  '/presupuestos/:id',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopePresupuesto(c, id)
    const data = await contratistasService.deletePresupuesto(id, c.get('accessToken'))
    return c.json(data)
  },
)

// ── Certificaciones ──
// Las certificaciones exponen montos: capataz NO ve. /cert/all va antes de
// /cert/:obraCod para que "all" no se capture como código de obra.
contratistas.get(
  '/cert/all',
  requirePermiso('tarja', 'lectura'),
  requireFlag('tarja', 'ver_costos', true, true),
  async (c) => {
    const userId = c.get('user').id
    const allowed = await getObrasDelUsuarioCached(userId, 'tarja')
    if (allowed != null && allowed.length === 0) return c.json([])
    const data = await contratistasService.getCertAll(allowed, c.get('accessToken'))
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

// Corregir monto/desc o reimputar a otro presupuesto.
contratistas.patch(
  '/cert/:id',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  zValidator('json', UpdateCertificacionSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopeCert(c, id)
    const data = await contratistasService.updateCert(id, c.req.valid('json'), c.get('accessToken'), c.get('user').id)
    return c.json(data)
  },
)

// Reemplaza el viejo "poner el monto en 0".
contratistas.delete(
  '/cert/:id',
  requirePermiso('tarja', 'actualizacion'),
  requireFlag('tarja', 'ver_pii', true),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: 'ID inválido' }, 400)
    await validarScopeCert(c, id)
    const data = await contratistasService.deleteCert(id, c.get('accessToken'))
    return c.json(data)
  },
)

export default contratistas
