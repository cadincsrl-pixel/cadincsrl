/**
 * NC leída → `aplica_a_sugerida` (20260925a): los comprobantes asociados del
 * papel se cruzan contra las facturas abiertas del proveedor por
 * `numero_norm`, y el total de la NC se reparte con tope en `saldo_pagable`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { filas, filtros } = vi.hoisted(() => ({ filas: [] as Record<string, unknown>[], filtros: [] as unknown[][] }))

vi.mock('../../../src/lib/supabase.js', () => {
  const chain = (): any => {
    const c: any = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'limit', 'order']) c[m] = (...a: unknown[]) => { filtros.push([m, ...a]); return c }
    c.then = (res: any, rej: any) => Promise.resolve({ data: filas, error: null }).then(res, rej)
    return c
  }
  return { supabase: { from: () => chain() }, createSupabaseClient: () => ({ from: () => chain() }) }
})

import { sugerirAplicaA } from '../../../src/modules/pagos/lectura.service.js'
import type { Propuesta } from '../../../src/modules/pagos/lectura/fusion.js'

const NC = (total: number, asociados: Propuesta['comprobantes_asociados']) =>
  ({ total, clase: 'nota_credito', comprobantes_asociados: asociados }) as unknown as Propuesta

beforeEach(() => { filas.length = 0; filtros.length = 0 })

describe('sugerirAplicaA', () => {
  it('sin asociados: nada que sugerir y aviso informativo', async () => {
    const r = await sugerirAplicaA(1, NC(300, []))
    expect(r.aplica_a).toEqual([])
    expect(r.avisos[0]).toMatchObject({ codigo: 'NC_SIN_ASOCIADOS', severidad: 'info' })
  })

  it('cruza por numero_norm solo contra facturas del proveedor y reparte con tope en saldo_pagable', async () => {
    filas.push(
      { id: 5, tipo_comprobante: 'A', numero: '0001-00000045', numero_norm: '1-45', estado: 'aprobada', saldo_pagable: '100.00' },
      { id: 6, tipo_comprobante: 'A', numero: '0001-00000046', numero_norm: '1-46', estado: 'pendiente', saldo_pagable: '1000.00' },
    )
    const r = await sugerirAplicaA(3, NC(300, [
      { letra: 'A', punto_venta: '00001', numero: '00000045' },
      { letra: 'A', punto_venta: '00001', numero: '00000046' },
    ]))
    expect(r.aplica_a).toEqual([
      { factura_id: 5, monto: 100, tipo_comprobante: 'A', numero: '0001-00000045', saldo_pagable: 100 },
      { factura_id: 6, monto: 200, tipo_comprobante: 'A', numero: '0001-00000046', saldo_pagable: 1000 },
    ])
    expect(filtros).toContainEqual(['eq', 'proveedor_id', 3])
    expect(filtros).toContainEqual(['eq', 'clase', 'factura'])
  })

  it('lo que sobra queda como crédito a favor; la que no está cargada o no tiene saldo avisa', async () => {
    filas.push(
      { id: 5, tipo_comprobante: 'A', numero: '0001-00000045', numero_norm: '1-45', estado: 'aprobada', saldo_pagable: 100 },
      { id: 7, tipo_comprobante: 'A', numero: '0001-00000047', numero_norm: '1-47', estado: 'pagada', saldo_pagable: 0 },
    )
    const r = await sugerirAplicaA(3, NC(300, [
      { letra: 'A', punto_venta: '00001', numero: '00000045' },
      { letra: 'A', punto_venta: '00001', numero: '00000047' },
      { letra: 'A', punto_venta: '00009', numero: '00000001' },
    ]))
    expect(r.aplica_a).toEqual([{ factura_id: 5, monto: 100, tipo_comprobante: 'A', numero: '0001-00000045', saldo_pagable: 100 }])
    expect(r.avisos.map((a) => a.codigo)).toEqual(['NC_ASOCIADO_SIN_SALDO', 'NC_ASOCIADO_NO_ENCONTRADO', 'NC_SOBRANTE'])
  })

  it('la letra del asociado tiene que coincidir con la de la factura', async () => {
    filas.push({ id: 5, tipo_comprobante: 'B', numero: '0001-00000045', numero_norm: '1-45', estado: 'aprobada', saldo_pagable: 100 })
    const r = await sugerirAplicaA(3, NC(50, [{ letra: 'A', punto_venta: '00001', numero: '00000045' }]))
    expect(r.aplica_a).toEqual([])
  })
})
