// Congela el cálculo canónico de costo de mano de obra por obra (portado del
// frontend src/lib/utils/costos.ts). Si una regla cambia en un solo repo,
// estos números tienen que reventar acá.
import { describe, it, expect } from 'vitest'
import { calcularCostoObra, viernesISO } from '../../../src/modules/horas/costo-obra.js'

const HOY = '2026-08-06' // jueves → semana actual = viernes 2026-07-31

const PERSONAL = [
  { leg: '001', cat_id: 1, personal_cat_historial: [] },
  { leg: '002', cat_id: 3, personal_cat_historial: [{ cat_id: 2, desde: '2026-05-01' }] },
]
const CATEGORIAS = [
  { id: 1, vh: 4900, categoria_tarifas: [{ vh: 4600, desde: '2026-06-19' }, { vh: 4900, desde: '2026-07-24' }] },
  { id: 2, vh: 4200, categoria_tarifas: [{ vh: 3950, desde: '2026-06-19' }, { vh: 4200, desde: '2026-07-24' }] },
  { id: 3, vh: 4000, categoria_tarifas: [] },
]

describe('viernesISO — semana viernes a jueves', () => {
  it('un jueves pertenece a la semana del viernes anterior', () => {
    expect(viernesISO('2026-08-06')).toBe('2026-07-31') // jue → vie anterior
    expect(viernesISO('2026-07-31')).toBe('2026-07-31') // el viernes mismo
    expect(viernesISO('2026-08-01')).toBe('2026-07-31') // sábado
  })
})

describe('calcularCostoObra — cálculo canónico', () => {
  it('semana pasada: vh global versionado vigente al VIERNES + redondeo al mil por leg', () => {
    // Semana 24/07: leg 001 cat 1 → $4.900 (versión desde 24/07).
    // 36 hs × 4.900 = 176.400 → redondeo al mil = 176.000 (caso Frias real).
    const r = calcularCostoObra({
      horas: [
        { leg: '001', fecha: '2026-07-24', horas: 9 },
        { leg: '001', fecha: '2026-07-27', horas: 9 },
        { leg: '001', fecha: '2026-07-28', horas: 9 },
        { leg: '001', fecha: '2026-07-30', horas: 9 },
      ],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [], catObra: [], hoyISO: HOY,
    })
    expect(r.total).toBe(176_000)
    expect(r.semanas).toHaveLength(1)
    expect(r.semanas[0]).toMatchObject({ sem_key: '2026-07-24', hs: 36, operarios: 1 })
  })

  it('la tarifa de OBRA le gana al precio global', () => {
    const r = calcularCostoObra({
      horas: [{ leg: '001', fecha: '2026-07-27', horas: 10 }],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [{ cat_id: 1, vh: 6000, desde: '2026-07-24' }],
      catObra: [], hoyISO: HOY,
    })
    expect(r.total).toBe(60_000) // 10 × 6.000
  })

  it('cat_obra pisa la categoría del trabajador', () => {
    // leg 001 es cat 1, pero en esta obra tiene override a cat 3 ($4.000 cache).
    const r = calcularCostoObra({
      horas: [{ leg: '001', fecha: '2026-07-27', horas: 10 }],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [], catObra: [{ leg: '001', cat_id: 3, desde: '2026-01-01' }], hoyISO: HOY,
    })
    expect(r.total).toBe(40_000)
  })

  it('historial de categoría del trabajador: usa la vigente a la fecha', () => {
    // leg 002: cat base 3, pero desde 01/05 es cat 2 → semana 24/07 usa cat 2
    // ($4.200 desde 24/07). 20 hs × 4.200 = 84.000.
    const r = calcularCostoObra({
      horas: [{ leg: '002', fecha: '2026-07-27', horas: 20 }],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [], catObra: [], hoyISO: HOY,
    })
    expect(r.total).toBe(84_000)
  })

  it('tarifa de obra toda futura → retroactivo con la más antigua', () => {
    const r = calcularCostoObra({
      horas: [{ leg: '001', fecha: '2026-07-27', horas: 10 }],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [{ cat_id: 1, vh: 5500, desde: '2026-12-01' }],
      catObra: [], hoyISO: HOY,
    })
    expect(r.total).toBe(55_000)
  })

  it('semana ACTUAL usa hoy como fecha de referencia (no el viernes)', () => {
    // Tarifa de obra que arranca HOY (06/08): la semana actual (vie 31/07)
    // la toma porque fechaRef = hoy.
    const r = calcularCostoObra({
      horas: [{ leg: '001', fecha: '2026-08-04', horas: 10 }],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [{ cat_id: 1, vh: 7000, desde: '2026-08-06' }],
      catObra: [], hoyISO: HOY,
    })
    expect(r.total).toBe(70_000)
  })

  it('hs extras suman al costo y un leg con SOLO extras cuenta', () => {
    const r = calcularCostoObra({
      horas: [{ leg: '001', fecha: '2026-07-27', horas: 10 }],
      hsExtras: [
        { leg: '001', sem_key: '2026-07-24', hs: 2 },   // 12 × 4.900 = 58.800 → 59.000
        { leg: '002', sem_key: '2026-07-24', hs: 5 },   // solo extras: 5 × 4.200 = 21.000
      ],
      personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [], catObra: [], hoyISO: HOY,
    })
    expect(r.total).toBe(59_000 + 21_000)
    expect(r.semanas[0]!.operarios).toBe(2)
  })

  it('horas decimales sin basura de coma flotante', () => {
    const r = calcularCostoObra({
      horas: [
        { leg: '001', fecha: '2026-07-27', horas: 10.2 },
        { leg: '001', fecha: '2026-07-28', horas: 10.2 },
        { leg: '001', fecha: '2026-07-29', horas: 10.2 },
      ],
      hsExtras: [], personal: PERSONAL, categorias: CATEGORIAS,
      tarifas: [], catObra: [], hoyISO: HOY,
    })
    expect(r.semanas[0]!.hs).toBe(30.6)
    expect(r.total).toBe(150_000) // 30,6 × 4.900 = 149.940 → 150.000
  })
})
