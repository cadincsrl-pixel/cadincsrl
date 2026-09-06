/**
 * Auditoría automática (src/middleware/audit.ts): qué fila queda en audit_log
 * por cada request. Fija el contrato que lee la pantalla de Auditoría del
 * frontend: módulo/entidad/acción legibles, el id del registro (de la URL o
 * de la respuesta), el motivo entero, los 403 como 'denegado' y la carga de
 * tarja resumida en una fila por obra+semana.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

type Log = Record<string, unknown>
const { estado } = vi.hoisted(() => ({ estado: { logs: [] as Log[] } }))

vi.mock('../../src/modules/admin/audit.service.js', () => ({
  auditService: { log: vi.fn(async (entry: Log) => { estado.logs.push(entry) }) },
}))
vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { nombre: 'Franco' } }) }) }) }),
  },
  createSupabaseClient: () => ({}),
}))

import {
  auditMiddleware, parseRoute, formatearBody, esId, extraerId, viernesDe,
  resumirLoteTarja, resumirPermisos, flushAuditoriaPendiente,
} from '../../src/middleware/audit.js'

type Vars = { Variables: { user: { id: string } } }

function crearApp() {
  const app = new Hono<Vars>()
  app.use('/api/*', async (c, next) => { c.set('user', { id: 'u-1' }); await next() })
  app.use('/api/*', auditMiddleware)
  app.post('/api/stock/materiales', (c) => c.json({ id: 77, nombre: 'Tornillo' }, 201))
  app.post('/api/logistica/liquidaciones/adelantos', (c) => c.json({ ok: true }))
  app.post('/api/logistica/gastos/:id/rechazar', (c) => c.json({ success: true }))
  app.patch('/api/obras/:cod', (c) => c.json({ cod: c.req.param('cod') }))
  app.delete('/api/logistica/liquidaciones/:id', (c) => c.json({ ok: true }))
  app.put('/api/horas', (c) => c.json({ ok: true }))
  app.put('/api/horas/lote', (c) => c.json({ ok: true }))
  app.post('/api/logistica/maps/geocode', (c) => c.json({ lat: -34.6 }))
  app.post('/api/caja/movimientos', () => { throw new HTTPException(403, { message: 'Sin permiso para creacion en módulo caja' }) })
  app.get('/api/admin/audit', () => { throw new HTTPException(403, { message: 'Solo admin' }) })
  app.get('/api/stock/materiales', () => { throw new HTTPException(403, { message: 'Sin permiso' }) })
  app.onError((err, c) => err instanceof HTTPException
    ? c.json({ error: err.message }, err.status)
    : c.json({ error: 'boom' }, 500))
  return app
}

const json = (body: unknown, extra: Record<string, string> = {}) => ({
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '190.1.1.1, 172.70.0.1', ...extra },
  body: JSON.stringify(body),
})
async function esperarLogs(n: number) {
  await vi.waitFor(() => { expect(estado.logs.length).toBeGreaterThanOrEqual(n) })
}

describe('auditMiddleware', () => {
  beforeEach(async () => {
    await flushAuditoriaPendiente()
    estado.logs.length = 0
  })

  it('POST que crea: entidad legible, id de la respuesta, nombre e IP real', async () => {
    const app = crearApp()
    const res = await app.request('/api/stock/materiales', { method: 'POST', ...json({ nombre: 'Tornillo', precio_ref: 1200, updated_by: 'x' }) })
    expect(res.status).toBe(201)
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({
      user_id: 'u-1', user_nombre: 'Franco', modulo: 'stock', accion: 'crear', entidad: 'material',
      entidad_id: '77', detalle: 'nombre=Tornillo · precio_ref=1200', ip: '190.1.1.1',
    })
  })

  it('POST a una colección anidada no guarda la palabra de la ruta como id', async () => {
    const app = crearApp()
    await app.request('/api/logistica/liquidaciones/adelantos', { method: 'POST', ...json({ monto: 5000 }) })
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({ modulo: 'logistica', entidad: 'adelanto', accion: 'crear' })
    expect(estado.logs[0]!.entidad_id).toBeUndefined()
  })

  it('verbo al final: acción del verbo, id de la URL y motivo entero', async () => {
    const app = crearApp()
    const motivo = 'El comprobante está ilegible y el monto no coincide con lo cargado en la planilla de la semana'
    await app.request('/api/logistica/gastos/5/rechazar', { method: 'POST', ...json({ motivo }) })
    await esperarLogs(1)
    expect(motivo.length).toBeGreaterThan(80)
    expect(estado.logs[0]).toMatchObject({ modulo: 'logistica', entidad: 'gasto de flota', accion: 'rechazar', entidad_id: '5', detalle: `motivo=${motivo}` })
  })

  it('códigos de obra con espacios quedan decodificados como id', async () => {
    const app = crearApp()
    await app.request('/api/obras/CC%20PODA', { method: 'PATCH', ...json({ nom: 'Poda' }) })
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({ modulo: 'obras', entidad: 'obra', accion: 'actualizar', entidad_id: 'CC PODA' })
  })

  it('DELETE con motivo en el body lo conserva', async () => {
    const app = crearApp()
    await app.request('/api/logistica/liquidaciones/23', { method: 'DELETE', ...json({ motivo: 'Cáscara duplicada' }) })
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({ entidad: 'liquidación', accion: 'eliminar', entidad_id: '23', detalle: 'motivo=Cáscara duplicada' })
  })

  it('los POST de consulta (maps) no se auditan', async () => {
    const app = crearApp()
    await app.request('/api/logistica/maps/geocode', { method: 'POST', ...json({ q: 'Salta' }) })
    await new Promise(r => setTimeout(r, 20))
    expect(estado.logs).toHaveLength(0)
  })

  it('un 403 queda como denegado con el mensaje del backend', async () => {
    const app = crearApp()
    const res = await app.request('/api/caja/movimientos', { method: 'POST', ...json({ monto: 1 }) })
    expect(res.status).toBe(403)
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({ modulo: 'caja', entidad: 'movimiento de caja', accion: 'denegado' })
    expect(String(estado.logs[0]!.detalle)).toBe('HTTP 403 POST /api/caja/movimientos · Sin permiso para creacion en módulo caja')
  })

  it('GET denegado: se registra en admin, se ignora en el resto', async () => {
    const app = crearApp()
    await app.request('/api/stock/materiales', { method: 'GET', headers: { 'x-forwarded-for': '1.1.1.1' } })
    await new Promise(r => setTimeout(r, 20))
    expect(estado.logs).toHaveLength(0)
    await app.request('/api/admin/audit', { method: 'GET', headers: { 'x-forwarded-for': '1.1.1.1' } })
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({ modulo: 'admin', accion: 'denegado' })
  })

  it('tarja por celda: una fila por obra+semana con celdas, legajos y horas', async () => {
    const app = crearApp()
    const celdas = [
      { obra_cod: 'CC PODA', fecha: '2026-09-04', leg: '012', horas: 8 },  // viernes
      { obra_cod: 'CC PODA', fecha: '2026-09-07', leg: '015', horas: 7 },  // lunes, misma semana
      { obra_cod: 'CC PODA', fecha: '2026-09-10', leg: '012', horas: 5 },  // jueves, misma semana
      { obra_cod: 'CC PODA', fecha: '2026-09-11', leg: '012', horas: 9 },  // viernes siguiente
    ]
    for (const c of celdas) await app.request('/api/horas', { method: 'PUT', ...json(c) })
    await new Promise(r => setTimeout(r, 20))
    expect(estado.logs).toHaveLength(0) // se acumula, no escribe todavía
    await flushAuditoriaPendiente()
    expect(estado.logs).toHaveLength(2)
    const semana1 = estado.logs.find(l => String(l.detalle).includes('semana del 2026-09-04'))!
    expect(semana1).toMatchObject({ modulo: 'horas', accion: 'cargar horas', entidad: 'tarja', entidad_id: 'CC PODA', user_nombre: 'Franco' })
    expect(String(semana1.detalle)).toContain('3 celdas')
    expect(String(semana1.detalle)).toContain('legajos 012, 015')
    expect(String(semana1.detalle)).toContain('20 hs')
    const semana2 = estado.logs.find(l => String(l.detalle).includes('semana del 2026-09-11'))!
    expect(String(semana2.detalle)).toContain('1 celda ·')
  })

  it('tarja en lote: una fila resumida en el momento', async () => {
    const app = crearApp()
    await app.request('/api/horas/lote', { method: 'PUT', ...json({
      obra_cod: 'CC DEPOSITO', solo_nuevas: true,
      horas: [
        { fecha: '2026-09-04', leg: '001', horas: 0 }, { fecha: '2026-09-05', leg: '001', horas: 0 },
        { fecha: '2026-09-04', leg: '002', horas: 0 }, { fecha: '2026-09-05', leg: '002', horas: 0 },
      ],
    }) })
    await esperarLogs(1)
    expect(estado.logs[0]).toMatchObject({ modulo: 'horas', accion: 'poblar semana', entidad: 'tarja', entidad_id: 'CC DEPOSITO' })
    expect(String(estado.logs[0]!.detalle)).toBe('semana del 2026-09-04 · 4 celdas · legajos 001, 002 · 0 hs · solo celdas nuevas (placeholders)')
  })
})

describe('parseRoute', () => {
  it('ignora GET salvo que se pida', () => {
    expect(parseRoute('/api/obras', 'GET')).toBeNull()
    expect(parseRoute('/api/admin/audit', 'GET', { incluirGet: true })).toMatchObject({ modulo: 'admin', entidad: 'administración' })
  })
  it('ids compuestos y sub-recursos', () => {
    expect(parseRoute('/api/cierres/CC-025/2026-09-04', 'DELETE')).toMatchObject({ entidad: 'cierre de semana', accion: 'eliminar', entidadId: 'CC-025 · 2026-09-04' })
    expect(parseRoute('/api/personal/060/documentos/12', 'DELETE')).toMatchObject({ entidad: 'documento de trabajador', entidadId: '12' })
    expect(parseRoute('/api/solicitudes/items/3396/comprar', 'POST')).toMatchObject({ modulo: 'solicitudes', entidad: 'ítem de solicitud', accion: 'comprar', entidadId: '3396' })
    expect(parseRoute('/api/alquiler/obras/7/maquinas', 'POST')).toMatchObject({ entidad: 'máquina en obra', accion: 'crear', entidadId: '7' })
    expect(parseRoute('/api/usuarios/8f3b2c1a-1111-4222-8333-444455556666/obras', 'PUT')).toMatchObject({ entidad: 'obras del usuario', accion: 'actualizar', entidadId: '8f3b2c1a-1111-4222-8333-444455556666' })
    expect(parseRoute('/api/herramientas/entregas/bulk', 'POST')).toMatchObject({ entidad: 'entrega del pañol', accion: 'confirmar en bloque' })
    expect(parseRoute('/api/contratistas/presupuestos/5/doc/upload-url', 'POST')).toMatchObject({ entidad: 'presupuesto de contratista', accion: 'subir adjunto', entidadId: '5' })
    expect(parseRoute('/api/obras/auto-archivar', 'POST')).toMatchObject({ entidad: 'obra', accion: 'auto-archivar' })
    expect(parseRoute('/api/obras/auto-archivar', 'POST')!.entidadId).toBeUndefined()
    expect(parseRoute('/api/logistica/liquidaciones/23/cerrar', 'PATCH')).toMatchObject({ modulo: 'logistica', entidad: 'liquidación', accion: 'cerrar', entidadId: '23' })
    expect(parseRoute('/api/stock/movimientos/8/rechazar', 'POST')).toMatchObject({ modulo: 'stock', entidad: 'movimiento de stock', accion: 'rechazar', entidadId: '8' })
    expect(parseRoute('/api/logistica/tramos/4/mover', 'POST')).toBeNull()
  })
})

describe('helpers', () => {
  it('esId distingue ids de palabras de ruta', () => {
    expect(esId('12')).toBe(true)
    expect(esId('CC PODA')).toBe(true)
    expect(esId('cc 24')).toBe(true)
    expect(esId('2026-09-04')).toBe(true)
    expect(esId('8f3b2c1a-1111-4222-8333-444455556666')).toBe(true)
    expect(esId('adelantos')).toBe(false)
    expect(esId('tramos')).toBe(false)
    expect(esId('auto-archivar')).toBe(false)
    expect(esId('upload-url')).toBe(false)
  })
  it('formatearBody: arrays resumidos, textos largos solo en claves de motivo, sin secretos', () => {
    expect(formatearBody({ items: [{ leg: '012', h: 1 }, { leg: '015', h: 2 }, { leg: '012', h: 3 }] })).toBe('items=[3] leg: 012, 015')
    expect(formatearBody({ obras: ['CC-001', 'CC-002'] })).toBe('obras=[2] CC-001, CC-002')
    const largo = 'x'.repeat(100)
    expect(formatearBody({ url: largo, obs: largo, password: 'no' })).toBe(`obs=${largo}`)
    expect(formatearBody({ obs: 'y'.repeat(400) }).length).toBe('obs='.length + 300)
  })
  it('el JSON de permisos de un usuario queda legible en el detalle', () => {
    const permisos = {
      tarja: { lectura: true, creacion: true, actualizacion: true, eliminacion: false, tabs: ['tarja'], ver_pii: false },
      certificaciones: { lectura: true, creacion: true, tabs: [] },
      basura: 'no es objeto',
    }
    expect(resumirPermisos(permisos)).toBe('tarja[LCA tabs=tarja ver_pii=false] · certificaciones[LC tabs=(todas)]')
    expect(formatearBody({ rol: 'operador', permisos, modulos: ['tarja', 'certificaciones'] }))
      .toBe('rol=operador · permisos=tarja[LCA tabs=tarja ver_pii=false] · certificaciones[LC tabs=(todas)] · modulos=[2] tarja, certificaciones')
    expect(resumirPermisos({})).toBe('{}')
  })

  it('extraerId busca el id donde lo devuelva el handler', () => {
    expect(extraerId({ id: 5 })).toBe('5')
    expect(extraerId({ data: { id: 6 } })).toBe('6')
    expect(extraerId({ cod: 'CC-1' })).toBe('CC-1')
    expect(extraerId({ remito: { id: 9, numero: 'RR-0009' } })).toBe('9')
    expect(extraerId({ ok: true })).toBeUndefined()
    expect(extraerId([{ id: 1 }])).toBeUndefined()
  })
  it('viernesDe: semana viernes → jueves', () => {
    expect(viernesDe('2026-09-04')).toBe('2026-09-04')
    expect(viernesDe('2026-09-06')).toBe('2026-09-04')
    expect(viernesDe('2026-09-10')).toBe('2026-09-04')
    expect(viernesDe('2026-09-11')).toBe('2026-09-11')
  })
  it('resumirLoteTarja distingue placeholders de copia', () => {
    expect(resumirLoteTarja({ horas: [{ fecha: '2026-09-07', leg: '001', horas: 8 }] })).toEqual({ accion: 'cargar en lote', detalle: 'semana del 2026-09-04 · 1 celda · legajos 001 · 8 hs' })
    expect(resumirLoteTarja({ horas: [], solo_nuevas: true }).accion).toBe('poblar semana')
  })
})
