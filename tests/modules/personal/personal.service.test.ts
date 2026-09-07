// El service de personal contra un Supabase de mentira: qué escribe y cuándo
// corta con 409. Lo que se fija acá: el alta guarda TODOS los campos, el
// historial de categorías solo se toca cuando la categoría cambia, y un DNI
// repetido o un legajo repetido no entran.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'

interface Op { table: string; action: string; payload?: Record<string, unknown>; eq: Record<string, unknown>; neq: Record<string, unknown> }
type Respuesta = { data?: unknown; error?: { message: string } | null }

const { estado } = vi.hoisted(() => ({
  estado: {
    ops: [] as Array<{ table: string; action: string; payload?: Record<string, unknown>; eq: Record<string, unknown>; neq: Record<string, unknown> }>,
    responder: ((_op: unknown) => ({ data: null })) as (op: never) => { data?: unknown; error?: { message: string } | null },
  },
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: {},
  createSupabaseClient: () => ({
    from(table: string) {
      const op: Op = { table, action: 'select', eq: {}, neq: {} }
      const fin = () => {
        estado.ops.push(op)
        const r = (estado.responder as (o: Op) => Respuesta)(op)
        return { data: r.data ?? null, error: r.error ?? null }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        insert: (p: Record<string, unknown>) => { op.action = 'insert'; op.payload = p; return b },
        update: (p: Record<string, unknown>) => { op.action = 'update'; op.payload = p; return b },
        delete: () => { op.action = 'delete'; return b },
        eq:  (k: string, v: unknown) => { op.eq[k] = v; return b },
        neq: (k: string, v: unknown) => { op.neq[k] = v; return b },
        limit: () => b,
        order: () => b,
        maybeSingle: () => Promise.resolve(fin()),
        single:      () => Promise.resolve(fin()),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(fin()).then(res, rej),
      }
      return b
    },
  }),
}))

import { personalService } from '../../../src/modules/personal/personal.service.js'
import { hoyArgentinaISO } from '../../../src/lib/semanas.js'
import { viernesISO } from '../../../src/modules/horas/costo-obra.js'

const VIERNES_ACTUAL = viernesISO(hoyArgentinaISO())
const ops = (table: string, action: string) => estado.ops.filter(o => o.table === table && o.action === action)

async function codigo(p: Promise<unknown>): Promise<number | 'ok'> {
  try { await p; return 'ok' } catch (e) { return e instanceof HTTPException ? e.status : -1 }
}

const PERSONAL: Record<string, { leg: string; nom: string; cat_id: number; dni: string }> = {
  '001': { leg: '001', nom: 'UNO ', cat_id: 1, dni: '11111111' },
  '002': { leg: '002', nom: 'DOS',  cat_id: 2, dni: '22222222' },
}

// Historial: qué fila devuelve el select por (leg, desde). Por defecto ninguna.
let historialExistente: { id: number } | null = null

function responderBase(op: Op): Respuesta {
  if (op.table === 'personal' && op.action === 'select') {
    if (op.eq.leg !== undefined) return { data: PERSONAL[String(op.eq.leg)] ?? null }
    if (op.eq.dni !== undefined) {
      const hit = Object.values(PERSONAL).find(p => p.dni === op.eq.dni && p.leg !== op.neq.leg)
      return { data: hit ?? null }
    }
  }
  if (op.table === 'personal' && (op.action === 'insert' || op.action === 'update')) {
    return { data: { leg: op.eq.leg ?? op.payload?.leg, ...op.payload } }
  }
  if (op.table === 'personal_cat_historial' && op.action === 'select') return { data: historialExistente }
  return { data: null }
}

const ALTA = {
  leg: '112', nom: 'NUEVO', dni: '33333333', condicion: 'asegurado' as const, modalidad: 'mes' as const,
  cat_id: 3, tel: '', dir: '', obs: '', talle_pantalon: '44', talle_botines: null, talle_camisa: undefined,
  fecha_nacimiento: null,
}

beforeEach(() => {
  estado.ops.length = 0
  historialExistente = null
  estado.responder = responderBase as never
})

describe('create', () => {
  it('guarda condición, modalidad y talles, y abre el historial en la semana en curso', async () => {
    await personalService.create(ALTA, 'tok', 'u-1')
    const [ins] = ops('personal', 'insert')
    expect(ins?.payload).toMatchObject({
      leg: '112', dni: '33333333', condicion: 'asegurado', modalidad: 'mes', cat_id: 3,
      talle_pantalon: '44', talle_botines: null, talle_camisa: null, created_by: 'u-1',
    })
    const [hist] = ops('personal_cat_historial', 'insert')
    expect(hist?.payload).toMatchObject({ leg: '112', cat_id: 3, desde: VIERNES_ACTUAL })
  })

  it('409 si el legajo ya existe, sin insertar nada', async () => {
    expect(await codigo(personalService.create({ ...ALTA, leg: '001' }, 'tok', 'u-1'))).toBe(409)
    expect(ops('personal', 'insert')).toHaveLength(0)
  })

  it('409 si el DNI ya es de otro legajo', async () => {
    await expect(personalService.create({ ...ALTA, dni: '22222222' }, 'tok', 'u-1'))
      .rejects.toThrow(/DNI_DUPLICADO.*002/)
    expect(ops('personal', 'insert')).toHaveLength(0)
  })

  it('sin DNI no se controla duplicado', async () => {
    await personalService.create({ ...ALTA, dni: '' }, 'tok', 'u-1')
    expect(estado.ops.filter(o => o.eq.dni !== undefined)).toHaveLength(0)
  })
})

describe('update', () => {
  it('editar el teléfono no toca el historial de categorías', async () => {
    await personalService.update('001', { tel: '351' }, 'tok', 'u-1')
    const [upd] = ops('personal', 'update')
    expect(upd?.payload).toEqual({ tel: '351', updated_by: 'u-1' })
    expect(estado.ops.filter(o => o.table === 'personal_cat_historial')).toHaveLength(0)
  })

  it('mandar la misma categoría tampoco', async () => {
    await personalService.update('001', { cat_id: 1, nom: 'UNO BIS' }, 'tok', 'u-1')
    expect(estado.ops.filter(o => o.table === 'personal_cat_historial')).toHaveLength(0)
  })

  it('cambiar la categoría inserta UNA fila desde el viernes en curso', async () => {
    await personalService.update('001', { cat_id: 2 }, 'tok', 'u-1')
    const [hist] = ops('personal_cat_historial', 'insert')
    expect(hist?.payload).toMatchObject({ leg: '001', cat_id: 2, desde: VIERNES_ACTUAL })
    // cat_desde / confirmar_historico no son columnas de personal
    const [upd] = ops('personal', 'update')
    expect(upd?.payload).toEqual({ cat_id: 2, updated_by: 'u-1' })
  })

  it('si ese viernes ya tenía fila, la corrige en vez de duplicarla', async () => {
    historialExistente = { id: 77 }
    await personalService.update('001', { cat_id: 2 }, 'tok', 'u-1')
    expect(ops('personal_cat_historial', 'insert')).toHaveLength(0)
    const [upd] = ops('personal_cat_historial', 'update')
    expect(upd?.eq).toEqual({ id: 77 })
    expect(upd?.payload).toMatchObject({ cat_id: 2 })
  })

  it('cat_desde en el pasado recalcula semanas cerradas: 409 salvo confirmación', async () => {
    const pasado = new Date(VIERNES_ACTUAL + 'T12:00:00Z')
    pasado.setUTCDate(pasado.getUTCDate() - 14)
    const viernesViejo = pasado.toISOString().slice(0, 10)

    expect(await codigo(personalService.update('001', { cat_id: 2, cat_desde: viernesViejo }, 'tok', 'u-1'))).toBe(409)
    expect(ops('personal', 'update')).toHaveLength(0)

    await personalService.update('001', { cat_id: 2, cat_desde: viernesViejo, confirmar_historico: true }, 'tok', 'u-1')
    const [hist] = ops('personal_cat_historial', 'insert')
    expect(hist?.payload).toMatchObject({ cat_id: 2, desde: viernesViejo })
  })

  it('409 si el DNI nuevo ya es de otro; el propio no se controla', async () => {
    await expect(personalService.update('001', { dni: '22222222' }, 'tok', 'u-1')).rejects.toThrow(/DNI_DUPLICADO/)
    expect(ops('personal', 'update')).toHaveLength(0)

    estado.ops.length = 0
    await personalService.update('001', { dni: '11111111', tel: 'x' }, 'tok', 'u-1')
    expect(estado.ops.filter(o => o.eq.dni !== undefined)).toHaveLength(0)
    expect(ops('personal', 'update')).toHaveLength(1)
  })

  it('404 si el legajo no existe', async () => {
    expect(await codigo(personalService.update('999', { tel: 'x' }, 'tok', 'u-1'))).toBe(404)
  })
})
