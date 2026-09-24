// Libro IVA Digital de Ventas (RG 4597): el armado de las líneas de ancho fijo.
// Posiciones según «ANEXO I – DISEÑOS DE REGISTROS» (VENTAS_CBTE 266, VENTAS_ALICUOTAS 62).
import { describe, it, expect } from 'vitest'
import {
  aCentavos, campoNum, campoImporte, campoTipoCambio, campoFecha, campoTexto, codigoOperacion, alicuotasParaArchivo,
  deducirAlicuota, lineaCbte, lineasAlicuotas, unirLineas, desdeErp, desdeExterno, validarComprobante, armarLibro,
  rangoPeriodo, nombreArchivo, aAnsi, cuitValida, monedaLid, LidFormatoError, LARGO_CBTE, LARGO_ALICUOTA,
  type ComprobanteLid, type FilaFacturaErp, type FilaExterno,
} from '../../../src/modules/facturacion/lid-ventas.js'

/** Corta un campo por posiciones 1-based inclusive, como el diseño de registro. */
const pos = (l: string, desde: number, hasta: number) => l.slice(desde - 1, hasta)

const base = (over: Partial<ComprobanteLid> = {}): ComprobanteLid => ({
  origen: 'erp', ref_id: 1, fecha: '2026-09-23', cbte_tipo: 1, pto_vta: 4, numero: 1,
  doc_tipo: 80, doc_nro: '33702413309', nombre: 'BRADEL DEL PUEBLO S R L',
  total: 196625, neto: 162500, iva: 34125, no_gravado: 0, exento: 0,
  perc_no_categorizados: 0, perc_nacionales: 0, perc_iibb: 0, perc_municipales: 0, impuestos_internos: 0, otros_tributos: 0,
  moneda: 'PES', tipo_cambio: 1, alicuotas: [{ codigo: 5, neto: 162500, iva: 34125 }], vto_pago: null,
  ...over,
})

const erpFila = (over: Partial<FilaFacturaErp> = {}): FilaFacturaErp => ({
  id: 17, cbte_tipo: 1, pto_vta: 4, numero: 1, fecha_cbte: '2026-09-23', fch_vto_pago: '2026-09-23',
  rec_doc_tipo: 80, rec_doc_nro: '33702413309', rec_razon_social: 'BRADEL DEL PUEBLO S R L',
  moneda: 'PES', cotizacion: '1.000000',
  imp_neto: '162500.00', imp_iva: '34125.00', imp_trib: '0.00', imp_op_ex: '0.00', imp_tot_conc: '0.00', imp_total: '196625.00',
  alicuotas: [{ alicuota_id: 5, base_imp: 162500, importe: 34125 }],
  ...over,
})

const extFila = (over: Partial<FilaExterno> = {}): FilaExterno => ({
  id: 900, cbte_tipo: 1, pto_vta: 2, numero: 500, fecha: '2026-08-10',
  rec_doc_tipo: 80, rec_doc_nro: '30714069620', rec_razon_social: 'ANIMAR S.R.L.',
  neto: '1000.00', no_gravado: '0', exento: '0', iva: '210.00', total: '1210.00', moneda: 'PES', tipo_cambio: '1',
  ...over,
})

describe('campos', () => {
  it('centavos exactos desde string de numeric y desde number, half-up', () => {
    expect(aCentavos('1234.56')).toBe(123456)
    expect(aCentavos('0.005')).toBe(1)
    expect(aCentavos('1.004')).toBe(100)
    expect(aCentavos(1.005)).toBe(101)
    expect(aCentavos(0.1 + 0.2)).toBe(30)
    expect(aCentavos('-15.5')).toBe(-1550)
    expect(aCentavos(null)).toBe(0)
    expect(aCentavos('12')).toBe(1200)
    expect(() => aCentavos('1,5')).toThrow(LidFormatoError)
  })

  it('importe: 15 posiciones, 13 enteros + 2 decimales, sin punto', () => {
    expect(campoImporte(196625)).toBe('000000019662500')
    expect(campoImporte('0.01')).toBe('000000000000001')
    expect(campoImporte(0)).toBe('000000000000000')
    expect(campoImporte(9999999999999.99)).toBe('999999999999999')
    expect(campoImporte(-12.5)).toBe('-00000000001250')
    expect(campoImporte(-12.5)).toHaveLength(15)
    expect(() => campoImporte(10000000000000)).toThrow(LidFormatoError)
  })

  it('tipo de cambio: 4 enteros + 6 decimales', () => {
    expect(campoTipoCambio(1)).toBe('0001000000')
    expect(campoTipoCambio('1.000000')).toBe('0001000000')
    expect(campoTipoCambio(1375.5)).toBe('1375500000')
    expect(campoTipoCambio(null)).toBe('0001000000')
    expect(campoTipoCambio(0)).toBe('0001000000')
    expect(() => campoTipoCambio(10000)).toThrow(LidFormatoError)
  })

  it('numéricos con ceros a la izquierda, fecha AAAAMMDD', () => {
    expect(campoNum(4, 5)).toBe('00004')
    expect(campoNum('33-70241330-9', 20)).toBe('00000000033702413309')
    expect(() => campoNum(123456, 5)).toThrow(LidFormatoError)
    expect(campoFecha('2026-09-23')).toBe('20260923')
    expect(campoFecha(null)).toBe('00000000')
    expect(() => campoFecha('23/09/2026')).toThrow(LidFormatoError)
  })

  it('texto a la izquierda con blancos, cortado, ANSI', () => {
    expect(campoTexto('ABC', 5)).toBe('ABC  ')
    expect(campoTexto('UNA RAZÓN SOCIAL MUY LARGA QUE NO ENTRA EN TREINTA', 30)).toHaveLength(30)
    expect(campoTexto('PEÑA “LOS ÁLAMOS” — S.A.', 30).trimEnd()).toBe('PEÑA "LOS ÁLAMOS" - S.A.')
    expect(campoTexto('emoji 🚚 fin', 20).trimEnd()).toBe('emoji ?? fin')
    expect(campoTexto(null, 3)).toBe('   ')
    expect(campoTexto('a\r\nb', 5)).toBe('a b  ')
  })

  it('aAnsi: Latin-1 un byte por carácter', () => {
    const b = aAnsi('Ñá\r\n')
    expect([...b]).toEqual([0xd1, 0xe1, 0x0d, 0x0a])
  })

  it('moneda y CUIT', () => {
    expect(monedaLid('PES')).toBe('PES')
    expect(monedaLid('$')).toBe('PES')
    expect(monedaLid(null)).toBe('PES')
    expect(monedaLid('USD')).toBe('DOL')
    expect(monedaLid('DOL')).toBe('DOL')
    expect(cuitValida('33702413309')).toBe(true)
    expect(cuitValida('30714069620')).toBe(true)
    expect(cuitValida('30714069621')).toBe(false)
    expect(cuitValida('123')).toBe(false)
  })
})

describe('línea CBTE (266)', () => {
  it('Factura A del ERP: cada campo en su posición', () => {
    const l = lineaCbte(desdeErp(erpFila()))
    expect(l).toHaveLength(LARGO_CBTE)
    expect(pos(l, 1, 8)).toBe('20260923')
    expect(pos(l, 9, 11)).toBe('001')
    expect(pos(l, 12, 16)).toBe('00004')
    expect(pos(l, 17, 36)).toBe('00000000000000000001')
    expect(pos(l, 37, 56)).toBe('00000000000000000001')
    expect(pos(l, 57, 58)).toBe('80')
    expect(pos(l, 59, 78)).toBe('00000000033702413309')
    expect(pos(l, 79, 108)).toBe('BRADEL DEL PUEBLO S R L       ')
    expect(pos(l, 109, 123)).toBe('000000019662500')
    for (const [d, h] of [[124, 138], [139, 153], [154, 168], [169, 183], [184, 198], [199, 213], [214, 228], [244, 258]]) {
      expect(pos(l, d!, h!)).toBe('000000000000000')
    }
    expect(pos(l, 229, 231)).toBe('PES')
    expect(pos(l, 232, 241)).toBe('0001000000')
    expect(pos(l, 242, 242)).toBe('1')
    expect(pos(l, 243, 243)).toBe('0')
    expect(pos(l, 259, 266)).toBe('20260923')
  })

  it('NC A: importes POSITIVOS, el tipo 003 dice que resta', () => {
    const l = lineaCbte(base({ cbte_tipo: 3, total: -1210, neto: -1000, iva: -210, alicuotas: [{ codigo: 5, neto: -1000, iva: -210 }] }))
    expect(pos(l, 9, 11)).toBe('003')
    expect(pos(l, 109, 123)).toBe('000000000121000')
    expect(l).not.toContain('-')
    const [a] = lineasAlicuotas(base({ cbte_tipo: 3, alicuotas: [{ codigo: 5, neto: -1000, iva: -210 }] }))
    expect(pos(a!, 29, 43)).toBe('000000000100000')
    expect(pos(a!, 48, 62)).toBe('000000000021000')
  })

  it('FCE 201 y NC FCE 203', () => {
    const l = lineaCbte(desdeErp(erpFila({ cbte_tipo: 201, imp_neto: '17728592.82', imp_iva: '3723004.49', imp_total: '21451597.31',
      alicuotas: [{ alicuota_id: 5, base_imp: 17728592.82, importe: 3723004.49 }] })))
    expect(pos(l, 9, 11)).toBe('201')
    expect(pos(l, 109, 123)).toBe('000002145159731')
    expect(pos(lineaCbte(base({ cbte_tipo: 203 })), 9, 11)).toBe('203')
  })

  it('Factura B: se informa CON alícuota (IVA contenido), cantidad 1', () => {
    const c = desdeExterno(extFila({ cbte_tipo: 6, neto: '12000000.00', iva: '2520000.00', total: '14520000.00' }))
    const l = lineaCbte(c)
    expect(pos(l, 9, 11)).toBe('006')
    expect(pos(l, 242, 242)).toBe('1')
    const als = lineasAlicuotas(c)
    expect(als).toHaveLength(1)
    expect(pos(als[0]!, 44, 47)).toBe('0005')
    expect(pos(als[0]!, 48, 62)).toBe('000000252000000')
  })

  it('consumidor final (99): documento en ceros y leyenda', () => {
    const l = lineaCbte(base({ cbte_tipo: 6, doc_tipo: 99, doc_nro: '0', nombre: '' }))
    expect(pos(l, 57, 58)).toBe('99')
    expect(pos(l, 59, 78)).toBe('0'.repeat(20))
    expect(pos(l, 79, 108).trimEnd()).toBe('CONSUMIDOR FINAL')
  })

  it('exento puro: código E, una alícuota 0003 con neto 0', () => {
    const c = base({ total: 500, neto: 0, iva: 0, exento: 500, alicuotas: [] })
    const l = lineaCbte(c)
    expect(pos(l, 154, 168)).toBe('000000000050000')
    expect(pos(l, 242, 242)).toBe('1')
    expect(pos(l, 243, 243)).toBe('E')
    const [a] = lineasAlicuotas(c)
    expect(pos(a!, 29, 43)).toBe('0'.repeat(15))
    expect(pos(a!, 44, 47)).toBe('0003')
    expect(pos(a!, 48, 62)).toBe('0'.repeat(15))
  })

  it('no gravado puro: código N', () => {
    const c = base({ total: 300, neto: 0, iva: 0, no_gravado: 300, alicuotas: [] })
    expect(pos(lineaCbte(c), 243, 243)).toBe('N')
    expect(pos(lineaCbte(c), 124, 138)).toBe('000000000030000')
  })

  it('gravado + exento: código 0, la parte exenta en la cabecera, 1 alícuota', () => {
    const c = base({ total: 1710, exento: 500, alicuotas: [{ codigo: 5, neto: 1000, iva: 210 }], neto: 1000, iva: 210 })
    const l = lineaCbte(c)
    expect(pos(l, 242, 243)).toBe('10')
    expect(lineasAlicuotas(c)).toHaveLength(1)
  })

  it('dos alícuotas: cantidad 2 y dos registros en el mismo orden', () => {
    const c = base({ total: 1210 + 552.5, neto: 1500, iva: 262.5, alicuotas: [{ codigo: 5, neto: 1000, iva: 210 }, { codigo: 4, neto: 500, iva: 52.5 }] })
    expect(pos(lineaCbte(c), 242, 242)).toBe('2')
    const als = lineasAlicuotas(c)
    expect(als.map(a => pos(a, 44, 47))).toEqual(['0005', '0004'])
  })

  it('otros tributos del ERP en el campo 21', () => {
    const l = lineaCbte(desdeErp(erpFila({ imp_trib: '100.00', imp_total: '196725.00' })))
    expect(pos(l, 244, 258)).toBe('000000000010000')
  })

  it('CVLP 060: comprador = el comisionista', () => {
    const c = desdeExterno(extFila({ cbte_tipo: 60, pto_vta: 10, numero: 156, rec_doc_nro: '30715675265', rec_razon_social: 'CASILDA COMBUSTIBLES S.R.L.',
      neto: '634452.00', iva: '133234.92', total: '767686.92' }))
    const l = lineaCbte(c)
    expect(pos(l, 9, 11)).toBe('060')
    expect(pos(l, 12, 16)).toBe('00010')
    expect(pos(l, 59, 78)).toBe('00000000030715675265')
    expect(pos(l, 79, 108).trimEnd()).toBe('CASILDA COMBUSTIBLES S.R.L.')
  })

  it('externo: fecha de vencimiento en ceros', () => {
    expect(pos(lineaCbte(desdeExterno(extFila())), 259, 266)).toBe('00000000')
  })
})

describe('línea ALICUOTAS (62)', () => {
  it('campos en su posición', () => {
    const [a] = lineasAlicuotas(desdeErp(erpFila()))
    expect(a).toHaveLength(LARGO_ALICUOTA)
    expect(pos(a!, 1, 3)).toBe('001')
    expect(pos(a!, 4, 8)).toBe('00004')
    expect(pos(a!, 9, 28)).toBe('00000000000000000001')
    expect(pos(a!, 29, 43)).toBe('000000016250000')
    expect(pos(a!, 44, 47)).toBe('0005')
    expect(pos(a!, 48, 62)).toBe('000000003412500')
  })

  it('alicuotasParaArchivo: ignora una 0003 vacía si hay gravadas', () => {
    expect(alicuotasParaArchivo({ alicuotas: [{ codigo: 3, neto: 0, iva: 0 }, { codigo: 5, neto: 10, iva: 2.1 }] })).toHaveLength(1)
    expect(alicuotasParaArchivo({ alicuotas: [] })).toEqual([{ codigo: 3, neto: 0, iva: 0 }])
  })

  it('codigoOperacion', () => {
    expect(codigoOperacion({ alicuotas: [{ codigo: 5, neto: 1, iva: 0.21 }], exento: 0, no_gravado: 0 })).toBe('0')
    expect(codigoOperacion({ alicuotas: [], exento: 1, no_gravado: 1 })).toBe('E')
    expect(codigoOperacion({ alicuotas: [], exento: 0, no_gravado: 1 })).toBe('N')
  })
})

describe('alícuota deducida de los externos', () => {
  it('21 / 10,5 / 27 con tolerancia de centavos', () => {
    expect(deducirAlicuota(1000, 210)).toEqual([{ codigo: 5, neto: 1000, iva: 210 }])
    expect(deducirAlicuota(1000, 210.04)).toEqual([{ codigo: 5, neto: 1000, iva: 210.04 }])
    expect(deducirAlicuota(1000, 105)).toEqual([{ codigo: 4, neto: 1000, iva: 105 }])
    expect(deducirAlicuota(1000, 270)).toEqual([{ codigo: 6, neto: 1000, iva: 270 }])
    expect(deducirAlicuota(6829012.49, 1434092.62)?.[0]?.codigo).toBe(5)
  })

  it('no cierra → null (no se inventa)', () => {
    expect(deducirAlicuota(1000, 150)).toBeNull()
    expect(deducirAlicuota(1000, 210.2)).toBeNull()
    expect(deducirAlicuota(0, 50)).toBeNull()
    // mezcla 21 % + 10,5 %: no es ninguna
    expect(deducirAlicuota(2000, 315)).toBeNull()
  })

  it('neto 0 e IVA 0 → sin gravado', () => {
    expect(deducirAlicuota(0, 0)).toEqual([])
  })

  it('desdeExterno marca si se pudo deducir', () => {
    expect(desdeExterno(extFila()).alicuotaDeducida).toBe(true)
    expect(desdeExterno(extFila({ iva: '150.00', total: '1150.00' })).alicuotaDeducida).toBe(false)
  })
})

describe('validaciones', () => {
  it('comprobante que cierra: sin errores', () => {
    expect(validarComprobante(desdeErp(erpFila())).filter(v => v.severidad === 'error')).toEqual([])
  })

  it('no cierra el total', () => {
    const v = validarComprobante(base({ total: 196626 }))
    expect(v.some(x => x.severidad === 'error' && /No cierra/.test(x.mensaje))).toBe(true)
  })

  it('alícuotas vs cabecera', () => {
    const v = validarComprobante(base({ alicuotas: [{ codigo: 5, neto: 162000, iva: 34125 }] }))
    expect(v.some(x => /detalle por alícuota/.test(x.mensaje))).toBe(true)
  })

  it('CUIT inválida, PV fuera de rango, tipo desconocido, moneda extranjera', () => {
    const v = validarComprobante(base({ doc_nro: '30714069621', pto_vta: 9998, cbte_tipo: 99, moneda: 'DOL', tipo_cambio: 1375 }))
    expect(v.map(x => x.mensaje).join('|')).toMatch(/CUIT/)
    expect(v.map(x => x.mensaje).join('|')).toMatch(/Punto de venta/)
    expect(v.map(x => x.mensaje).join('|')).toMatch(/Tipo de comprobante 99/)
    expect(v.map(x => x.mensaje).join('|')).toMatch(/moneda DOL/)
  })
})

describe('armarLibro', () => {
  const erp = [desdeErp(erpFila()), desdeErp(erpFila({ id: 28, cbte_tipo: 203, numero: 1, imp_neto: '1000', imp_iva: '210', imp_total: '1210',
    alicuotas: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }] }))]
  const ext = [
    desdeExterno(extFila()),
    desdeExterno(extFila({ id: 901, cbte_tipo: 1, pto_vta: 4, numero: 1 })), // duplica al del ERP
    desdeExterno(extFila({ id: 902, numero: 501, iva: '150.00', total: '1150.00' })), // a revisar
    desdeExterno(extFila({ id: 903, cbte_tipo: 60, pto_vta: 10, numero: 156 })),
    desdeExterno(extFila({ id: 904, cbte_tipo: 8, numero: 11, fecha: '2026-08-01' })),
  ]

  it('dedup priorizando el ERP, CVLP apagada, a revisar afuera, NC restan en el resumen', () => {
    const l = armarLibro('2026-09', erp, ext, { incluirCvlp: false })
    // incluidos: erp FA, erp NC FCE, ext FA 500, ext NC B → 4
    expect(l.resumen.comprobantes).toBe(4)
    expect(l.resumen.excluidos).toBe(2)
    expect(l.resumen.lineas_cbte).toBe(4)
    expect(l.resumen.lineas_alicuotas).toBe(4)
    // 162500 + 1000 − 1000 − 1000
    expect(l.resumen.neto).toBe(161500)
    expect(l.resumen.iva).toBe(34125 - 210)
    expect(l.resumen.por_alicuota).toEqual([{ codigo: 5, alicuota: '21 %', neto: 161500, iva: 33915, registros: 4 }])
    expect(l.resumen.por_tipo.map(t => [t.cbte_tipo, t.cantidad])).toEqual([[1, 2], [8, 1], [203, 1]])
    expect(l.validaciones.some(v => v.severidad === 'info' && /ERP/.test(v.mensaje))).toBe(true)
    expect(l.validaciones.some(v => v.severidad === 'error' && /A revisar/.test(v.mensaje))).toBe(true)
    expect(l.validaciones.some(v => v.severidad === 'advertencia' && /CVLP/.test(v.comprobante))).toBe(true)
    // errores primero
    expect(l.validaciones[0]!.severidad).toBe('error')
    // el del ERP gana: el detalle del dup es el de origen erp
    expect(l.detalle.filter(d => d.pto_vta === 4 && d.cbte_tipo === 1).map(d => d.origen)).toEqual(['erp'])
  })

  it('con CVLP incluida', () => {
    const l = armarLibro('2026-09', erp, ext, { incluirCvlp: true })
    expect(l.resumen.comprobantes).toBe(5)
    expect(l.resumen.por_tipo.some(t => t.cbte_tipo === 60)).toBe(true)
  })

  it('archivos: CRLF, longitudes exactas y MISMO orden de comprobantes en los dos', () => {
    const l = armarLibro('2026-09', erp, ext, { incluirCvlp: true })
    expect(l.archivos.cbte.endsWith('\r\n')).toBe(true)
    const cb = l.archivos.cbte.split('\r\n').slice(0, -1)
    const al = l.archivos.alicuotas.split('\r\n').slice(0, -1)
    expect(cb.every(x => x.length === 266)).toBe(true)
    expect(al.every(x => x.length === 62)).toBe(true)
    expect(l.archivos.cbte).not.toMatch(/[^\r]\n/)
    const claveC = cb.map(x => pos(x, 9, 36))
    const claveA = al.map(x => pos(x, 1, 28))
    expect(claveA).toEqual(claveC) // una alícuota por comprobante acá
    // orden por fecha
    const fechas = cb.map(x => pos(x, 1, 8))
    expect([...fechas].sort()).toEqual(fechas)
  })

  it('período vacío: archivos vacíos', () => {
    const l = armarLibro('2026-01', [], [], { incluirCvlp: false })
    expect(l.archivos).toEqual({ cbte: '', alicuotas: '' })
    expect(l.resumen.comprobantes).toBe(0)
  })

  it('unirLineas', () => {
    expect(unirLineas(['a', 'b'])).toBe('a\r\nb\r\n')
    expect(unirLineas([])).toBe('')
  })
})

describe('período y nombre', () => {
  it('rango del mes', () => {
    expect(rangoPeriodo('2026-09')).toEqual({ desde: '2026-09-01', hasta: '2026-09-30' })
    expect(rangoPeriodo('2028-02')).toEqual({ desde: '2028-02-01', hasta: '2028-02-29' })
    expect(() => rangoPeriodo('2026-13')).toThrow(LidFormatoError)
    expect(() => rangoPeriodo('202609')).toThrow(LidFormatoError)
  })
  it('nombre de archivo', () => {
    expect(nombreArchivo('2026-09', 'cbte')).toBe('LIBRO_IVA_DIGITAL_VENTAS_CBTE_202609.txt')
    expect(nombreArchivo('2026-09', 'alicuotas')).toBe('LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS_202609.txt')
  })
})
