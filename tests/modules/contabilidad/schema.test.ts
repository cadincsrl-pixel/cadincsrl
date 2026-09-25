/**
 * Schemas de Contabilidad: la partida doble del asiento confirmado (y que el
 * borrador no tenga que cuadrar), la regla de «exactamente uno > 0» por línea
 * y los schemas de cuenta/tesorería.
 */
import { describe, it, expect } from 'vitest'
import {
  GuardarAsientoSchema, LineaAsientoSchema, chequearPartidaDoble, CuentaSchema, UpdateCuentaSchema,
  TesoreriaSchema, UpdateTesoreriaSchema, ImportarPlanSchema, ListAsientosQuerySchema, FechaISO,
  PendientesQuerySchema, DiarioQuerySchema, BalanceQuerySchema, ResultadosQuerySchema,
} from '../../../src/modules/contabilidad/contabilidad.schema.js'

const L = (cuenta_id: number, debe: number, haber: number) => ({ cuenta_id, debe, haber })
const asiento = (estado: 'borrador' | 'confirmado', lineas: unknown[]) =>
  GuardarAsientoSchema.safeParse({ fecha: '2026-08-10', glosa: 'Pago de luz', estado, lineas })

describe('chequearPartidaDoble', () => {
  it('cuadra al centavo (0,1 + 0,2 = 0,3)', () => {
    expect(chequearPartidaDoble([L(1, 0.1, 0), L(2, 0.2, 0), L(3, 0, 0.3)])).toBeNull()
  })
  it('menos de dos líneas', () => {
    expect(chequearPartidaDoble([L(1, 10, 0)])?.code).toBe('MENOS_DE_DOS_LINEAS')
  })
  it('desbalanceado con la diferencia', () => {
    expect(chequearPartidaDoble([L(1, 100, 0), L(2, 0, 99.99)])).toEqual({
      code: 'ASIENTO_DESBALANCEADO', detail: { debe: 100, haber: 99.99, diferencia: 0.01 },
    })
  })
  it('total cero', () => {
    expect(chequearPartidaDoble([L(1, 0, 0), L(2, 0, 0)])?.code).toBe('ASIENTO_TOTAL_CERO')
  })
})

describe('GuardarAsientoSchema', () => {
  it('confirmado balanceado pasa; tipo default manual; glosa de línea default ""', () => {
    const r = asiento('confirmado', [L(1, 1500.5, 0), L(2, 0, 1500.5)])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tipo).toBe('manual')
      expect(r.data.lineas[0]!.glosa).toBe('')
    }
  })

  it('confirmado desbalanceado → ASIENTO_DESBALANCEADO con debe/haber/diferencia en params', () => {
    const r = asiento('confirmado', [L(1, 100, 0), L(2, 0, 90)])
    expect(r.success).toBe(false)
    const i = r.error!.issues[0] as any
    expect(i.message).toBe('ASIENTO_DESBALANCEADO')
    expect(i.path).toEqual(['lineas'])
    expect(i.params).toEqual({ debe: 100, haber: 90, diferencia: 10 })
  })

  it('confirmado con una línea → MENOS_DE_DOS_LINEAS', () => {
    const r = asiento('confirmado', [L(1, 100, 0)])
    expect(r.error!.issues[0]!.message).toBe('MENOS_DE_DOS_LINEAS')
  })

  it('borrador desbalanceado y de una línea pasa', () => {
    expect(asiento('borrador', [L(1, 100, 0)]).success).toBe(true)
    expect(asiento('borrador', [L(1, 100, 0), L(2, 0, 1)]).success).toBe(true)
  })

  it('sin líneas → SIN_LINEAS', () => {
    expect(asiento('borrador', []).error!.issues[0]!.message).toBe('SIN_LINEAS')
  })

  it('línea con debe y haber, o con los dos en cero → LINEA_IMPORTE_INVALIDO en la línea', () => {
    const r = asiento('confirmado', [L(1, 100, 0), L(2, 50, 50)])
    expect(r.success).toBe(false)
    expect(r.error!.issues[0]).toMatchObject({ message: 'LINEA_IMPORTE_INVALIDO', path: ['lineas', 1, 'haber'] })
    const r2 = asiento('borrador', [L(1, 0, 0)])
    expect(r2.error!.issues[0]).toMatchObject({ message: 'LINEA_IMPORTE_INVALIDO', path: ['lineas', 0, 'debe'] })
  })

  it('medio centavo redondea a cero → inválida', () => {
    expect(LineaAsientoSchema.safeParse(L(1, 0.004, 0)).success).toBe(false)
  })

  it('negativos y glosa corta se rechazan', () => {
    expect(asiento('borrador', [L(1, -1, 0)]).success).toBe(false)
    const r = GuardarAsientoSchema.safeParse({ fecha: '2026-08-10', glosa: ' a ', estado: 'borrador', lineas: [L(1, 1, 0)] })
    expect(r.error!.issues[0]!.message).toBe('GLOSA_REQUERIDA')
  })

  it('estado y tipo fuera de la lista', () => {
    expect(GuardarAsientoSchema.safeParse({ fecha: '2026-08-10', glosa: 'xxx', estado: 'anulado', lineas: [L(1, 1, 0)] }).success).toBe(false)
    expect(GuardarAsientoSchema.safeParse({ fecha: '2026-08-10', glosa: 'xxx', tipo: 'automatico', estado: 'borrador', lineas: [L(1, 1, 0)] }).success).toBe(false)
  })
})

describe('FechaISO', () => {
  it('rechaza fechas inexistentes', () => {
    expect(FechaISO.safeParse('2026-02-30').success).toBe(false)
    expect(FechaISO.safeParse('2026-02-28').success).toBe(true)
  })
})

describe('CuentaSchema', () => {
  it('código válido y defaults', () => {
    const r = CuentaSchema.parse({ codigo: ' 1.1.01.001 ', nombre: 'Caja', imputable: true })
    expect(r).toEqual({ codigo: '1.1.01.001', nombre: 'Caja', imputable: true, auxiliar: 'none', obs: '' })
  })
  it.each(['0', '1.', '1.1234', '1.1.1.1.1.1.1', 'a.1', '01'])('código %s → CODIGO_INVALIDO', (codigo) => {
    const r = CuentaSchema.safeParse({ codigo, nombre: 'Caja', imputable: true })
    expect(r.error!.issues[0]!.message).toBe('CODIGO_INVALIDO')
  })
  it('el PATCH no inventa defaults', () => {
    expect(UpdateCuentaSchema.parse({ nombre: 'Otro' })).toEqual({ nombre: 'Otro' })
  })
})

describe('TesoreriaSchema', () => {
  it('moneda default ARS; CBU de 22 dígitos', () => {
    expect(TesoreriaSchema.parse({ tipo: 'caja', nombre: 'Caja chica' }).moneda).toBe('ARS')
    expect(TesoreriaSchema.safeParse({ tipo: 'banco', nombre: 'Galicia', cbu: '123' }).success).toBe(false)
  })
  it('el PATCH no inventa defaults', () => {
    expect(UpdateTesoreriaSchema.parse({ obs: 'x' })).toEqual({ obs: 'x' })
  })
})

describe('ImportarPlanSchema', () => {
  it('pide filas o csv', () => {
    expect(ImportarPlanSchema.safeParse({}).error!.issues[0]!.message).toBe('SIN_FILAS')
    expect(ImportarPlanSchema.parse({ csv: 'codigo;nombre\n1;A' }).confirmar).toBe(false)
  })
})

describe('ListAsientosQuerySchema', () => {
  it('defaults y coerción', () => {
    expect(ListAsientosQuerySchema.parse({ cuenta_id: '7', limit: '20' })).toMatchObject({ estado: 'todos', cuenta_id: 7, limit: 20, offset: 0 })
    expect(ListAsientosQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })
})

describe('tanda 4: fuentes, modo y nivel', () => {
  it('fuentes CSV → array; vacío → undefined; inválida → error', () => {
    expect(PendientesQuerySchema.parse({ fuentes: 'ventas_facturas, pagos_ordenes' }).fuentes).toEqual(['ventas_facturas', 'pagos_ordenes'])
    expect(PendientesQuerySchema.parse({}).fuentes).toBeUndefined()
    expect(PendientesQuerySchema.parse({ fuentes: '' }).fuentes).toBeUndefined()
    expect(PendientesQuerySchema.safeParse({ fuentes: 'ventas_facturas,cualquiera' }).success).toBe(false)
  })
  it('modo del diario: default detallado; dia y mes; otro → error', () => {
    const base = { desde: '2026-07-01', hasta: '2026-07-31' }
    expect(DiarioQuerySchema.parse(base).modo).toBe('detallado')
    expect(DiarioQuerySchema.parse({ ...base, modo: 'mes' }).modo).toBe('mes')
    expect(DiarioQuerySchema.safeParse({ ...base, modo: 'anio' }).success).toBe(false)
  })
  it('nivel de los estados: defaults 3 y 4, rango 1 a 5', () => {
    expect(BalanceQuerySchema.parse({ fecha: '2026-09-30' }).nivel).toBe(3)
    expect(ResultadosQuerySchema.parse({ desde: '2026-07-01', hasta: '2026-09-30' }).nivel).toBe(4)
    expect(BalanceQuerySchema.safeParse({ fecha: '2026-09-30', nivel: '6' }).success).toBe(false)
    expect(ResultadosQuerySchema.safeParse({ desde: '2026-07-01', hasta: '2026-09-30', nivel: '0' }).success).toBe(false)
  })
})
