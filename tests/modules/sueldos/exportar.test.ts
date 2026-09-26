/**
 * Exportaciones de Sueldos (puras): banco CSV, resumen para el contador y LSD.
 */
import { describe, it, expect } from 'vitest'
import { exportarBanco, resumenContador, generarLsd, generarConceptosLsd, type EmpleadoExport, type LiquidacionExport } from '../../../src/modules/sueldos/exportar.js'

const LIQ: LiquidacionExport = {
  id: 5, codigo: 'LIQ-0005', numero: 5, tipo: 'quincena', periodo: '2026-09-01', quincena: 2, fecha_pago: '2026-10-05',
  estado: 'cerrada', convenio: { codigo: 'uocra', nombre: 'UOCRA' },
}

function emp(p: Partial<EmpleadoExport> = {}): EmpleadoExport {
  return {
    legajo_id: 1, leg: '112', nombre: 'Pérez; Juan', cuil: '20123456786', cbu: '2850590940090418135201', categoria: 'Oficial',
    obra_social_codigo: '126205', conyuge_a_cargo: false, hijos_a_cargo: 2, modalidad_contratacion: 'tiempo_indeterminado',
    dias_trabajados: null, horas_trabajadas: 88, total_remunerativo: 683020.8, total_no_remunerativo: 0, total_descuentos: 153178.95,
    neto: 529841.85, total_contribuciones: 177379.7, fondo_cese: 81962.5,
    lineas: [
      { concepto_id: 1, codigo_arca: '110000', nombre: 'Básico', tipo: 'remunerativo', destino: null, grupo_contribucion: null, cantidad: 88, unidad: 'horas', importe: 569184 },
      { concepto_id: 2, codigo_arca: '170001', nombre: 'Asistencia', tipo: 'remunerativo', destino: null, grupo_contribucion: null, cantidad: null, unidad: '%', importe: 113836.8 },
      { concepto_id: 3, codigo_arca: '810001', nombre: 'Jubilación', tipo: 'descuento', destino: 'f931', grupo_contribucion: null, cantidad: null, unidad: '%', importe: 75132.29 },
      { concepto_id: 9, codigo_arca: null, nombre: 'Cuota sindical', tipo: 'descuento', destino: 'sindicato', grupo_contribucion: null, cantidad: null, unidad: '%', importe: 17075.52 },
      { concepto_id: 20, codigo_arca: null, nombre: 'Contribuciones SS', tipo: 'contribucion', destino: 'f931', grupo_contribucion: 'seguridad_social', cantidad: null, unidad: '%', importe: 122313.41 },
      { concepto_id: 21, codigo_arca: null, nombre: 'Fondo de cese', tipo: 'contribucion', destino: 'fondo_cese', grupo_contribucion: 'otros', cantidad: null, unidad: '%', importe: 81962.5 },
    ],
    ...p,
  }
}

describe('banco', () => {
  it('CSV con coma decimal, BOM aparte, sin ; en el nombre, y avisos', () => {
    const r = exportarBanco(LIQ, [emp(), emp({ legajo_id: 2, cbu: null, nombre: 'Gómez Ana' }), emp({ legajo_id: 3, neto: 0 })])
    expect(r.csv.split('\r\n')[0]).toBe('CUIL;Apellido y nombre;CBU;Importe')
    expect(r.csv.split('\r\n')[1]).toBe('20123456786;Pérez  Juan;2850590940090418135201;529841,85')
    expect(r.filas).toHaveLength(2)
    expect(r.total).toBe(1059683.7)
    expect(r.avisos.map(a => a.codigo)).toEqual(['SIN_CBU', 'NETO_CERO'])
    expect(exportarBanco(LIQ, [emp()], { decimal: 'punto' }).csv).toContain(';529841.85')
  })
})

describe('resumen para el contador', () => {
  it('agrupa por concepto con código ARCA, totales y pasivos por destino', () => {
    const r = resumenContador(LIQ, [emp(), emp({ legajo_id: 2 })])
    expect(r.totales.empleados).toBe(2)
    expect(r.totales.neto).toBe(1059683.7)
    const basico = r.conceptos.find(c => c.codigo_arca === '110000')!
    expect(basico).toMatchObject({ importe: 1138368, cantidad: 176, empleados: 2 })
    expect(r.conceptos[0]!.tipo).toBe('remunerativo')
    expect(r.por_destino).toEqual({ f931: 394891.4, sindicato: 34151.04, fondo_cese: 163925 })
    expect(r.avisos).toEqual([{ codigo: 'SIN_CODIGO_ARCA', detalle: { conceptos: ['Cuota sindical'] } }])
  })
})

describe('LSD (diseño de la planilla oficial de ARCA)', () => {
  const r = generarLsd({ cuit: '33717191949', liquidacion: LIQ, empleados: [emp(), emp({ legajo_id: 9, cuil: null })], detraccion: 3501.84 })
  const lineas = r.contenido.split('\r\n').filter(Boolean)
  it('registro 01: 35 posiciones', () => {
    expect(lineas[0]).toBe('0133717191949SJ202609Q0000530000001')
    expect(lineas[0]).toHaveLength(35)
  })
  it('registro 02: 115 posiciones con CBU, acreditación y tope sin proporcionar', () => {
    const l = lineas[1]!
    expect(l).toHaveLength(115)
    expect(l.slice(0, 13)).toBe('0220123456786')
    expect(l.slice(13, 23)).toBe('112       ')
    expect(l.slice(73, 95)).toBe('2850590940090418135201')
    expect(l.slice(95, 98)).toBe('000')
    expect(l.slice(98, 106)).toBe('20261005')
    expect(l.slice(106, 114)).toBe('        ')
    expect(l.slice(114)).toBe('3')
  })
  it('registro 02 sin CBU: efectivo y CBU en blanco', () => {
    const x = generarLsd({ cuit: '33717191949', liquidacion: LIQ, empleados: [emp({ cbu: null })] })
    const l = x.contenido.split('\r\n')[1]!
    expect(l.slice(73, 95)).toBe(' '.repeat(22))
    expect(l.slice(114)).toBe('1')
  })
  it('registro 03: 51 posiciones, código del empleador C+id, haberes C y descuentos D, sin contribuciones', () => {
    const r03 = lineas.filter(l => l.startsWith('03'))
    expect(r03).toHaveLength(4)
    for (const l of r03) expect(l).toHaveLength(51)
    expect(r03[0]).toBe('0320123456786C1        08800H000000056918400C      ')
    expect(r03[1]!.slice(28, 29)).toBe('%')
    expect(r03[2]!.slice(44, 45)).toBe('D')
    expect(r03[3]!.slice(13, 23)).toBe('C9        ')
  })
  it('registro 04: 370 posiciones; horas informadas → días en 0; base 10 = rem − detracción', () => {
    const r04 = lineas.filter(l => l.startsWith('04'))
    expect(r04).toHaveLength(1)
    const l = r04[0]!
    expect(l).toHaveLength(370)
    expect(l.slice(47, 49)).toBe('00')   // días trabajados
    expect(l.slice(49, 52)).toBe('088')  // horas trabajadas
    expect(l.slice(62, 68)).toBe('126205')
    const importe = (k: number) => Number(l.slice(70 + k * 15, 85 + k * 15)) / 100
    expect(importe(6)).toBe(683020.8)             // remuneración bruta
    expect(importe(7)).toBe(683020.8)             // base imponible 1
    expect(importe(18)).toBe(679518.96)  // base imponible 10
    expect(importe(19)).toBe(3501.84)             // importe a detraer
  })
  it('totales, avisos y nombre del archivo', () => {
    expect(r.registros).toEqual({ '01': 1, '02': 1, '03': 4, '04': 1 })
    expect(r.avisos.map(a => a.codigo)).toEqual(expect.arrayContaining(['CODIGOS_F931_A_CONFIRMAR', 'BASES_SIN_TOPE', 'SIN_CUIL', 'SIN_CODIGO_ARCA']))
    expect(r.archivo).toBe('LSD_202609_LIQ-0005.txt')
  })
  it('SAC fuera de junio/diciembre y SAC proporcional sin días: avisa', () => {
    const x = generarLsd({ cuit: '33717191949', liquidacion: LIQ, empleados: [emp({ lineas: [
      { concepto_id: 30, codigo_arca: '120000', nombre: 'SAC', tipo: 'remunerativo', destino: null, grupo_contribucion: null, cantidad: null, unidad: null, importe: 100 },
      { concepto_id: 31, codigo_arca: '120003', nombre: 'SAC proporcional', tipo: 'remunerativo', destino: null, grupo_contribucion: null, cantidad: null, unidad: null, importe: 50 },
    ] })] })
    const cods = x.avisos.map(a => a.codigo)
    expect(cods).toContain('SAC_FUERA_DE_JUNIO_DICIEMBRE')
    expect(cods).toContain('CANTIDAD_REQUERIDA')
  })
})

describe('LSD: TXT de conceptos', () => {
  it('195 posiciones, subsistemas según el tipo y sin contribuciones', () => {
    const r = generarConceptosLsd([
      { id: 1, codigo_arca: '110000', nombre: 'Básico', tipo: 'remunerativo' },
      { id: 3, codigo_arca: '810000', nombre: 'Jubilación', tipo: 'descuento' },
      { id: 7, codigo_arca: '540000', nombre: 'Suma acuerdo', tipo: 'no_remunerativo' },
      { id: 8, codigo_arca: null, nombre: 'Vacaciones no gozadas', tipo: 'remunerativo' },
      { id: 20, codigo_arca: null, nombre: 'Contribuciones SS', tipo: 'contribucion' },
    ])
    const l = r.contenido.split('\r\n').filter(Boolean)
    expect(l).toHaveLength(3)
    for (const x of l) expect(x).toHaveLength(195)
    expect(l[0]!.slice(0, 16)).toBe('110000C1        ')
    expect(l[0]!.slice(166, 186)).toBe('11111111111 1 1 10 0')
    expect(l[1]!.slice(167, 177)).toBe('0000000000')
    expect(l[2]!.slice(167, 177)).toBe('0000111100')
    expect(r.avisos).toEqual([expect.objectContaining({ codigo: 'SIN_CODIGO_ARCA' })])
  })
})
