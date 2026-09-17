/**
 * El resumen de cuenta corriente de todas las obras (17/09): las reglas que
 * mueven plata, congeladas.
 *
 * La fórmula de jornales no se prueba acá — es `calcularCostoObra`, que tiene
 * su propio test con los mismos números que el front. Lo que se cuida acá es
 * lo que se hace CON ese costo: el % por pata, la regla del régimen, las
 * semanas congeladas y el saldo.
 */

import { describe, it, expect } from 'vitest'
import { armarResumenObras, type DatosResumenObras } from '../../../src/modules/cuenta-cliente/resumen-obras.js'

const HOY = '2026-09-17' // jueves → semana en curso = viernes 2026-09-11

// Un operario, categoría 1 a $5.000 la hora, sin tarifa de obra: cada semana
// de 40 hs cuesta 200.000 (redondeo al mil por leg no cambia nada).
const PERSONAL   = [{ leg: '001', cat_id: 1, personal_cat_historial: [] }]
const CATEGORIAS = [{ id: 1, vh: 5000, categoria_tarifas: [{ vh: 5000, desde: '2026-01-02' }] }]

function base(over: Partial<DatosResumenObras> = {}): DatosResumenObras {
  return {
    obras: [{ cod: 'ADM', nom: 'Por administración', archivada: false, por_administracion: true }],
    horasSemLeg: [
      { obra_cod: 'ADM', sem_key: '2026-08-28', leg: '001', horas: 40 },
      { obra_cod: 'ADM', sem_key: '2026-09-04', leg: '001', horas: 40 },
    ],
    hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS, tarifas: [], catObra: [],
    pcts: [{ obra_cod: 'ADM', desde: '2026-01-02', pct_operarios: 35, pct_contratistas: 20, pct_materiales: 10 }],
    certs: [{ obra_cod: 'ADM', sem_key: '2026-09-04', monto: 100000 }],
    imputaciones: [],
    materiales: [
      { obra_cod: 'ADM', fecha_resolucion: '2026-09-01', precio_total: 50000, precio_unit: 500 },
      { obra_cod: 'ADM', fecha_resolucion: '2026-09-02', precio_total: 0,     precio_unit: 0 },
    ],
    cobros: [{ obra_cod: 'ADM', monto: 100000 }],
    notas:  [{ obra_cod: 'ADM', monto: 5000 }],
    ...over,
  }
}

describe('armarResumenObras — obra por administración', () => {
  it('cada pata lleva su %, y el saldo es total − pagado − notas', () => {
    const [f] = armarResumenObras(base(), HOY, true)
    expect(f!.regimen).toBe('administracion')
    // Jornales: 2 semanas × 200.000 = 400.000 al costo → ×1,35 = 540.000
    expect(f!.jornales).toMatchObject({ costo: 400000, facturable: 540000, en_cuenta: true, pct: 35 })
    // Contratistas: 100.000 ×1,20 = 120.000
    expect(f!.contratistas).toMatchObject({ costo: 100000, facturable: 120000, en_cuenta: true, pct: 20 })
    // Materiales: 50.000 ×1,10 = 55.000, y UN renglón sin precio
    expect(f!.materiales).toMatchObject({ costo: 50000, facturable: 55000, sin_precio: 1, pct: 10 })
    expect(f!.total).toBe(540000 + 120000 + 55000)
    expect(f!.pagado).toBe(100000)
    expect(f!.notas).toBe(5000)
    expect(f!.saldo).toBe(715000 - 100000 - 5000)
    expect(f!.sin_pct).toBe(false)
    expect(f!.parcial).toBe(false)
  })

  it('una semana ya pagada usa el monto congelado, no el cálculo vivo', () => {
    const [f] = armarResumenObras(base({
      imputaciones: [{ obra_cod: 'ADM', sem_key: '2026-08-28', pata: 'operarios', monto: 123456 }],
    }), HOY, true)
    // Semana del 28/08 congelada en 123.456; la del 04/09 sigue viva: 270.000
    expect(f!.jornales!.facturable).toBe(123456 + 270000)
    expect(f!.jornales!.costo).toBe(400000) // el costo puro no cambia
  })

  it('el % se aplica por semana con la versión vigente: un cambio vale desde su viernes', () => {
    const [f] = armarResumenObras(base({
      pcts: [
        { obra_cod: 'ADM', desde: '2026-01-02', pct_operarios: 0,  pct_contratistas: 0, pct_materiales: 0 },
        { obra_cod: 'ADM', desde: '2026-09-04', pct_operarios: 50, pct_contratistas: 0, pct_materiales: 0 },
      ],
    }), HOY, true)
    // 28/08 al 0% = 200.000; 04/09 al 50% = 300.000
    expect(f!.jornales!.facturable).toBe(500000)
    expect(f!.jornales!.pct).toBe(50) // el vigente HOY
  })

  it('sin porcentajes cargados calcula al costo y lo dice (sin_pct)', () => {
    const [f] = armarResumenObras(base({ pcts: [] }), HOY, true)
    expect(f!.sin_pct).toBe(true)
    expect(f!.jornales!.facturable).toBe(400000)
    expect(f!.jornales!.pct).toBeNull()
  })

  it('sin permiso de tarja: sin jornales ni contratistas, total parcial y marcado', () => {
    const [f] = armarResumenObras(base(), HOY, false)
    expect(f!.jornales).toBeNull()
    expect(f!.contratistas).toBeNull()
    expect(f!.parcial).toBe(true)
    expect(f!.total).toBe(55000) // solo materiales
  })
})

describe('armarResumenObras — obra de presupuesto cerrado', () => {
  it('jornales y contratistas se devuelven como costo pero NO entran al total ni al saldo', () => {
    const [f] = armarResumenObras(base({
      obras: [{ cod: 'ADM', nom: 'Presupuesto cerrado', archivada: false, por_administracion: false }],
    }), HOY, true)
    expect(f!.regimen).toBe('presupuesto_cerrado')
    expect(f!.jornales).toMatchObject({ costo: 400000, facturable: 400000, en_cuenta: false, pct: null })
    expect(f!.contratistas).toMatchObject({ costo: 100000, facturable: 100000, en_cuenta: false })
    // Los porcentajes de la base se ignoran aunque existan: materiales al costo.
    expect(f!.materiales.facturable).toBe(50000)
    expect(f!.total).toBe(50000)
    expect(f!.saldo).toBe(50000 - 100000 - 5000)
    expect(f!.sin_pct).toBe(false) // no aplica al régimen
  })
})

describe('armarResumenObras — varias obras', () => {
  it('ordena por saldo descendente y no mezcla los datos entre obras', () => {
    const filas = armarResumenObras(base({
      obras: [
        { cod: 'A', nom: 'Chica',  archivada: false, por_administracion: false },
        { cod: 'B', nom: 'Grande', archivada: true,  por_administracion: false },
      ],
      horasSemLeg: [], certs: [], pcts: [], imputaciones: [], cobros: [], notas: [],
      materiales: [
        { obra_cod: 'A', fecha_resolucion: '2026-09-01', precio_total: 1000,  precio_unit: 10 },
        { obra_cod: 'B', fecha_resolucion: '2026-09-01', precio_total: 99000, precio_unit: 10 },
      ],
    }), HOY, true)
    expect(filas.map(f => f.obra_cod)).toEqual(['B', 'A'])
    expect(filas[0]!.saldo).toBe(99000)
    expect(filas[0]!.archivada).toBe(true)
    expect(filas[1]!.saldo).toBe(1000)
  })
})
