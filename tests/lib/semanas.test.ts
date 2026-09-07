/**
 * Regla de cierre de semanas (src/lib/semanas.ts), opción 1 del 2026-09-06:
 * sin fila en `cierres`, una semana cuyo jueves ya pasó está cerrada;
 * 'pendiente' la reabre; 'cerrado' la cierra aunque sea la actual.
 */

import { describe, it, expect } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import {
  juevesISO, semanaCerrada, viernesEntre, semanasCerradas, ensureSemanasAbiertas, ensureNoAfectaSemanasCerradas,
} from '../../src/lib/semanas.js'

function supabaseConCierres(filas: Array<{ sem_key: string; estado: string }>) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) b[m] = () => b
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: filas, error: null }).then(res)
  return { from: () => b } as unknown as Parameters<typeof semanasCerradas>[0]
}

async function codigo(p: Promise<unknown>): Promise<number | 'ok'> {
  try { await p; return 'ok' } catch (e) { return e instanceof HTTPException ? e.status : 500 }
}

describe('semanaCerrada', () => {
  const sem = '2026-08-28' // viernes; jueves = 2026-09-03
  it('jueves', () => { expect(juevesISO(sem)).toBe('2026-09-03') })
  it('sin fila: cerrada solo cuando el jueves ya pasó', () => {
    expect(semanaCerrada(undefined, sem, '2026-09-03')).toBe(false) // el mismo jueves sigue abierta
    expect(semanaCerrada(undefined, sem, '2026-09-04')).toBe(true)  // viernes siguiente: cerrada
    expect(semanaCerrada(undefined, sem, '2026-08-30')).toBe(false)
  })
  it('la fila manda: pendiente reabre, cerrado cierra', () => {
    expect(semanaCerrada('pendiente', sem, '2026-10-01')).toBe(false)
    expect(semanaCerrada('cerrado', sem, '2026-08-29')).toBe(true)
  })
  it('viernesEntre enumera los viernes', () => {
    expect(viernesEntre('2026-08-14', '2026-08-28')).toEqual(['2026-08-14', '2026-08-21', '2026-08-28'])
    expect(viernesEntre('2026-08-28', '2026-08-21')).toEqual([])
  })
})

describe('semanasCerradas / ensureSemanasAbiertas', () => {
  const hoy = '2026-09-06' // domingo; semana actual = 2026-09-04
  it('mezcla filas y regla automática', async () => {
    const sb = supabaseConCierres([{ sem_key: '2026-08-14', estado: 'pendiente' }, { sem_key: '2026-09-04', estado: 'cerrado' }])
    expect(await semanasCerradas(sb, 'CC-001', ['2026-08-14', '2026-08-21', '2026-08-28', '2026-09-04'], hoy))
      .toEqual(['2026-08-21', '2026-08-28', '2026-09-04'])
  })
  it('409 con la primera semana cerrada en el mensaje', async () => {
    const sb = supabaseConCierres([])
    await expect(ensureSemanasAbiertas(sb, 'CC-001', ['2026-08-28'], 'horas')).rejects.toMatchObject({ status: 409 })
    expect(await codigo(ensureSemanasAbiertas(supabaseConCierres([{ sem_key: '2026-08-28', estado: 'pendiente' }]), 'CC-001', ['2026-08-28']))).toBe('ok')
  })
})

describe('ensureNoAfectaSemanasCerradas', () => {
  const hoy = '2026-09-06'
  it('vigencia en la semana actual o futura: pasa', async () => {
    expect(await codigo(ensureNoAfectaSemanasCerradas(supabaseConCierres([]), 'CC-001', '2026-09-04', undefined, hoy))).toBe('ok')
    expect(await codigo(ensureNoAfectaSemanasCerradas(supabaseConCierres([]), 'CC-001', '2026-09-08', undefined, hoy))).toBe('ok')
  })
  it('vigencia pasada sin confirmar: 409; confirmada: pasa', async () => {
    expect(await codigo(ensureNoAfectaSemanasCerradas(supabaseConCierres([]), 'CC-001', '2026-08-14', undefined, hoy))).toBe(409)
    expect(await codigo(ensureNoAfectaSemanasCerradas(supabaseConCierres([]), 'CC-001', '2026-08-14', true, hoy))).toBe('ok')
  })
  it('si todas las semanas afectadas están reabiertas, pasa sin confirmar', async () => {
    const sb = supabaseConCierres([{ sem_key: '2026-08-21', estado: 'pendiente' }, { sem_key: '2026-08-28', estado: 'pendiente' }])
    expect(await codigo(ensureNoAfectaSemanasCerradas(sb, 'CC-001', '2026-08-21', undefined, hoy))).toBe('ok')
  })
  it('cambio global (sin obra) con vigencia pasada: 409 salvo confirmar', async () => {
    expect(await codigo(ensureNoAfectaSemanasCerradas(supabaseConCierres([]), null, '2026-08-28', undefined, hoy))).toBe(409)
    expect(await codigo(ensureNoAfectaSemanasCerradas(supabaseConCierres([]), null, '2026-08-28', true, hoy))).toBe('ok')
  })
})
