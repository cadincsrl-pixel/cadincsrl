/**
 * Factory de rutas de services. Se monta CUATRO veces, una por entidad, cada
 * una bajo el router de su módulo y con sus permisos:
 *   /api/flota/vehiculos     (flota)
 *   /api/logistica/camiones  (logistica)
 *   /api/alquiler/maquinas   (alquiler)
 *   /api/aridos/unidades     (aridos)
 *
 * Mismo molde que `documentos/entidad-docs.routes.ts`: el módulo de permisos
 * sale de `entidadServicioInfo()`, así que sumar una entidad es una entrada en
 * ese mapa más el `route()` de su módulo.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import {
  serviciosService, entidadServicioInfo, ServicioError, type EntidadServicio,
} from './servicios.service.js'

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const CamposServicio = {
  tipo_id:         z.number().int().positive().nullable().optional(),
  tipo_libre:      z.string().min(1).max(120).nullable().optional(),
  fecha:           FECHA,
  medidor_valor:   z.number().min(0).nullable().optional(),
  medidor_proximo: z.number().min(0).nullable().optional(),
  fecha_proximo:   FECHA.nullable().optional(),
  descripcion:     z.string().max(500).nullable().optional(),
  costo:           z.number().min(0).nullable().optional(),
  proveedor:       z.string().max(160).nullable().optional(),
  obs:             z.string().max(500).nullable().optional(),
}

const CrearSchema = z.object(CamposServicio).refine(
  d => d.tipo_id != null || (d.tipo_libre ?? '').trim() !== '', {
  // Espejo del CHECK `servicios_tipo_chk`: sin este refine el body llegaba a
  // Postgres y volvía un 500 con el texto crudo del constraint.
  message: 'Elegí un tipo de service o escribí uno',
  path: ['tipo_id'],
})

// El PATCH no lleva el refine: se puede editar solo el costo sin re-mandar el
// tipo. La regla del CHECK ya la garantiza la fila que existe.
const EditarSchema = z.object(CamposServicio).partial()

const UploadUrlSchema = z.object({
  mime_type:  z.string().min(1),
  size_bytes: z.number().int().positive(),
})

const RegistrarSchema = z.object({ storage_path: z.string().min(1) })

function handle<T>(fn: (c: any) => Promise<T>) {
  return async (c: any) => {
    try {
      return c.json(await fn(c))
    } catch (err) {
      if (err instanceof ServicioError) {
        const body: Record<string, unknown> = { error: err.code }
        if (err.detail !== undefined) body.detail = err.detail
        return c.json(body, err.status as any)
      }
      return c.json({ error: (err as Error).message ?? 'UNKNOWN' }, 500)
    }
  }
}

export function buildServiciosRoutes(entidad: EntidadServicio): Hono {
  const r = new Hono()
  const { modulo } = entidadServicioInfo(entidad)
  const id    = (c: any) => Number(c.req.param('id'))
  const servId = (c: any) => Number(c.req.param('servId'))

  r.use('*', authMiddleware)

  // Catálogo de tipos. Va bajo la entidad para no inventar un endpoint global
  // que habría que gatear aparte.
  r.get('/tipos-servicio', requirePermiso(modulo, 'lectura'),
    handle(c => serviciosService.getTipos(c.get('accessToken'))))

  // Semáforo de TODAS las entidades de este módulo (sin :id).
  r.get('/servicios/estado', requirePermiso(modulo, 'lectura'),
    handle(c => serviciosService.estado(c.get('accessToken'), entidad)))

  r.get('/:id/servicios', requirePermiso(modulo, 'lectura'),
    handle(c => serviciosService.listar(entidad, id(c), c.get('accessToken'))))

  r.get('/:id/servicios/estado', requirePermiso(modulo, 'lectura'),
    handle(c => serviciosService.estado(c.get('accessToken'), entidad, id(c))))

  r.post('/:id/servicios', requirePermiso(modulo, 'creacion'),
    zValidator('json', CrearSchema),
    handle(c => serviciosService.crear(
      entidad, id(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

  r.patch('/:id/servicios/:servId', requirePermiso(modulo, 'actualizacion'),
    zValidator('json', EditarSchema),
    handle(c => serviciosService.editar(
      entidad, id(c), servId(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

  r.delete('/:id/servicios/:servId', requirePermiso(modulo, 'eliminacion'),
    handle(c => serviciosService.borrar(
      entidad, id(c), servId(c), c.get('user').id, c.get('accessToken'))))

  // ── Comprobante ──
  r.post('/:id/servicios/upload-url', requirePermiso(modulo, 'creacion'),
    zValidator('json', UploadUrlSchema),
    handle(c => serviciosService.uploadUrl(entidad, id(c), c.req.valid('json'))))

  r.post('/:id/servicios/:servId/comprobante', requirePermiso(modulo, 'creacion'),
    zValidator('json', RegistrarSchema),
    handle(c => serviciosService.registrarComprobante(
      entidad, id(c), servId(c), c.req.valid('json'), c.get('user').id, c.get('accessToken'))))

  r.get('/:id/servicios/:servId/signed-url', requirePermiso(modulo, 'lectura'),
    handle(c => serviciosService.signedUrl(entidad, id(c), servId(c), c.get('accessToken'))))

  return r
}
