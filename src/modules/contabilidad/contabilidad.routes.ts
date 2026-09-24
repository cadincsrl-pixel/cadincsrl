/**
 * Rutas del módulo Contabilidad (montado en `/api/contabilidad`). Fase 1:
 * plan de cuentas, asientos manuales, libro diario, mayor, sumas y saldos,
 * períodos (cierre y reapertura) y cuentas de tesorería. Contrato: spec
 * `spec-contabilidad-fase1.md` §B (2026-09-24), espejado en el frontend en
 * `src/types/contabilidad.types.ts`.
 *
 * Permisos: `permisos.contabilidad = { lectura, creacion, actualizacion,
 * eliminacion, tabs: ['asientos','diario','mayor','sumas-saldos','plan',
 * 'periodos'], asientos_manuales, cerrar_periodos, editar_plan }`. Flags
 * default false; admin bypass. Las RPC vuelven a chequear los flags.
 *
 * Rutas literales (`/cuentas/importar`) van ANTES de `/:id`.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, requireTab } from '../../middleware/permission.js'
import { ContabilidadHttpError, cuerpoError, errorDeZod } from './contabilidad.errors.js'
import { dbDe } from './comun.js'
import { asientosService } from './asientos.service.js'
import { cuentasService } from './cuentas.service.js'
import { periodosService } from './periodos.service.js'
import { reportesService } from './reportes.service.js'
import { tesoreriaService } from './tesoreria.service.js'
import { catalogosService } from './catalogos.service.js'
import {
  esBoolQ, MotivoSchema, PeriodosQuerySchema,
  CuentaSchema, UpdateCuentaSchema, ListCuentasQuerySchema, ImportarPlanSchema,
  GuardarAsientoSchema, AnularAsientoSchema, ListAsientosQuerySchema,
  DiarioQuerySchema, MayorQuerySchema, SumasSaldosQuerySchema,
  TesoreriaSchema, UpdateTesoreriaSchema, ListTesoreriaQuerySchema, AuxiliaresQuerySchema,
} from './contabilidad.schema.js'

const MOD = 'contabilidad'
const ctb = new Hono()
ctb.use('*', authMiddleware)

// ── Guardias ────────────────────────────────────────────────────────────────
const lectura        = requirePermiso(MOD, 'lectura')
const creacion       = requirePermiso(MOD, 'creacion')
const actualizacion  = requirePermiso(MOD, 'actualizacion')
const eliminacion    = requirePermiso(MOD, 'eliminacion')
const tabAsientos    = requireTab(MOD, 'asientos')
// La ficha de un asiento se abre también desde el diario y el mayor.
const tabAsientoLeer = requireTab(MOD, ['asientos', 'diario', 'mayor'])
const tabDiario      = requireTab(MOD, 'diario')
const tabMayor       = requireTab(MOD, 'mayor')
const tabSumas       = requireTab(MOD, 'sumas-saldos')
const tabPlan        = requireTab(MOD, 'plan')
const tabPeriodos    = requireTab(MOD, 'periodos')
const flagAsientos   = requireFlag(MOD, 'asientos_manuales')
const flagCerrar     = requireFlag(MOD, 'cerrar_periodos')
const flagPlan       = requireFlag(MOD, 'editar_plan')

/** Errores tipados → `{ error, campo?, detail? }`. Lo demás sube al onError global. */
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return data instanceof Response ? data : c.json(data)
    } catch (err: any) {
      if (err instanceof ContabilidadHttpError) return c.json(cuerpoError(err), err.status as any)
      throw err
    }
  }
}

function valida<T extends ZodType>(target: 'json' | 'query', schema: T) {
  return zValidator(target, schema, (r, c) => {
    if (!r.success) {
      const e = errorDeZod(r.error.issues[0] as any)
      return c.json(e.body, e.status as any)
    }
  })
}

const idParam = (c: any, name = 'id') => {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n <= 0) throw new ContabilidadHttpError(400, 'ID_INVALIDO', { campo: name })
  return n
}
const db = (c: any) => dbDe(c.get('accessToken'))
const uid = (c: any): string => c.get('user').id

// ═══════════════════════════════════ Ejercicios y períodos ══════════════════

ctb.get('/ejercicios', lectura, handler(async (c) => periodosService.ejercicios(db(c))))

ctb.get('/periodos', lectura, valida('query', PeriodosQuerySchema), handler(async (c) =>
  periodosService.listar(c.req.valid('query').ejercicio_id, db(c))))

ctb.post('/periodos/:id/cerrar', lectura, actualizacion, tabPeriodos, flagCerrar, handler(async (c) =>
  periodosService.cerrar(idParam(c), uid(c), db(c))))

ctb.post('/periodos/:id/reabrir', lectura, actualizacion, tabPeriodos, flagCerrar, valida('json', MotivoSchema), handler(async (c) =>
  periodosService.reabrir(idParam(c), c.req.valid('json').motivo, uid(c), db(c))))

// ═══════════════════════════════════ Plan de cuentas ════════════════════════

ctb.get('/cuentas', lectura, valida('query', ListCuentasQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return cuentasService.listar({ incluirInactivas: esBoolQ(q.incluir_inactivas), soloImputables: esBoolQ(q.solo_imputables), q: q.q }, db(c))
}))

ctb.post('/cuentas/importar', lectura, creacion, tabPlan, flagPlan, valida('json', ImportarPlanSchema), handler(async (c) =>
  cuentasService.importar(c.req.valid('json'), uid(c), db(c))))

ctb.post('/cuentas', lectura, creacion, tabPlan, flagPlan, valida('json', CuentaSchema), handler(async (c) =>
  cuentasService.crear(c.req.valid('json'), uid(c), db(c))))

ctb.patch('/cuentas/:id', lectura, actualizacion, tabPlan, flagPlan, valida('json', UpdateCuentaSchema), handler(async (c) =>
  cuentasService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

ctb.post('/cuentas/:id/baja', lectura, actualizacion, tabPlan, flagPlan, valida('json', MotivoSchema), handler(async (c) =>
  cuentasService.setActivo(idParam(c), false, c.req.valid('json').motivo.trim(), uid(c), db(c))))

ctb.post('/cuentas/:id/alta', lectura, actualizacion, tabPlan, flagPlan, handler(async (c) =>
  cuentasService.setActivo(idParam(c), true, null, uid(c), db(c))))

ctb.delete('/cuentas/:id', lectura, eliminacion, tabPlan, flagPlan, handler(async (c) =>
  cuentasService.borrar(idParam(c), uid(c), db(c))))

// ═══════════════════════════════════ Asientos ═══════════════════════════════

ctb.get('/asientos', lectura, tabAsientos, valida('query', ListAsientosQuerySchema), handler(async (c) =>
  asientosService.listar(c.req.valid('query'), db(c))))

ctb.get('/asientos/:id', lectura, tabAsientoLeer, handler(async (c) =>
  asientosService.detalle(idParam(c), db(c))))

ctb.post('/asientos', lectura, creacion, tabAsientos, flagAsientos, valida('json', GuardarAsientoSchema), handler(async (c) =>
  asientosService.guardar(c.req.valid('json'), null, uid(c), db(c))))

ctb.patch('/asientos/:id', lectura, actualizacion, tabAsientos, flagAsientos, valida('json', GuardarAsientoSchema), handler(async (c) =>
  asientosService.guardar(c.req.valid('json'), idParam(c), uid(c), db(c))))

ctb.delete('/asientos/:id', lectura, actualizacion, tabAsientos, flagAsientos, handler(async (c) =>
  asientosService.borrar(idParam(c), uid(c), db(c))))

ctb.post('/asientos/:id/anular', lectura, actualizacion, tabAsientos, flagAsientos, valida('json', AnularAsientoSchema), handler(async (c) => {
  const b = c.req.valid('json')
  return asientosService.anular(idParam(c), b.motivo, b.fecha, uid(c), db(c))
}))

// ═══════════════════════════════════ Reportes ═══════════════════════════════

ctb.get('/diario', lectura, tabDiario, valida('query', DiarioQuerySchema), handler(async (c) =>
  reportesService.diario(c.req.valid('query'), db(c))))

ctb.get('/mayor', lectura, tabMayor, valida('query', MayorQuerySchema), handler(async (c) =>
  reportesService.mayor(c.req.valid('query'), db(c))))

ctb.get('/sumas-saldos', lectura, tabSumas, valida('query', SumasSaldosQuerySchema), handler(async (c) =>
  reportesService.sumasSaldos(c.req.valid('query'), db(c))))

// ═══════════════════════════════════ Tesorería ══════════════════════════════

ctb.get('/tesoreria', lectura, valida('query', ListTesoreriaQuerySchema), handler(async (c) =>
  tesoreriaService.listar(esBoolQ(c.req.valid('query').incluir_inactivas), db(c))))

ctb.post('/tesoreria', lectura, actualizacion, tabPlan, flagPlan, valida('json', TesoreriaSchema), handler(async (c) =>
  tesoreriaService.crear(c.req.valid('json'), uid(c), db(c))))

ctb.patch('/tesoreria/:id', lectura, actualizacion, tabPlan, flagPlan, valida('json', UpdateTesoreriaSchema), handler(async (c) =>
  tesoreriaService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

ctb.post('/tesoreria/:id/baja', lectura, actualizacion, tabPlan, flagPlan, handler(async (c) =>
  tesoreriaService.setActivo(idParam(c), false, uid(c), db(c))))

ctb.post('/tesoreria/:id/alta', lectura, actualizacion, tabPlan, flagPlan, handler(async (c) =>
  tesoreriaService.setActivo(idParam(c), true, uid(c), db(c))))

// ═══════════════════════════════════ Catálogos ══════════════════════════════

ctb.get('/obras', lectura, handler(async (c) => catalogosService.obras(db(c))))

ctb.get('/auxiliares', lectura, valida('query', AuxiliaresQuerySchema), handler(async (c) =>
  catalogosService.auxiliares(c.req.valid('query'), db(c))))

export default ctb
