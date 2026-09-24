/**
 * Parser de «Mis Comprobantes — Recibidos» de ARCA (20260927b/c): los dos
 * layouts (clásico y por alícuota), CSV con `;` y `,`, BOM, números con coma
 * decimal y punto de miles, encabezados con y sin tildes, el tipo con código
 * o solo con el nombre, y el número guardado igual que la base.
 *
 * Los layouts de acá están armados según lo publicado (SOS-Contador, Del
 * Rincón, Tributum): cuando el dueño pase los archivos reales de jul–sep,
 * sumarlos como fixtures.
 */
import { describe, it, expect } from 'vitest'
import {
  leerFilasRecibidos, parsearRecibidosCsv, csvAMatriz, numeroDeCelda, fechaDeCelda, codigoDeTipo, codigoDeNombreTipo,
  normEncabezado, docTipoDeCelda, docNroDeCelda, monedaDeCelda, estiloDecimalDe, alicuotaIdDeTasa, filaParaRpc,
} from '../../../src/modules/pagos/arca-recibidos.js'
import { normNumeroFactura } from '../../../src/modules/pagos/pagos.util.js'
import { FilaRecibidaSchema } from '../../../src/modules/pagos/pagos.schema.js'

// ── Layout clásico, como sale del Excel (celdas tipadas) ───────────────────

const ENC_CLASICO = ['Fecha', 'Tipo', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización',
  'Tipo Doc. Emisor', 'Nro. Doc. Emisor', 'Denominación Emisor', 'Tipo Cambio', 'Moneda',
  'Imp. Neto Gravado', 'Imp. Neto No Gravado', 'Imp. Op. Exentas', 'Otros Tributos', 'IVA', 'Imp. Total']

const XLS_CLASICO: unknown[][] = [
  ['Mis Comprobantes Recibidos - CUIT 33717191949'],
  ENC_CLASICO,
  ['01/07/2026', '1 - Factura A', 8837, 4557, 4557, 75123456789012, 'CUIT', 30590360763, 'Cencosud S.A', 1, '$',
    116495.87, 0, 0, 11649.59, 24464.13, 152609.59],
  ['15/07/2026', '11 - Factura C', 3, 120, null, '75999999999999', 'CUIT', '20-12345678-6', '  Perez  Juan ', 1, '$',
    0, 0, 0, 0, 0, 25000],
  ['20/07/2026', '3 - Nota de Crédito A', 8837, 10, 10, null, 'CUIT', 30590360763, 'Cencosud S.A', 1, '$',
    -1000, 0, 0, 0, -210, -1210],
]

describe('layout clásico (Excel)', () => {
  const r = leerFilasRecibidos(XLS_CLASICO as never)

  it('encuentra el encabezado debajo del título y arma el formato clásico', () => {
    expect(r.error_archivo).toBeNull()
    expect(r.formato).toBe('clasico')
    expect(r.encabezado_fila).toBe(2)
    expect(r.errores).toEqual([])
    expect(r.filas).toHaveLength(3)
  })

  it('la factura A: códigos, CUIT del Excel como número, importes y sin alícuotas', () => {
    expect(r.filas[0]).toEqual({
      fila_archivo: 3, tipo_texto: '1 - Factura A',
      fecha: '2026-07-01', cbte_tipo: 1, pto_vta: 8837, numero: 4557, numero_hasta: 4557,
      cod_autorizacion: '75123456789012', emisor_doc_tipo: 80, emisor_doc_nro: '30590360763',
      emisor_razon_social: 'Cencosud S.A', moneda: 'PES', tipo_cambio: 1,
      neto_gravado: 116495.87, no_gravado: 0, exento: 0, otros_tributos: 11649.59, iva: 24464.13, total: 152609.59,
      alicuotas: null,
    })
  })

  it('CUIT con guiones, razón social con espacios, número hasta vacío', () => {
    expect(r.filas[1]).toMatchObject({ cbte_tipo: 11, emisor_doc_nro: '20123456786', emisor_razon_social: 'Perez Juan', numero_hasta: null })
  })

  it('la NC en negativo entra en valor absoluto (el signo lo da el tipo)', () => {
    expect(r.filas[2]).toMatchObject({ cbte_tipo: 3, neto_gravado: 1000, iva: 210, total: 1210 })
  })

  it('cada fila pasa el schema del body', () => {
    for (const f of r.filas) expect(FilaRecibidaSchema.safeParse(filaParaRpc(f)).success).toBe(true)
    expect(filaParaRpc(r.filas[0]!)).not.toHaveProperty('fila_archivo')
  })
})

// ── CSV clásico con `;`, BOM y números es-AR ───────────────────────────────

const CSV_PUNTO_Y_COMA = '﻿' + [
  'Fecha;Tipo;Punto de Venta;Numero Desde;Numero Hasta;Cod. Autorizacion;Tipo Doc. Emisor;Nro. Doc. Emisor;Denominacion Emisor;Tipo Cambio;Moneda;Imp. Neto Gravado;Imp. Neto No Gravado;Imp. Op. Exentas;O Otros Tributos;IVA;Imp. Total',
  '02/08/2026;1;00012;00402141;00402141;75111111111111;80;30711111119;"Corralón; El Tanque SRL";1,00;PES;1.234.567,89;0,00;0,00;12.345,67;259.259,26;1.506.172,82',
  '05/08/2026;6;2;55;;;80;30722222228;Ferreteria Norte;1,00;PES;0,00;0,00;0,00;0,00;0,00;15.000,00',
].join('\r\n')

describe('CSV con punto y coma', () => {
  const r = parsearRecibidosCsv(CSV_PUNTO_Y_COMA)

  it('detecta el separador, saca el BOM y respeta las comillas', () => {
    expect(r.error_archivo).toBeNull()
    expect(r.filas).toHaveLength(2)
    expect(r.filas[0]!.emisor_razon_social).toBe('Corralón; El Tanque SRL')
  })

  it('encabezados sin tildes, «O Otros Tributos», tipo solo con el código', () => {
    expect(r.filas[0]).toMatchObject({
      fecha: '2026-08-02', cbte_tipo: 1, pto_vta: 12, numero: 402141, emisor_doc_tipo: 80, emisor_doc_nro: '30711111119',
      neto_gravado: 1234567.89, otros_tributos: 12345.67, iva: 259259.26, total: 1506172.82, tipo_cambio: 1,
    })
    expect(r.filas[1]).toMatchObject({ cbte_tipo: 6, total: 15000, cod_autorizacion: null, numero_hasta: null })
  })
})

// ── CSV con coma y los importes entre comillas ─────────────────────────────

describe('CSV con coma', () => {
  const csv = [
    'sep=,',
    'Mis Comprobantes Recibidos',
    '"Fecha de Emisión","Tipo de Comprobante","Punto de Venta","Número Desde","Número Hasta","Código de Autorización","Tipo Doc. Emisor","Nro. Doc. Emisor","Denominación Emisor","Tipo de Cambio","Moneda","Imp. Neto Gravado","Imp. Neto No Gravado","Imp. Op. Exentas","Otros Tributos","IVA","Imp. Total"',
    '"2026-09-03","1 - Factura A","5","77","77","","CUIT","30733333337","ABC, S.A.","1","$","1000,00","0","0","0","210,00","1210,00"',
    '"03/09/2026","201 - Factura de Crédito Electrónica MiPyMEs (FCE) A","5","78","78","","CUIT","30733333337","ABC, S.A.","1045,5","DOL","100","0","0","0","21","121"',
  ].join('\n')
  const r = parsearRecibidosCsv(csv)

  it('la línea sep= manda, y la coma dentro de comillas no corta', () => {
    expect(r.error_archivo).toBeNull()
    expect(r.encabezado_fila).toBe(2)
    expect(r.filas).toHaveLength(2)
    expect(r.filas[0]).toMatchObject({ fecha: '2026-09-03', emisor_razon_social: 'ABC, S.A.', neto_gravado: 1000, iva: 210, total: 1210 })
  })

  it('FCE y moneda extranjera con tipo de cambio decimal', () => {
    expect(r.filas[1]).toMatchObject({ cbte_tipo: 201, moneda: 'DOL', tipo_cambio: 1045.5, total: 121 })
  })
})

// ── Layout nuevo (sep-2025): PV-número juntos y columnas por alícuota ──────

describe('layout nuevo por alícuota', () => {
  const m = [
    ['Fecha', 'Tipo', 'Número', 'Tipo Doc. Emisor', 'Nro. Doc. Emisor', 'Denominación Emisor', 'Moneda', 'Tipo Cambio',
      'Neto Grav. IVA 0%', 'Neto Grav. IVA 10,5%', 'IVA 10,5%', 'Neto Grav. IVA 21%', 'IVA 21%', 'Imp. Neto Gravado IVA 27%', 'IVA 27%',
      'Total Neto Gravado', 'Total IVA', 'Imp. Neto No Gravado', 'Imp. Op. Exentas', 'Otros Tributos', 'Imp. Total'],
    ['10/09/2026', 'Factura A', '00003-00001234', 'CUIT', '30744444446', 'Mixta SA', '$', '1',
      '0,00', '1.000,00', '105,00', '2.000,00', '420,00', '0,00', '0,00', '3.000,00', '525,00', '0,00', '0,00', '0,00', '3.525,00'],
    ['11/09/2026', 'Nota de Crédito A', '00003-00000010', 'CUIT', '30744444446', 'Mixta SA', '$', '1',
      '0,00', '0,00', '0,00', '100,00', '21,00', '0,00', '0,00', '100,00', '21,00', '0,00', '0,00', '0,00', '121,00'],
    ['', 'Total', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '3.646,00'],
  ]
  const r = leerFilasRecibidos(m)

  it('detecta el formato y parte punto de venta y número', () => {
    expect(r.error_archivo).toBeNull()
    expect(r.formato).toBe('por_alicuota')
    expect(r.filas[0]).toMatchObject({ cbte_tipo: 1, pto_vta: 3, numero: 1234 })
  })

  it('arma las alícuotas (solo las que tienen importe) y toma los totales de sus columnas', () => {
    expect(r.filas[0]!.alicuotas).toEqual([
      { alicuota_id: 4, base_imp: 1000, importe: 105 },
      { alicuota_id: 5, base_imp: 2000, importe: 420 },
    ])
    expect(r.filas[0]).toMatchObject({ neto_gravado: 3000, iva: 525, total: 3525 })
  })

  it('tipo solo con el nombre: la NC A es 3; el pie «Total» (sin fecha ni número) se saltea', () => {
    expect(r.filas[1]).toMatchObject({ cbte_tipo: 3, alicuotas: [{ alicuota_id: 5, base_imp: 100, importe: 21 }] })
    expect(r.filas).toHaveLength(2)
    expect(r.errores).toEqual([])
  })

  it('sin columnas de total, neto e IVA salen de las alícuotas', () => {
    const r2 = leerFilasRecibidos([
      ['Fecha', 'Tipo', 'Punto de Venta', 'Número Desde', 'Nro. Doc. Emisor', 'Neto Gravado IVA 21%', 'IVA 21%', 'Neto Grav. 2,5%', 'IVA 2,5%', 'Imp. Total'],
      ['01/09/2026', 1, 1, 9, 30744444446, 1000, 210, 200, 5, 1415],
    ])
    expect(r2.filas[0]).toMatchObject({ neto_gravado: 1200, iva: 215, alicuotas: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }, { alicuota_id: 9, base_imp: 200, importe: 5 }] })
  })
})

// ── Archivo equivocado y filas malas ───────────────────────────────────────

describe('errores', () => {
  it('el Excel de EMITIDOS se rechaza con un mensaje claro', () => {
    const r = leerFilasRecibidos([['Fecha', 'Tipo', 'Punto de Venta', 'Número Desde', 'Tipo Doc. Comprador', 'Nro. Doc. Comprador', 'Denominación Comprador', 'Imp. Total']])
    expect(r.error_archivo).toMatch(/EMITIDOS/)
    expect(r.filas).toEqual([])
  })

  it('sin encabezado reconocible', () => {
    expect(leerFilasRecibidos([['a', 'b'], [1, 2]]).error_archivo).toMatch(/encabezados/)
    expect(parsearRecibidosCsv('').error_archivo).toMatch(/encabezados/)
  })

  it('fecha ilegible, tipo ilegible, número fuera de rango y total vacío: error por fila, las demás siguen', () => {
    const r = leerFilasRecibidos([
      ENC_CLASICO,
      ['31/02/2026', 1, 1, 1, 1, '', 80, '30744444446', 'X', 1, '$', 0, 0, 0, 0, 0, 100],
      ['01/07/2026', 'Algo raro', 1, 2, 2, '', 80, '30744444446', 'X', 1, '$', 0, 0, 0, 0, 0, 100],
      ['01/07/2026', 1, 1, 0, 0, '', 80, '30744444446', 'X', 1, '$', 0, 0, 0, 0, 0, 100],
      ['01/07/2026', 1, 1, 4, 4, '', 80, '30744444446', 'X', 1, '$', 0, 0, 0, 0, 0, ''],
      ['01/07/2026', 1, 1, 5, 9, '', 80, '30744444446', 'X', 1, '$', 0, 0, 0, 0, 0, 100],
      [],
    ])
    expect(r.errores.map((e) => e.fila_archivo)).toEqual([2, 3, 4, 5])
    expect(r.errores[0]!.motivo).toMatch(/Fecha ilegible/)
    expect(r.errores[1]!.motivo).toMatch(/Tipo de comprobante ilegible/)
    // El rango pasa: lo marca la base (RANGO_DE_NUMEROS) para que el usuario vea el motivo.
    expect(r.filas).toHaveLength(1)
    expect(r.filas[0]).toMatchObject({ numero: 5, numero_hasta: 9 })
  })
})

// ── Celdas ──────────────────────────────────────────────────────────────────

describe('celdas', () => {
  it('números en todas las formas', () => {
    expect(numeroDeCelda('1.234.567,89')).toBe(1234567.89)
    expect(numeroDeCelda('1234,5')).toBe(1234.5)
    expect(numeroDeCelda('1,234.56')).toBe(1234.56)
    expect(numeroDeCelda('1234.56')).toBe(1234.56)
    expect(numeroDeCelda('$ -1.234,00')).toBe(-1234)
    expect(numeroDeCelda('(1.234,56)')).toBe(-1234.56)
    expect(numeroDeCelda('1.234')).toBe(1234)
    expect(numeroDeCelda('1.234', 'punto')).toBe(1.234)
    expect(numeroDeCelda(12.5)).toBe(12.5)
    expect(numeroDeCelda('')).toBeNull()
    expect(numeroDeCelda('-')).toBeNull()
    expect(numeroDeCelda('abc')).toBeNull()
    expect(estiloDecimalDe(['1.000,00', '5,5'])).toBe('coma')
    expect(estiloDecimalDe(['1000.00', 7])).toBe('punto')
  })

  it('fechas: dd/mm/aaaa, ISO, serial de Excel, Date; las inexistentes no', () => {
    expect(fechaDeCelda('01/07/2026')).toBe('2026-07-01')
    expect(fechaDeCelda('1/7/26')).toBe('2026-07-01')
    expect(fechaDeCelda('2026-07-01T00:00:00')).toBe('2026-07-01')
    expect(fechaDeCelda(46204)).toBe('2026-07-01')
    expect(fechaDeCelda('01/07/2026 00:00:00')).toBe('2026-07-01')
    expect(fechaDeCelda('31/02/2026')).toBeNull()
    expect(fechaDeCelda(12)).toBeNull()
  })

  it('tipo: con código, con ceros, solo el nombre', () => {
    expect(codigoDeTipo('1 - Factura A')).toBe(1)
    expect(codigoDeTipo('011 - Factura C')).toBe(11)
    expect(codigoDeTipo(201)).toBe(201)
    expect(codigoDeTipo('6')).toBe(6)
    expect(codigoDeTipo('')).toBeNull()
    const nombres: Record<string, number> = {
      'Factura A': 1, 'Nota de Débito A': 2, 'Nota de Crédito A': 3, 'Recibo A': 4, 'Nota de Venta al contado A': 5,
      'Factura B': 6, 'Nota de Crédito B': 8, 'Recibo B': 9, 'Factura C': 11, 'Nota de Crédito C': 13, 'Recibo C': 15,
      'Factura M': 51, 'Nota de Crédito M': 53, 'Tique Factura A': 81, 'Tique Factura B': 82, 'Tique': 83,
      'Factura de Crédito Electrónica MiPyMEs (FCE) A': 201, 'Nota de Débito Electrónica MiPyMEs (FCE) A': 202,
      'Nota de Crédito Electrónica MiPyMEs (FCE) A': 203, 'Factura de Crédito Electrónica MiPyMEs (FCE) B': 206,
      'Nota de Crédito Electrónica MiPyMEs (FCE) C': 213,
      'Comprobante de Compra de Bienes Usados a Consumidor Final': 49, 'Cuenta de Venta y Líquido producto A': 60,
    }
    for (const [n, c] of Object.entries(nombres)) expect([n, codigoDeNombreTipo(n)]).toEqual([n, c])
    expect(codigoDeNombreTipo('Cualquier cosa')).toBeNull()
  })

  it('encabezados, documento y moneda', () => {
    expect(normEncabezado('Cód. Autorización')).toBe('cod autorizacion')
    expect(normEncabezado('﻿Fecha')).toBe('fecha')
    expect(normEncabezado('Imp. Total ($)')).toBe('imp total')
    expect(normEncabezado('Neto Grav. IVA 10.5%')).toBe('neto grav iva 10.5%')
    expect(docTipoDeCelda('CUIT')).toBe(80)
    expect(docTipoDeCelda('80 - CUIT')).toBe(80)
    expect(docTipoDeCelda('Pasaporte')).toBe('PASAPORTE')
    expect(docNroDeCelda(30590360763)).toBe('30590360763')
    expect(monedaDeCelda('$')).toBe('PES')
    expect(monedaDeCelda('Dólar')).toBe('DOL')
    expect(monedaDeCelda('EUR')).toBe('EUR')
    expect(alicuotaIdDeTasa(10.5)).toBe(4)
    expect(alicuotaIdDeTasa(2.5)).toBe(9)
    expect(alicuotaIdDeTasa(0)).toBe(3)
    expect(alicuotaIdDeTasa(19)).toBeNull()
  })

  it('csvAMatriz: comillas dobles escapadas, CRLF y tab', () => {
    expect(csvAMatriz('a\tb\r\n"x""y"\tz')).toEqual([['a', 'b'], ['x"y', 'z']])
  })
})

// ── El número guardado = el de la base ─────────────────────────────────────

describe('numero y numero_norm', () => {
  // Espejo de la RPC: numero = lpad(pv,5)-lpad(num,8);
  // numero_norm = case when pv = 0 then num::text else pv::text || '-' || num::text end.
  const numeroRpc = (pv: number, num: number) => `${String(pv).padStart(5, '0')}-${String(num).padStart(8, '0')}`
  const normRpc = (pv: number, num: number) => (pv === 0 ? String(num) : `${pv}-${num}`)

  it('normNumeroFactura del BE da lo mismo que la RPC', () => {
    for (const [pv, num] of [[8837, 4557], [12, 402141], [1, 1], [99999, 99999999], [0, 77], [0, 1]] as const) {
      expect(normNumeroFactura(numeroRpc(pv, num))).toBe(normRpc(pv, num))
    }
  })
})
