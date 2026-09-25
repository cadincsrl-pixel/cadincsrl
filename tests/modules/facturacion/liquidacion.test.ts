/**
 * Lector de la liquidación de Casilda Combustibles (20260930k) con el texto
 * REAL de sus PDFs (extraído con pdfjs y la misma función de renglones que
 * usa el navegador: frontend `utils/textoPdf.ts` → `lineasDeItems`).
 * `fixtures/liquidaciones-casilda/esperado.json` son las 18 liquidaciones de
 * jul–sep 2026 leídas a mano con pdftotext (conciliación del 25/09).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  parsearLiquidacionCasilda, controlesLiquidacion, conceptoDeDeduccion, parseImporte, fechaIsoDe, nombreCorto, destinoDe,
  type ConceptoGastoMin,
} from '../../../src/modules/facturacion/liquidacion.js'
import { liquidacionDesdeIA, type LecturaLiquidacionIA } from '../../../src/modules/facturacion/liquidacion-ia.js'


const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'liquidaciones-casilda')
const texto = (n: number) => readFileSync(path.join(DIR, `liq-${n}.txt`), 'utf8')

interface Esperado {
  liq: number; fecha: string; cvlp: number; bruto: number; comision: number; subtotal: number; ley: number
  desc: Array<[string, string, number]>; total: number; cheques: Array<[string, string, string, number]>
}
const ESPERADO = JSON.parse(readFileSync(path.join(DIR, 'esperado.json'), 'utf8')) as Esperado[]

/** La semilla de 20260930k. */
const CONCEPTOS: ConceptoGastoMin[] = [
  { id: 1, nombre: 'Recupero Ley 25413 (impuesto al cheque)', alias: ['recupero ley 25413', 'ley 25413', 'impuesto al cheque'], activo: true },
  { id: 2, nombre: 'Seguro de carga', alias: ['pago seguro de carga', 'seguro de carga'], activo: true },
  { id: 3, nombre: 'Pago de playa', alias: ['pago de playa'], activo: true },
  { id: 4, nombre: 'Faltante de mercadería', alias: ['faltante', 'falt kg'], activo: true },
]

describe('parsearLiquidacionCasilda — LIQ 3179 (la del 25/09)', () => {
  const l = parsearLiquidacionCasilda(texto(3179))!

  it('cabecera: número, fecha, CUIT y nombre de Casilda', () => {
    expect(l).not.toBeNull()
    expect(l).toMatchObject({ numero: '3179', fecha: '2026-09-25', emisor_cuit: '30715675265', emisor_nombre: 'CASILDA COMBUSTIBLES S.R.L.' })
  })

  it('la CVLP 0010-00000255 con su comisión; la hoja 2 (copia) no duplica nada', () => {
    expect(l.comprobantes).toEqual([
      { pto_vta: 10, numero: 255, fecha: '2026-09-11', bruto: 1619133.7, comision: -122342.4, subtotal: 1496791.3 },
    ])
    expect(l.subtotal).toBe(1496791.3)
    expect(l.cheques).toHaveLength(6)
    expect(l.deducciones).toHaveLength(2)
  })

  it('deducciones: el recupero (con etiqueta) y el seguro (renglón de Descuentos)', () => {
    expect(l.deducciones).toEqual([
      { texto: 'Recupero Ley 25413', codigo: null, comprobante: null, fecha: null, importe: 8500 },
      { texto: 'PAGO SEGURO DE CARGA - 1 VIAJE', codigo: 'PAGO SEGUR', comprobante: '51799', fecha: '2026-09-05', importe: 4000 },
    ])
  })

  it('cheques CH/PROP del ICBC, con vencimiento', () => {
    expect(l.cheques[0]).toEqual({ tipo: 'CH/PROP', numero: '14575857', banco: 'ICBC', fecha_cobro: '2026-11-01', importe: 240000, propio: true })
    expect(l.cheques[5]).toMatchObject({ numero: '14575862', fecha_cobro: '2026-11-08', importe: 284291.3 })
    expect(l.neto).toBe(1484291.3)
    expect(l.avisos).toEqual([])
  })

  it('controles: todo cierra', () => {
    expect(controlesLiquidacion(l)).toEqual({
      suma_comprobantes: 1496791.3, suma_deducciones: 12500, suma_cheques: 1484291.3,
      cierra_subtotal: true, cierra_neto: true, cierra_cheques: true, ok: true,
    })
  })
})

describe('parsearLiquidacionCasilda — otras deducciones reales', () => {
  it('LIQ 3145: pago de playa (GASTOS VAR) + seguro', () => {
    const l = parsearLiquidacionCasilda(texto(3145))!
    expect(l.deducciones.map((d) => [d.codigo, d.texto, d.importe])).toEqual([
      [null, 'Recupero Ley 25413', 8400],
      ['GASTOS VAR', 'PAGO DE PLAYA - GONZALEZ JOSE', 23100],
      ['PAGO SEGUR', 'PAGO SEGURO DE CARGA - 1 VIAJE', 4000],
    ])
    expect(l.deducciones.map((d) => conceptoDeDeduccion(d, CONCEPTOS).concepto_id)).toEqual([1, 3, 2])
    expect(controlesLiquidacion(l).ok).toBe(true)
  })

  it('LIQ 3177: faltante de 30 kg de harina de soja', () => {
    const l = parsearLiquidacionCasilda(texto(3177))!
    const falt = l.deducciones[1]!
    expect(falt).toMatchObject({ codigo: 'FALTANTE D', texto: 'FALT.KG(30 KG HAR.SOJA)CTG:51805 GONZALE', importe: 19813.49 })
    expect(conceptoDeDeduccion(falt, CONCEPTOS)).toEqual({ concepto_id: 4, por: 'faltante' })
    expect(controlesLiquidacion(l).ok).toBe(true)
  })

  it('LIQ 3103 trae impresa la fecha 07/09 (es de principios de agosto): se lee tal cual, la persona la corrige', () => {
    expect(parsearLiquidacionCasilda(texto(3103))!.fecha).toBe('2026-09-07')
  })
})

describe('las 18 liquidaciones jul–sep 2026 contra la lectura a mano', () => {
  it.each(ESPERADO.map((e) => [e.liq, e] as const))('LIQ %i', (_n, e) => {
    const l = parsearLiquidacionCasilda(texto(e.liq))
    expect(l).not.toBeNull()
    if (!l) return
    expect(l.numero).toBe(String(e.liq))
    expect(l.fecha).toBe(fechaIsoDe(e.fecha))
    expect(l.comprobantes).toHaveLength(1)
    expect(l.comprobantes[0]).toMatchObject({ pto_vta: 10, numero: e.cvlp, bruto: e.bruto, comision: e.comision, subtotal: e.subtotal })
    expect(l.subtotal).toBe(e.subtotal)
    expect(l.deducciones[0]).toMatchObject({ texto: 'Recupero Ley 25413', importe: -e.ley })
    expect(l.deducciones.slice(1).map((d) => [d.texto, -d.importe])).toEqual(e.desc.map(([, det, imp]) => [det, imp]))
    expect(l.neto).toBe(e.total)
    expect(l.cheques.map((c) => [c.numero, c.banco, c.fecha_cobro, c.importe])).toEqual(e.cheques.map(([n, b, f, i]) => [n, b, fechaIsoDe(f), i]))
    expect(controlesLiquidacion(l).ok).toBe(true)
    // Toda deducción real tiene concepto con la semilla.
    expect(l.deducciones.every((d) => conceptoDeDeduccion(d, CONCEPTOS).concepto_id != null)).toBe(true)
  })
})

describe('texto que no alcanza → null (sigue la IA)', () => {
  it.each([
    ['vacío', ''],
    ['un escaneo (sin texto)', '\n\n'],
    ['otro documento', 'FACTURA A N° 0001-00000123\nTotal: 1000.00'],
    ['liquidación sin comprobantes', 'Liquidación Nro.: 55\nTotal Liquidación: 100.00\nDetalle de Pagos\nCH/PROP 123456 ICBC 01/11/2026 100.00 - PAGO'],
  ])('%s', (_d, t) => {
    expect(parsearLiquidacionCasilda(t)).toBeNull()
  })

  it('controles marcan lo que no cierra', () => {
    const l = parsearLiquidacionCasilda(texto(3179).replace('284291.30 - PAGO', '284291.00 - PAGO'))!
    expect(controlesLiquidacion(l)).toMatchObject({ cierra_subtotal: true, cierra_neto: true, cierra_cheques: false, ok: false })
    // La copia (hoja 2) quedó distinta: no se suma, se avisa.
    expect(l.comprobantes).toHaveLength(1)
    expect(l.avisos[0]).toMatch(/copia/)
  })

  it('una hoja sin cabecera propia (liquidación larga) se lee junto con la primera', () => {
    const t = texto(3179)
    const corte = t.indexOf('Detalle de Pagos')
    const hoja1 = t.slice(0, corte).split('Hoja: 2')[0]!
    const pagos = t.slice(corte).split('Hoja: 2')[0]!
    const l = parsearLiquidacionCasilda(`${hoja1}Hoja: 2\n${pagos}`)!
    expect(l.cheques).toHaveLength(6)
    expect(controlesLiquidacion(l).ok).toBe(true)
  })
})

describe('auxiliares', () => {
  it.each([
    ['1619133.70', 1619133.7], ['-122342.40', -122342.4], ['1.619.133,70', 1619133.7], ['$ 1,619,133.70', 1619133.7],
    ['8500', 8500], ['abc', null], [null, null],
  ])('parseImporte(%s)', (t, n) => {
    expect(parseImporte(t)).toBe(n)
  })
  it('fechaIsoDe rechaza fechas imposibles', () => {
    expect(fechaIsoDe('31/02/2026')).toBeNull()
    expect(fechaIsoDe('01/11/2026')).toBe('2026-11-01')
  })
  it('conceptoDeDeduccion: sin match, inactivo o empate → null', () => {
    expect(conceptoDeDeduccion({ texto: 'COMISION BANCARIA', codigo: null }, CONCEPTOS).concepto_id).toBeNull()
    expect(conceptoDeDeduccion({ texto: 'PAGO DE PLAYA', codigo: null }, CONCEPTOS.map((c) => ({ ...c, activo: c.id !== 3 }))).concepto_id).toBeNull()
    expect(conceptoDeDeduccion({ texto: 'seguro de carga', codigo: null },
      [...CONCEPTOS, { id: 9, nombre: 'Otro seguro', alias: ['seguro de carga'], activo: true }]).concepto_id).toBeNull()
  })
  it('nombreCorto', () => {
    expect(nombreCorto('CASILDA COMBUSTIBLES S.R.L.')).toBe('Casilda')
  })
})

describe('liquidacionDesdeIA', () => {
  const base: LecturaLiquidacionIA = {
    legible: true, numero: 'N° 3179', fecha: '2026-09-25', emisor_nombre: 'Casilda', emisor_cuit: '30-71567526-5',
    comprobantes: [{ pto_vta: 10, numero: 255, fecha: '2026-09-11', bruto: 1619133.7, comision: 122342.4, subtotal: null }],
    subtotal: 1496791.3,
    deducciones: [{ texto: 'Recupero Ley 25413', codigo: null, fecha: null, importe: -8500 }, { texto: 'x', codigo: null, fecha: null, importe: 0 }],
    neto: 1488291.3,
    cheques: [{ tipo: 'ch/prop', numero: '14575857', banco: 'ICBC', fecha_cobro: '01/11/2026', importe: 1488291.3, propio: null, librador: null, librador_cuit: null }],
    notas: null,
  }
  it('normaliza signos, CUIT, número y fechas', () => {
    const l = liquidacionDesdeIA(base)!
    expect(l).toMatchObject({ numero: '3179', emisor_cuit: '30715675265' })
    expect(l.comprobantes[0]).toMatchObject({ comision: -122342.4, subtotal: 1496791.3 })
    expect(l.deducciones).toEqual([{ texto: 'Recupero Ley 25413', codigo: null, comprobante: null, fecha: null, importe: 8500 }])
    expect(l.cheques[0]).toMatchObject({ tipo: 'CH/PROP', propio: true, fecha_cobro: null })
    expect(controlesLiquidacion(l).ok).toBe(true)
  })
  it('ilegible o sin comprobantes → null', () => {
    expect(liquidacionDesdeIA({ ...base, legible: false })).toBeNull()
    expect(liquidacionDesdeIA({ ...base, comprobantes: [] })).toBeNull()
  })
})

describe('destinoDe (qué comprobante cancela cada renglón)', () => {
  const ext = { id: 187, cbte_tipo: 60, tipo: 'FA', pto_vta: 10, numero: 255, fecha: '2026-09-11', total: '1496791.30', saldo: '1496791.30', comprobante: 'CVLP A 00010-00000255' }
  const c = { pto_vta: 10, numero: 255, subtotal: 1496791.3 }
  it('CVLP pendiente → se imputa el subtotal', () => {
    expect(destinoDe(c, [ext], [])).toMatchObject({ destino: { tipo: 'externo', id: 187, saldo: 1496791.3 }, imputar: 1496791.3, avisos: [] })
  })
  it('ya marcada cobrada (saldo 0) → YA_COBRADO e imputar 0', () => {
    expect(destinoDe(c, [{ ...ext, saldo: '0' }], [])).toMatchObject({ imputar: 0, avisos: ['YA_COBRADO'] })
  })
  it('saldo parcial / importe distinto', () => {
    expect(destinoDe(c, [{ ...ext, saldo: '1000' }], []).avisos).toEqual(['SALDO_MENOR'])
    expect(destinoDe(c, [{ ...ext, total: '1500000' }], []).avisos).toEqual(['IMPORTE_DISTINTO'])
  })
  it('no está → NO_ENCONTRADO; si no hay externo busca la factura del ERP', () => {
    expect(destinoDe(c, [], [])).toEqual({ destino: null, imputar: 0, avisos: ['NO_ENCONTRADO'] })
    const f = { id: 5, cbte_tipo: 60, pto_vta: 10, numero: 255, fecha_cbte: '2026-09-11', imp_total: 1496791.3, cobro_saldo: 1496791.3, numero_fmt: '00010-00000255', tipo_nombre: 'CVLP A' }
    expect(destinoDe(c, [], [f]).destino).toMatchObject({ tipo: 'factura', id: 5 })
  })
})
