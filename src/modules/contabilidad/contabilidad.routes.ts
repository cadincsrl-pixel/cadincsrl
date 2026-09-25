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
 * Fase 3 (20260927d–f): tabs `automaticos` y `mapeos`, flags `contabilizar`
 * y `editar_mapeos` (default false). `/automaticos/*`, `/mapeos` y `/config`;
 * cerrar un período frena con 409 HAY_PENDIENTES_AUTOMATICOS salvo `forzar`.
 *
 * Tanda 4 (20260928h–k): `fuentes` en pendientes (circuitos), `modo` del
 * libro diario (detallado | dia | mes) y tab `estados` (balance y resultados).
 *
 * Rutas literales (`/cuentas/importar`) van ANTES de `/:id`.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, requireTab, tieneFlag } from '../../middleware/permission.js'
import { ContabilidadHttpError, cuerpoError, errorDeZod } from './contabilidad.errors.js'
import { dbDe } from './comun.js'
import { asientosService } from './asientos.service.js'
import { cuentasService } from './cuentas.service.js'
import { periodosService } from './periodos.service.js'
import { reportesService } from './reportes.service.js'
import { tesoreriaService } from './tesoreria.service.js'
import { catalogosService } from './catalogos.service.js'
import { automaticosService } from './automaticos.service.js'
import { mapeosService } from './mapeos.service.js'
import {
  esBoolQ, MotivoSchema, PeriodosQuerySchema,
  CuentaSchema, UpdateCuentaSchema, ListCuentasQuerySchema, ImportarPlanSchema,
  GuardarAsientoSchema, AnularAsientoSchema, ListAsientosQuerySchema,
  DiarioQuerySchema, MayorQuerySchema, SumasSaldosQuerySchema, BalanceQuerySchema, ResultadosQuerySchema,
  TesoreriaSchema, UpdateTesoreriaSchema, ListTesoreriaQuerySchema, AuxiliaresQuerySchema,
  PendientesQuerySchema, PropuestaQuerySchema, ContabilizarSchema, GuardarMapeosSchema, ConfigSchema, CerrarPeriodoSchema,
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
const tabEstados     = requireTab(MOD, 'estados')
const tabPlan        = requireTab(MOD, 'plan')
const tabPeriodos    = requireTab(MOD, 'periodos')
const flagAsientos   = requireFlag(MOD, 'asientos_manuales')
const flagCerrar     = requireFlag(MOD, 'cerrar_periodos')
const flagPlan       = requireFlag(MOD, 'editar_plan')
// Fase 3 (20260927d–f): motor de asientos automáticos y mapeos. Default false.
const tabAutomaticos   = requireTab(MOD, 'automaticos')
const tabMapeos        = requireTab(MOD, 'mapeos')
const flagContabilizar = requireFlag(MOD, 'contabilizar')
const flagMapeos       = requireFlag(MOD, 'editar_mapeos')

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

// Abrir el ejercicio siguiente (20260928e): mismo permiso que cerrar/reabrir.
ctb.post('/ejercicios/siguiente', lectura, actualizacion, tabPeriodos, flagCerrar, handler(async (c) =>
  periodosService.abrirSiguiente(uid(c), db(c))))

ctb.get('/periodos', lectura, valida('query', PeriodosQuerySchema), handler(async (c) =>
  periodosService.listar(c.req.valid('query').ejercicio_id, db(c))))

// Body opcional `{ forzar }`: sin él, con orígenes automáticos sin
// contabilizar en el rango → 409 HAY_PENDIENTES_AUTOMATICOS (fase 3).
ctb.post('/periodos/:id/cerrar', lectura, actualizacion, tabPeriodos, flagCerrar, handler(async (c) => {
  const raw = await c.req.json().catch(() => ({}))
  const b = CerrarPeriodoSchema.safeParse(raw ?? {})
  if (!b.success) {
    const e = errorDeZod(b.error.issues[0] as any)
    return c.json(e.body, e.status as any)
  }
  return periodosService.cerrar(idParam(c), uid(c), db(c), b.data.forzar)
}))

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

// Estados contables (20260928j): tab `estados`.
ctb.get('/estados/balance', lectura, tabEstados, valida('query', BalanceQuerySchema), handler(async (c) =>
  reportesService.balance(c.req.valid('query'), db(c))))

ctb.get('/estados/resultados', lectura, tabEstados, valida('query', ResultadosQuerySchema), handler(async (c) =>
  reportesService.resultados(c.req.valid('query'), db(c))))

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

// ═══════════════════════════════════ Asientos automáticos (fase 3) ══════════
// Literales todas: no hay `/automaticos/:id`.

ctb.get('/automaticos/pendientes', lectura, tabAutomaticos, valida('query', PendientesQuerySchema), handler(async (c) =>
  automaticosService.pendientes(c.req.valid('query'), db(c))))

ctb.get('/automaticos/propuesta', lectura, tabAutomaticos, valida('query', PropuestaQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return automaticosService.propuesta(q.origen_tabla, q.origen_id, db(c))
}))

// Corregir en períodos cerrados (contraasientos) exige además cerrar_periodos.
ctb.post('/automaticos/contabilizar', lectura, actualizacion, tabAutomaticos, flagContabilizar, valida('json', ContabilizarSchema), handler(async (c) => {
  const b = c.req.valid('json')
  if (b.revertir_cerrados && !(await tieneFlag(uid(c), MOD, 'cerrar_periodos', false))) {
    throw new ContabilidadHttpError(403, 'SIN_PERMISO_CERRAR', { flag: 'cerrar_periodos', campo: 'revertir_cerrados' })
  }
  return automaticosService.contabilizar(b, uid(c), db(c))
}))

// ═══════════════════════════════════ Mapeos y configuración (fase 3) ════════

ctb.get('/mapeos', lectura, tabMapeos, handler(async (c) => mapeosService.listar(db(c))))

ctb.put('/mapeos', lectura, actualizacion, tabMapeos, flagMapeos, valida('json', GuardarMapeosSchema), handler(async (c) =>
  mapeosService.guardar(c.req.valid('json'), uid(c), db(c))))

// Leer la config lo necesitan las pantallas de automáticos y de mapeos: sin tab.
ctb.get('/config', lectura, handler(async (c) => automaticosService.config(db(c))))

ctb.patch('/config', lectura, actualizacion, tabMapeos, flagMapeos, valida('json', ConfigSchema), handler(async (c) =>
  mapeosService.guardarConfig(c.req.valid('json'), uid(c), db(c))))

// ═══════════════════════════════════ Catálogos ══════════════════════════════

ctb.get('/obras', lectura, handler(async (c) => catalogosService.obras(db(c))))

ctb.get('/auxiliares', lectura, valida('query', AuxiliaresQuerySchema), handler(async (c) =>
  catalogosService.auxiliares(c.req.valid('query'), db(c))))

export default ctb
