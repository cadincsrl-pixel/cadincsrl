/**
 * Motor de cálculo de Sueldos (TS puro) con los valores de los seeds de sep-2026.
 */
import { describe, it, expect } from 'vitest'
import {
  calcularRecibo, calcularSac, calcularVacaciones, calcularFinal, diasVacacionesPorAntiguedad,
  aniosAntiguedad, rangoPeriodo, cuilValido, cbuValido, r2, totalesDe, entradasPorDefecto, lineasParaGuardar,
  CalculoError, type LiquidacionMotor, type HistorialFila,
} from '../../../src/modules/sueldos/calculo.js'
import { valoresUocra, valoresUecara, valoresCamioneros, legajo } from './fixtures.js'

const Q2: LiquidacionMotor = { tipo: 'quincena', periodo: '2026-09-01', quincena: 2 }
const Q1: LiquidacionMotor = { tipo: 'quincena', periodo: '2026-09-01', quincena: 1 }
const MES: LiquidacionMotor = { tipo: 'mensual', periodo: '2026-09-01', quincena: null }
const imp = (r: ReturnType<typeof calcularRecibo>, codigo: string) => r.lineas.find(l => l.codigo === codigo)?.importe

describe('utilidades', () => {
  it('r2 redondea a centavos (también negativos)', () => {
    expect(r2(75132.288)).toBe(75132.29)
    expect(r2(1.005)).toBe(1.01)
    expect(r2(-1.005)).toBe(-1.01)
  })
  it('rango de quincenas y mes', () => {
    expect(rangoPeriodo(Q1)).toEqual({ desde: '2026-09-01', hasta: '2026-09-15' })
    expect(rangoPeriodo(Q2)).toEqual({ desde: '2026-09-16', hasta: '2026-09-30' })
    expect(rangoPeriodo({ tipo: 'mensual', periodo: '2028-02-01', quincena: null })).toEqual({ desde: '2028-02-01', hasta: '2028-02-29' })
  })
  it('años completos de antigüedad', () => {
    expect(aniosAntiguedad('2020-10-01', '2026-09-30')).toBe(5)
    expect(aniosAntiguedad('2020-09-30', '2026-09-30')).toBe(6)
    expect(aniosAntiguedad(null, '2026-09-30')).toBe(0)
    expect(aniosAntiguedad('2027-01-01', '2026-09-30')).toBe(0)
  })
  it('CUIL y CBU con dígito verificador', () => {
    expect(cuilValido('20-33048588-5')).toBe(true)
    expect(cuilValido('20123456787')).toBe(false)
    expect(cuilValido('20123456786')).toBe(true)
    expect(cuilValido('2012345678')).toBe(false)
    expect(cbuValido('2850590940090418135201')).toBe(true)
    expect(cbuValido('2850590940090418135202')).toBe(false)
  })
})

describe('UOCRA quincena', () => {
  it('oficial afiliado, 88 h, asistencia, 2ª quincena (seguro de vida y SCVO van en la 2ª)', () => {
    const r = calcularRecibo({ legajo: legajo(), liquidacion: Q2, valores: valoresUocra(), entradas: { horas_normales: 88, asistencia: true } })
    expect(imp(r, 'basico')).toBe(569184)
    expect(imp(r, 'asistencia')).toBe(113836.8)
    expect(r.totales.remunerativo).toBe(683020.8)
    expect(imp(r, 'jubilacion')).toBe(75132.29)
    expect(imp(r, 'ley_19032')).toBe(20490.62)
    expect(imp(r, 'obra_social')).toBe(20490.62)
    expect(imp(r, 'cuota_sindical')).toBe(17075.52)
    expect(imp(r, 'aporte_solidario')).toBeUndefined()
    expect(imp(r, 'seguro_vida')).toBe(19989.9)
    expect(r.totales.descuentos).toBe(153178.95)
    expect(r.totales.neto).toBe(529841.85)
    // 18 % sobre (rem − media detracción)
    expect(imp(r, 'contrib_ss')).toBe(r2((683020.8 - 3501.84) * 0.18))
    expect(imp(r, 'contrib_os')).toBe(40981.25)
    expect(imp(r, 'contrib_especial')).toBe(13660.42)
    expect(imp(r, 'scvo')).toBe(424.62)
    expect(imp(r, 'art')).toBeUndefined() // valor 0 → sin línea
    expect(imp(r, 'fondo_cese_1')).toBe(81962.5)
    expect(imp(r, 'fondo_cese_2')).toBeUndefined()
    expect(r.totales.fondo_cese).toBe(81962.5)
    expect(r.totales.contribuciones).toBe(r2(imp(r, 'contrib_ss')! + 40981.25 + 13660.42 + 424.62))
    expect(r.totales.costo_total).toBe(r2(683020.8 + r.totales.contribuciones + 81962.5))
    expect(r.horas_trabajadas).toBe(88)
    expect(r.avisos.map(a => a.codigo)).toEqual(expect.arrayContaining(['CONCEPTO_SIN_VALOR', 'ESCALA_A_CONFIRMAR', 'VALOR_A_CONFIRMAR']))
    expect(r.avisos.find(a => a.codigo === 'CONCEPTO_SIN_VALOR')?.detalle).toEqual({ conceptos: ['ieric'] })
  })

  it('no afiliado → aporte solidario 2 %; 1ª quincena sin seguro de vida ni SCVO; fondo de cese 8 % con antigüedad ≥ 1', () => {
    const r = calcularRecibo({
      legajo: legajo({ afiliado_sindicato: false, fecha_ingreso: '2020-01-10' }), liquidacion: Q1, valores: valoresUocra('2026-09-15'),
      entradas: { horas_normales: 88 },
    })
    expect(imp(r, 'cuota_sindical')).toBeUndefined()
    expect(imp(r, 'aporte_solidario')).toBe(r2(683020.8 * 0.02))
    expect(imp(r, 'seguro_vida')).toBeUndefined()
    expect(imp(r, 'scvo')).toBeUndefined()
    expect(imp(r, 'fondo_cese_1')).toBeUndefined()
    expect(imp(r, 'fondo_cese_2')).toBe(r2(683020.8 * 0.08))
    expect(r.antiguedad_anios).toBe(6)
  })

  it('sin asistencia, con extras 50/100 y préstamo', () => {
    const r = calcularRecibo({
      legajo: legajo(), liquidacion: Q2, valores: valoresUocra(),
      entradas: { horas_normales: 80, horas_extra_50: 4, horas_extra_100: 2, asistencia: false, prestamos: 50000 },
    })
    expect(imp(r, 'asistencia')).toBeUndefined()
    expect(imp(r, 'horas_extra_50')).toBe(r2(4 * 6468 * 1.5))
    expect(imp(r, 'horas_extra_100')).toBe(2 * 6468 * 2)
    const prestamo = r.lineas.find(l => l.codigo === 'prestamo')!
    expect(prestamo.importe).toBe(50000)
    expect(prestamo.destino).toBe('prestamo')
    expect(prestamo.manual).toBe(true)
    expect(r.horas_trabajadas).toBe(86)
  })

  it('RIFL: contribución reducida en vez del 18 %', () => {
    const r = calcularRecibo({ legajo: legajo({ rifl: true }), liquidacion: Q2, valores: valoresUocra(), entradas: { horas_normales: 88 } })
    expect(imp(r, 'contrib_ss')).toBeUndefined()
    expect(imp(r, 'contrib_rifl')).toBe(r2(683020.8 * 0.05))
  })

  it('sereno (mensual en convenio quincenal): media escala por quincena', () => {
    const r = calcularRecibo({ legajo: legajo({ categoria_id: 13 }), liquidacion: Q2, valores: valoresUocra(), entradas: {} })
    expect(imp(r, 'basico')).toBe(r2(999495 / 2))
    expect(r.dias_trabajados).toBe(15)
    expect(r.unidad_basico).toBe('mes')
  })

  it('adicional por tarea con % propio, línea libre y omitir', () => {
    const r = calcularRecibo({
      legajo: legajo(), liquidacion: Q2, valores: valoresUocra(),
      entradas: {
        horas_normales: 88,
        conceptos: [{ codigo: 'adicional_tarea', porcentaje: 15 }],
        lineas_libres: [{ nombre: 'Premio producción', tipo: 'remunerativo', importe: 10000 }],
        omitir: ['seguro_vida'],
      },
    })
    expect(imp(r, 'adicional_tarea')).toBe(r2(569184 * 0.15))
    expect(r.lineas.find(l => l.nombre === 'Premio producción')?.manual).toBe(true)
    expect(imp(r, 'seguro_vida')).toBeUndefined()
    expect(r.totales.remunerativo).toBe(r2(569184 + 113836.8 + 569184 * 0.15 + 10000))
  })

  it('errores: sin categoría, sin escala, concepto desconocido, manual sin importe', () => {
    const v = valoresUocra()
    const run = (p: Partial<Parameters<typeof calcularRecibo>[0]>) => () => calcularRecibo({ legajo: legajo(), liquidacion: Q2, valores: v, entradas: {}, ...p })
    expect(run({ legajo: legajo({ categoria_id: null }) })).toThrow(CalculoError)
    expect(run({ legajo: legajo({ categoria_id: 14 }) })).toThrow('SIN_ESCALA')
    expect(run({ entradas: { conceptos: [{ codigo: 'no_existe' }] } })).toThrow('CONCEPTO_DESCONOCIDO')
    expect(run({ entradas: { conceptos: [{ codigo: 'sac' }] } })).toThrow('IMPORTE_REQUERIDO')
  })

  it('las líneas para la base cuadran con los totales y no llevan campos extra', () => {
    const r = calcularRecibo({ legajo: legajo(), liquidacion: Q2, valores: valoresUocra(), entradas: { horas_normales: 88 } })
    const g = lineasParaGuardar(r.lineas)
    expect(totalesDe(g)).toEqual(r.totales)
    expect(Object.keys(g[0]!)).not.toContain('a_confirmar')
    expect(g.map(x => x.orden)).toEqual(g.map((_, i) => i))
  })
})

describe('UECARA mensual', () => {
  it('básico completo, antigüedad × años, título A y presentismo', () => {
    const r = calcularRecibo({
      legajo: legajo({ categoria_id: 21, fecha_ingreso: '2023-05-02', titulo_nivel: 'A', afiliado_sindicato: true }),
      liquidacion: MES, valores: valoresUecara(), entradas: { dias_trabajados: 30 },
    })
    expect(imp(r, 'basico')).toBe(1624878)
    expect(imp(r, 'antiguedad')).toBe(3 * 13844)
    expect(r.lineas.find(l => l.codigo === 'antiguedad')?.cantidad).toBe(3)
    expect(imp(r, 'titulo_a')).toBe(75742)
    expect(imp(r, 'titulo_c')).toBeUndefined()
    expect(imp(r, 'presentismo')).toBe(162487.8)
    const rem = r2(1624878 + 41532 + 75742 + 162487.8)
    expect(r.totales.remunerativo).toBe(rem)
    expect(imp(r, 'jubilacion')).toBe(r2(rem * 0.11))
    // cuota sindical UECARA sin valor → aviso, no línea
    expect(imp(r, 'cuota_sindical')).toBeUndefined()
    expect(r.avisos.find(a => a.codigo === 'CONCEPTO_SIN_VALOR')?.detalle).toEqual({ conceptos: ['cuota_sindical', 'fal'] })
    // detracción entera en la mensual
    expect(imp(r, 'contrib_ss')).toBe(r2((rem - 7003.68) * 0.18))
  })

  it('proporcional a los días y sin presentismo', () => {
    const r = calcularRecibo({
      legajo: legajo({ categoria_id: 21, fecha_ingreso: '2026-09-11' }), liquidacion: MES, valores: valoresUecara(),
      entradas: { dias_trabajados: 20, presentismo: false },
    })
    expect(imp(r, 'basico')).toBe(r2((1624878 / 30) * 20))
    expect(imp(r, 'presentismo')).toBeUndefined()
    expect(imp(r, 'antiguedad')).toBeUndefined()
    expect(r.dias_trabajados).toBe(20)
  })

  it('falla de caja solo si se agrega', () => {
    const r = calcularRecibo({ legajo: legajo({ categoria_id: 21 }), liquidacion: MES, valores: valoresUecara(), entradas: { conceptos: [{ codigo: 'falla_caja' }] } })
    expect(imp(r, 'falla_caja')).toBe(73143)
  })
})

describe('Camioneros mensual', () => {
  it('básico, antigüedad 1 %/año, km remunerativo + viático por km, viáticos por cantidad, cuota 3 %, sepelio, OSCHOCA', () => {
    const r = calcularRecibo({
      legajo: legajo({ categoria_id: 31, fecha_ingreso: '2021-08-01', afiliado_sindicato: false }), liquidacion: MES, valores: valoresCamioneros(),
      entradas: { km: 5000, conceptos: [{ codigo: 'viatico_comida', cantidad: 10 }, { codigo: 'pernocte', cantidad: 4 }] },
    })
    const basico = 1095276.83
    expect(imp(r, 'basico')).toBe(basico)
    expect(imp(r, 'antiguedad')).toBe(r2(basico * 0.01 * 5))
    expect(imp(r, 'km_remunerativo')).toBe(400450)
    expect(imp(r, 'viatico_km')).toBe(400450)
    expect(imp(r, 'viatico_comida')).toBe(164630)
    expect(imp(r, 'pernocte')).toBe(76700)
    expect(imp(r, 'suma_acuerdo')).toBe(18000)
    const rem = r2(basico + r2(basico * 0.05) + 400450)
    expect(r.totales.remunerativo).toBe(rem)
    expect(r.totales.no_remunerativo).toBe(r2(400450 + 164630 + 76700 + 18000))
    expect(imp(r, 'cuota_sindical')).toBe(r2(rem * 0.03))
    expect(imp(r, 'sepelio')).toBe(r2(rem * 0.015))
    expect(imp(r, 'oschoca')).toBe(29000)
    // los no remunerativos no llevan aportes
    expect(imp(r, 'jubilacion')).toBe(r2(rem * 0.11))
    expect(r.lineas.find(l => l.codigo === 'oschoca')?.destino).toBe('sindicato')
  })

  it('sin km no hay líneas de km', () => {
    const r = calcularRecibo({ legajo: legajo({ categoria_id: 31 }), liquidacion: MES, valores: valoresCamioneros(), entradas: {} })
    expect(imp(r, 'km_remunerativo')).toBeUndefined()
    expect(imp(r, 'viatico_km')).toBeUndefined()
  })
})

describe('SAC, vacaciones y final', () => {
  const hist: HistorialFila[] = [
    { periodo: '2026-07-01', tipo: 'quincena', total_remunerativo: 600000, total_no_remunerativo: 0, dias_trabajados: null, horas_trabajadas: 88, recibos: 1 },
    { periodo: '2026-07-01', tipo: 'quincena', total_remunerativo: 650000, total_no_remunerativo: 0, dias_trabajados: null, horas_trabajadas: 88, recibos: 1 },
    { periodo: '2026-08-01', tipo: 'quincena', total_remunerativo: 700000, total_no_remunerativo: 0, dias_trabajados: null, horas_trabajadas: 88, recibos: 1 },
    { periodo: '2026-08-01', tipo: 'quincena', total_remunerativo: 500000, total_no_remunerativo: 0, dias_trabajados: null, horas_trabajadas: 88, recibos: 1 },
    { periodo: '2026-09-01', tipo: 'sac', total_remunerativo: 9999999, total_no_remunerativo: 0, dias_trabajados: null, horas_trabajadas: null, recibos: 1 },
  ]
  it('SAC: 50 % de la mejor remuneración mensual (suma de quincenas), sin contar liquidaciones de SAC', () => {
    const s = calcularSac({ historial: hist, anio: 2026, semestre: 2, fecha_ingreso: '2020-01-01' })
    expect(s.mejor_periodo).toBe('2026-07-01')
    expect(s.mejor_remuneracion).toBe(1250000)
    expect(s.importe).toBe(625000)
    expect(s.proporcional).toBe(false)
  })
  it('SAC proporcional si ingresó en el semestre; sin historial avisa', () => {
    const s = calcularSac({ historial: hist, anio: 2026, semestre: 2, fecha_ingreso: '2026-10-01' })
    expect(s.dias_computados).toBe(92)
    expect(s.importe).toBe(r2(625000 * 92 / 184))
    const v = calcularSac({ historial: [], anio: 2026, semestre: 1, fecha_ingreso: null })
    expect(v.importe).toBe(0)
    expect(v.avisos[0]?.codigo).toBe('SIN_HISTORIAL')
  })
  it('días de vacaciones por antigüedad', () => {
    expect([0, 4, 5, 9, 10, 19, 20, 30].map(diasVacacionesPorAntiguedad)).toEqual([14, 14, 21, 21, 28, 28, 35, 35])
  })
  it('vacaciones UOCRA = días × jornal; mensual = sueldo / 25; proporcional con < 6 meses', () => {
    const u = calcularVacaciones({ anio: 2026, fecha_ingreso: '2019-03-01', unidad_basico: 'hora', valor_escala: 6468, horas_dia: 9, divisor: 25 })
    expect(u.dias).toBe(21)
    expect(u.valor_dia).toBe(58212)
    expect(u.importe).toBe(21 * 58212)
    const m = calcularVacaciones({ anio: 2026, fecha_ingreso: '2025-01-01', unidad_basico: 'mes', valor_escala: 1624878, horas_dia: null, divisor: 25 })
    expect(m.valor_dia).toBe(r2(1624878 / 25))
    expect(m.dias).toBe(14)
    const p = calcularVacaciones({ anio: 2026, fecha_ingreso: '2026-09-01', unidad_basico: 'mes', valor_escala: 1624878, horas_dia: null, divisor: 25 })
    expect(p.criterio).toBe('proporcional')
    expect(p.dias).toBe(Math.floor(122 / 20))
  })
  it('final: SAC proporcional hasta el egreso + vacaciones no gozadas proporcionales', () => {
    const f = calcularFinal({
      fecha_egreso: '2026-09-30', fecha_ingreso: '2020-01-01', historial: hist, unidad_basico: 'hora',
      valor_escala: 6468, horas_dia: 9, divisor: 25, dias_gozados: 0,
    })
    expect(f.sac_proporcional.dias_computados).toBe(92)
    expect(f.sac_proporcional.importe).toBe(r2(625000 * 92 / 184))
    expect(f.vacaciones_no_gozadas.dias_anuales).toBe(21)
    expect(f.vacaciones_no_gozadas.dias).toBe(r2(21 * 273 / 365))
    expect(f.vacaciones_no_gozadas.importe).toBe(r2(f.vacaciones_no_gozadas.dias * 58212))
  })

  it('en una liquidación de SAC no entran solos los haberes, sí los aportes sobre el SAC', () => {
    const r = calcularRecibo({
      legajo: legajo(), liquidacion: { tipo: 'sac', periodo: '2026-12-01', quincena: null }, valores: valoresUocra('2026-12-31'),
      entradas: { horas_normales: 88, conceptos: [{ codigo: 'sac', importe: 625000 }] },
    })
    expect(imp(r, 'basico')).toBeUndefined()
    expect(imp(r, 'asistencia')).toBeUndefined()
    expect(imp(r, 'sac')).toBe(625000)
    expect(imp(r, 'jubilacion')).toBe(68750)
    expect(imp(r, 'scvo')).toBeUndefined()
    expect(imp(r, 'contrib_ss')).toBe(112500) // sin detracción fuera de la liquidación regular
  })
})

describe('entradas por defecto (Generar)', () => {
  it('UOCRA: horas de tarja como sugerencia y asistencia', () => {
    expect(entradasPorDefecto({ liquidacion: Q2, unidad_basico: 'hora', fecha_ingreso: null, fecha_egreso: null, horas_tarja: 87.5, saldo_prestamos: 30000 }))
      .toEqual({ horas_normales: 87.5, asistencia: true, prestamos: 30000 })
  })
  it('mensual: días dentro de ingreso/egreso', () => {
    expect(entradasPorDefecto({ liquidacion: MES, unidad_basico: 'mes', fecha_ingreso: '2026-09-11', fecha_egreso: null }))
      .toEqual({ dias_trabajados: 20, presentismo: true })
    expect(entradasPorDefecto({ liquidacion: MES, unidad_basico: 'mes', fecha_ingreso: '2020-01-01', fecha_egreso: null }))
      .toEqual({ dias_trabajados: 30, presentismo: true })
  })
})
