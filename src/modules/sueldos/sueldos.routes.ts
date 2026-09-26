/**
 * Rutas del módulo Sueldos (montado en `/api/sueldos`). Contrato completo en
 * el scratchpad `sueldos_api.md` de la sesión que lo construyó (26/09/2026),
 * espejado en el frontend en `src/modules/sueldos/types.ts`.
 *
 * Permisos: `permisos.sueldos = { lectura, creacion, actualizacion,
 * eliminacion, tabs: ['legajos','liquidaciones','recibos','convenios',
 * 'configuracion','exportar'], ver_pii, liquidar, cerrar_liquidaciones,
 * configurar }`. Flags default false; admin bypass. Las RPC vuelven a
 * chequear los flags (`_perm_flag`).
 *
 *   - Leer la configuración (convenios, categorías, escalas, conceptos,
 *     parámetros, valores) pide solo `lectura`: la usan todas las tabs.
 *   - Escribir la configuración: tab `convenios` (o `configuracion` para
 *     parámetros) + flag `configurar`.
 *   - Legajos: alta `creacion`, edición `actualizacion`, tab `legajos`.
 *     CUIL/CBU solo con `ver_pii` (se enmascaran sin él).
 *   - Liquidaciones: leer con tab liquidaciones|recibos|exportar; crear,
 *     editar, recibos y generar con flag `liquidar`; cerrar, reabrir, anular
 *     y contabilizar con `cerrar_liquidaciones`.
 *   - Exportar: tab `exportar`; banco y LSD además `ver_pii`.
 *
 * Rutas literales (`/legajos/candidatos`, `/escalas/paritaria`,
 * `/conceptos/valores/:id`, `/recibos/calcular`) van ANTES de las de `:id`.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso, requireFlag, requireTab, tieneFlag } from '../../middleware/permission.js'
import { quiereDescargar } from '../../lib/signed-url.js'
import { aAnsi } from '../facturacion/lid-ventas.js'
import { SueldosHttpError, cuerpoError, errorDeZod } from './sueldos.errors.js'
import { dbDe } from './comun.js'
import { configService } from './config.service.js'
import { legajosService } from './legajos.service.js'
import { liquidacionesService } from './liquidaciones.service.js'
import { exportarService } from './exportar.service.js'
import { semestreDe } from './calculo.js'
import {
  esBoolQ,
  ConvenioCreateSchema, ConvenioUpdateSchema, CategoriaCreateSchema, CategoriaUpdateSchema,
  EscalaCreateSchema, EscalaUpdateSchema, EscalasQuerySchema, ParitariaSchema,
  ConceptoCreateSchema, ConceptoUpdateSchema, ConceptosQuerySchema, ConceptoValorCreateSchema, ConceptoValorUpdateSchema,
  ParametroCreateSchema, ParametroUpdateSchema, ParametrosQuerySchema, ValoresQuerySchema,
  LegajoCreateSchema, LegajoUpdateSchema, LegajosQuerySchema,
  LiquidacionCreateSchema, LiquidacionUpdateSchema, LiquidacionesQuerySchema, MotivoSchema,
  CalcularReciboSchema, GuardarReciboSchema, GenerarSchema, SacQuerySchema, VacacionesQuerySchema, FinalQuerySchema,
  BancoQuerySchema, DescargarQuerySchema,
} from './sueldos.schema.js'

const MOD = 'sueldos'
const sue = new Hono()
sue.use('*', authMiddleware)

// ── Guardias ────────────────────────────────────────────────────────────────
const lectura       = requirePermiso(MOD, 'lectura')
const creacion      = requirePermiso(MOD, 'creacion')
const actualizacion = requirePermiso(MOD, 'actualizacion')
const tabLegajos    = requireTab(MOD, 'legajos')
const tabLegajosLeer = requireTab(MOD, ['legajos', 'liquidaciones', 'recibos', 'exportar'])
const tabLiq        = requireTab(MOD, 'liquidaciones')
const tabLiqLeer    = requireTab(MOD, ['liquidaciones', 'recibos', 'exportar'])
const tabConvenios  = requireTab(MOD, 'convenios')
const tabConfig     = requireTab(MOD, 'configuracion')
const tabExportar   = requireTab(MOD, 'exportar')
const flagLiquidar  = requireFlag(MOD, 'liquidar')
const flagCerrar    = requireFlag(MOD, 'cerrar_liquidaciones')
const flagConfig    = requireFlag(MOD, 'configurar')
const flagPii       = requireFlag(MOD, 'ver_pii')

/** Errores tipados → `{ error, campo?, detail? }`. Lo demás sube al onError global. */
function handler(fn: (c: any) => Promise<any>) {
  return async (c: any) => {
    try {
      const data = await fn(c)
      return data instanceof Response ? data : c.json(data)
    } catch (err: any) {
      if (err instanceof SueldosHttpError) return c.json(cuerpoError(err), err.status as any)
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
  const v = Number(c.req.param(name))
  if (!Number.isInteger(v) || v <= 0) throw new SueldosHttpError(400, 'ID_INVALIDO', { campo: name })
  return v
}
const db = (c: any) => dbDe(c.get('accessToken'))
const uid = (c: any): string => c.get('user').id
const verPii = (c: any) => tieneFlag(uid(c), MOD, 'ver_pii')

function archivo(contenido: string, nombre: string, tipo: string, ansi: boolean): Response {
  const body = ansi ? aAnsi(contenido) : new TextEncoder().encode('﻿' + contenido)
  return new Response(body.buffer as ArrayBuffer, {
    status: 200,
    headers: { 'Content-Type': tipo, 'Content-Disposition': `attachment; filename="${nombre}"` },
  })
}

// ═══════════════════════════════════ Configuración ══════════════════════════

sue.get('/convenios', lectura, handler(async (c) => configService.convenios(db(c))))
sue.post('/convenios', lectura, tabConvenios, flagConfig, valida('json', ConvenioCreateSchema), handler(async (c) =>
  configService.guardarConvenio(c.req.valid('json'), uid(c), db(c))))
sue.patch('/convenios/:id', lectura, tabConvenios, flagConfig, valida('json', ConvenioUpdateSchema), handler(async (c) =>
  configService.guardarConvenio({ ...c.req.valid('json'), id: idParam(c) }, uid(c), db(c))))

sue.get('/categorias', lectura, handler(async (c) => {
  const v = c.req.query('convenio_id')
  return configService.categorias(v ? Number(v) || undefined : undefined, db(c))
}))
sue.post('/categorias', lectura, tabConvenios, flagConfig, valida('json', CategoriaCreateSchema), handler(async (c) =>
  configService.guardarCategoria(c.req.valid('json'), uid(c), db(c))))
sue.patch('/categorias/:id', lectura, tabConvenios, flagConfig, valida('json', CategoriaUpdateSchema), handler(async (c) =>
  configService.guardarCategoria({ ...c.req.valid('json'), id: idParam(c) }, uid(c), db(c))))

sue.get('/escalas', lectura, valida('query', EscalasQuerySchema), handler(async (c) =>
  configService.escalas(c.req.valid('query'), db(c))))
sue.post('/escalas/paritaria', lectura, tabConvenios, flagConfig, valida('json', ParitariaSchema), handler(async (c) =>
  configService.nuevaParitaria(c.req.valid('json'), uid(c), db(c))))
sue.post('/escalas', lectura, tabConvenios, flagConfig, valida('json', EscalaCreateSchema), handler(async (c) =>
  configService.guardarEscala(c.req.valid('json'), uid(c), db(c))))
sue.patch('/escalas/:id', lectura, tabConvenios, flagConfig, valida('json', EscalaUpdateSchema), handler(async (c) =>
  configService.guardarEscala({ ...c.req.valid('json'), id: idParam(c) }, uid(c), db(c))))
sue.delete('/escalas/:id', lectura, tabConvenios, flagConfig, handler(async (c) =>
  configService.borrarEscala(idParam(c), uid(c), db(c))))

sue.get('/conceptos', lectura, valida('query', ConceptosQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return configService.conceptos({ convenio_id: q.convenio_id, incluir_inactivos: esBoolQ(q.incluir_inactivos), fecha: q.fecha }, db(c))
}))
sue.post('/conceptos', lectura, tabConvenios, flagConfig, valida('json', ConceptoCreateSchema), handler(async (c) =>
  configService.guardarConcepto(c.req.valid('json'), uid(c), db(c))))
sue.patch('/conceptos/valores/:id', lectura, tabConvenios, flagConfig, valida('json', ConceptoValorUpdateSchema), handler(async (c) =>
  configService.guardarConceptoValor({ ...c.req.valid('json'), id: idParam(c) }, uid(c), db(c))))
sue.delete('/conceptos/valores/:id', lectura, tabConvenios, flagConfig, handler(async (c) =>
  configService.borrarConceptoValor(idParam(c), uid(c), db(c))))
sue.post('/conceptos/:id/valores', lectura, tabConvenios, flagConfig, valida('json', ConceptoValorCreateSchema), handler(async (c) => {
  const b = c.req.valid('json')
  const id = idParam(c)
  if (b.concepto_id !== id) throw new SueldosHttpError(400, 'DATOS_INVALIDOS', { campo: 'concepto_id' })
  return configService.guardarConceptoValor(b, uid(c), db(c))
}))
sue.patch('/conceptos/:id', lectura, tabConvenios, flagConfig, valida('json', ConceptoUpdateSchema), handler(async (c) =>
  configService.guardarConcepto({ ...c.req.valid('json'), id: idParam(c) }, uid(c), db(c))))

sue.get('/parametros', lectura, valida('query', ParametrosQuerySchema), handler(async (c) =>
  configService.parametros(c.req.valid('query'), db(c))))
sue.post('/parametros', lectura, tabConfig, flagConfig, valida('json', ParametroCreateSchema), handler(async (c) =>
  configService.guardarParametro(c.req.valid('json'), uid(c), db(c))))
sue.patch('/parametros/:id', lectura, tabConfig, flagConfig, valida('json', ParametroUpdateSchema), handler(async (c) =>
  configService.guardarParametro({ ...c.req.valid('json'), id: idParam(c) }, uid(c), db(c))))
sue.delete('/parametros/:id', lectura, tabConfig, flagConfig, handler(async (c) =>
  configService.borrarParametro(idParam(c), uid(c), db(c))))

/** Paquete del motor (escala, conceptos con valor, parámetros) a una fecha. */
sue.get('/valores', lectura, valida('query', ValoresQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return configService.valoresAFecha(q.convenio_id, q.fecha, q.zona, db(c))
}))

// ═══════════════════════════════════ Legajos ════════════════════════════════

sue.get('/legajos', lectura, tabLegajosLeer, valida('query', LegajosQuerySchema), handler(async (c) =>
  legajosService.listar(c.req.valid('query'), await verPii(c), db(c))))
sue.get('/legajos/candidatos', lectura, tabLegajos, handler(async (c) =>
  legajosService.candidatos(await verPii(c), db(c))))
sue.get('/legajos/:id', lectura, tabLegajosLeer, handler(async (c) =>
  legajosService.obtener(idParam(c), await verPii(c), db(c))))
sue.post('/legajos', lectura, creacion, tabLegajos, valida('json', LegajoCreateSchema), handler(async (c) =>
  legajosService.guardar(c.req.valid('json'), uid(c), await verPii(c), db(c))))
sue.patch('/legajos/:id', lectura, actualizacion, tabLegajos, valida('json', LegajoUpdateSchema), handler(async (c) =>
  legajosService.guardar({ ...c.req.valid('json'), id: idParam(c) }, uid(c), await verPii(c), db(c))))

sue.get('/legajos/:id/sac', lectura, tabLegajosLeer, valida('query', SacQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  const hoy = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
  const def = semestreDe(hoy)
  return liquidacionesService.sacDeLegajo(idParam(c), q.anio ?? def.anio, (q.semestre ?? def.semestre) as 1 | 2, db(c))
}))
sue.get('/legajos/:id/vacaciones', lectura, tabLegajosLeer, valida('query', VacacionesQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return liquidacionesService.vacacionesDeLegajo(idParam(c), q.anio ?? new Date().getFullYear(), q.dias, db(c))
}))
sue.get('/legajos/:id/final', lectura, tabLegajosLeer, valida('query', FinalQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  return liquidacionesService.finalDeLegajo(idParam(c), q.fecha_egreso, q.dias_gozados, db(c))
}))

// ═══════════════════════════════════ Liquidaciones ══════════════════════════

sue.get('/liquidaciones', lectura, tabLiqLeer, valida('query', LiquidacionesQuerySchema), handler(async (c) =>
  liquidacionesService.listar(c.req.valid('query'), db(c))))
sue.post('/liquidaciones', lectura, tabLiq, flagLiquidar, valida('json', LiquidacionCreateSchema), handler(async (c) =>
  liquidacionesService.crear(c.req.valid('json'), uid(c), db(c))))
sue.get('/liquidaciones/:id', lectura, tabLiqLeer, handler(async (c) =>
  liquidacionesService.obtener(idParam(c), esBoolQ(c.req.query('lineas')), await verPii(c), db(c))))
sue.patch('/liquidaciones/:id', lectura, tabLiq, flagLiquidar, valida('json', LiquidacionUpdateSchema), handler(async (c) =>
  liquidacionesService.editar(idParam(c), c.req.valid('json'), uid(c), db(c))))

sue.post('/liquidaciones/:id/cerrar', lectura, tabLiq, flagCerrar, handler(async (c) =>
  liquidacionesService.cerrar(idParam(c), uid(c), db(c))))
sue.post('/liquidaciones/:id/contabilizar', lectura, tabLiq, flagCerrar, handler(async (c) =>
  liquidacionesService.contabilizar(idParam(c), uid(c), db(c))))
sue.post('/liquidaciones/:id/reabrir', lectura, tabLiq, flagCerrar, valida('json', MotivoSchema), handler(async (c) =>
  liquidacionesService.reabrir(idParam(c), c.req.valid('json').motivo, uid(c), db(c))))
sue.post('/liquidaciones/:id/anular', lectura, tabLiq, flagCerrar, valida('json', MotivoSchema), handler(async (c) =>
  liquidacionesService.anular(idParam(c), c.req.valid('json').motivo, uid(c), db(c))))
sue.get('/liquidaciones/:id/asiento', lectura, tabLiqLeer, handler(async (c) =>
  liquidacionesService.asiento(idParam(c), db(c))))

sue.post('/liquidaciones/:id/generar', lectura, tabLiq, flagLiquidar, valida('json', GenerarSchema), handler(async (c) =>
  liquidacionesService.generar(idParam(c), c.req.valid('json'), uid(c), await verPii(c), db(c))))

// Vista previa: no guarda nada (no se audita, ver SIN_AUDITAR en audit.ts).
sue.post('/liquidaciones/:id/recibos/calcular', lectura, tabLiqLeer, valida('json', CalcularReciboSchema), handler(async (c) => {
  const b = c.req.valid('json')
  return liquidacionesService.calcular(idParam(c), b.legajo_id, b.entradas, db(c))
}))
sue.get('/liquidaciones/:id/recibos/:legajoId/sugerencias', lectura, tabLiqLeer, handler(async (c) =>
  liquidacionesService.sugerencias(idParam(c), idParam(c, 'legajoId'), db(c))))
sue.get('/liquidaciones/:id/recibos/:legajoId', lectura, tabLiqLeer, handler(async (c) =>
  liquidacionesService.recibo(idParam(c), idParam(c, 'legajoId'), await verPii(c), db(c))))
sue.put('/liquidaciones/:id/recibos/:legajoId', lectura, tabLiq, flagLiquidar, valida('json', GuardarReciboSchema), handler(async (c) => {
  const b = c.req.valid('json')
  return liquidacionesService.guardar(idParam(c), idParam(c, 'legajoId'), b.entradas, b.obs, uid(c), await verPii(c), db(c))
}))
sue.delete('/liquidaciones/:id/recibos/:legajoId', lectura, tabLiq, flagLiquidar, handler(async (c) =>
  liquidacionesService.borrar(idParam(c), idParam(c, 'legajoId'), uid(c), db(c))))

// ═══════════════════════════════════ Exportar ═══════════════════════════════

sue.get('/liquidaciones/:id/exportar/banco', lectura, tabExportar, flagPii, valida('query', BancoQuerySchema), handler(async (c) => {
  const q = c.req.valid('query')
  const r = await exportarService.banco(idParam(c), q.decimal, db(c))
  if (quiereDescargar(q.descargar)) return archivo(r.csv, r.archivo, 'text/csv; charset=utf-8', false)
  return r
}))
sue.get('/liquidaciones/:id/exportar/resumen', lectura, tabExportar, handler(async (c) =>
  exportarService.resumen(idParam(c), await verPii(c), db(c))))
sue.get('/liquidaciones/:id/exportar/lsd', lectura, tabExportar, flagPii, valida('query', DescargarQuerySchema), handler(async (c) => {
  const r = await exportarService.lsd(idParam(c), db(c))
  if (quiereDescargar(c.req.valid('query').descargar)) {
    return archivo(r.contenido, r.archivo, 'text/plain; charset=windows-1252', true)
  }
  return r
}))
sue.get('/exportar/lsd-conceptos', lectura, tabExportar, valida('query', DescargarQuerySchema), handler(async (c) => {
  const r = await exportarService.lsdConceptos(db(c))
  if (quiereDescargar(c.req.valid('query').descargar)) return archivo(r.contenido, r.archivo, 'text/plain; charset=windows-1252', true)
  return r
}))

export default sue
