/**
 * Libro IVA Digital de Compras: posiciones de los registros (Anexo I, 325 y 84),
 * B/C sin alícuotas, exclusiones y la posición de IVA del mes.
 */
import { describe, it, expect } from 'vitest'
import {
  armarLibroCompras, desdeFacturaCompra, lineaCbteCompra, lineasAlicuotasCompra, partirNumero, posicionIva,
  tipoLidDe, itcComputableDe, type FilaFacturaCompra,
} from '../../../src/modules/facturacion/lid-compras.js'

// La factura 11 real (Cencosud, 18/09): 21 % + percepción IVA + IIBB Tucumán.
const CENCOSUD: FilaFacturaCompra = {
  id: 11, tipo_comprobante: 'A', cbte_tipo_arca: 1, numero: '08837-00004557', fecha: '2026-09-18',
  neto: '116495.87', iva: '24464.13', no_gravado: null, exento: null, total: '152609.59',
  estado: 'pagada', paga_cliente: false, desglose_a_revisar: false, periodo_iva: '2026-09-01',
  proveedor: { razon_social: 'Cencosud S.A', cuit: '30590360763' },
  iva_detalle: [{ alicuota_id: 5, base_imp: 116495.87, importe: 24464.13 }],
  tributos: [{ tipo: 'percepcion_iva', importe: 3494.88 }, { tipo: 'percepcion_iibb', importe: 8154.71 }],
}
const conFila = (f: FilaFacturaCompra) => ({ ...desdeFacturaCompra(f), fila: f })
const campo = (l: string, desde: number, hasta: number) => l.slice(desde - 1, hasta)

describe('normalización', () => {
  it('parte el número y deduce el tipo', () => {
    expect(partirNumero('08837-00004557')).toEqual({ pto_vta: 8837, numero: 4557 })
    expect(partirNumero('0012-00402141')).toEqual({ pto_vta: 12, numero: 402141 })
    expect(partirNumero('402141')).toBeNull()
    expect(tipoLidDe('A', null)).toBe(1)
    expect(tipoLidDe('C', null)).toBe(11)
    expect(tipoLidDe('A', 201)).toBe(201)
    expect(tipoLidDe('ticket', null)).toBeNull()
  })
})

describe('LIBRO_IVA_DIGITAL_COMPRAS_CBTE', () => {
  const c = desdeFacturaCompra(CENCOSUD).c!
  const l = lineaCbteCompra(c)

  it('325 posiciones, cada campo en su lugar', () => {
    expect(l).toHaveLength(325)
    expect(campo(l, 1, 8)).toBe('20260918')
    expect(campo(l, 9, 11)).toBe('001')
    expect(campo(l, 12, 16)).toBe('08837')
    expect(campo(l, 17, 36)).toBe('00000000000000004557')
    expect(campo(l, 37, 52)).toBe(' '.repeat(16))
    expect(campo(l, 53, 54)).toBe('80')
    expect(campo(l, 55, 74)).toBe('00000000030590360763')
    expect(campo(l, 75, 104)).toBe('Cencosud S.A'.padEnd(30))
    expect(campo(l, 105, 119)).toBe('000000015260959')
    expect(campo(l, 150, 164)).toBe('000000000349488') // percepción IVA
    expect(campo(l, 180, 194)).toBe('000000000815471') // IIBB
    expect(campo(l, 225, 227)).toBe('PES')
    expect(campo(l, 228, 237)).toBe('0001000000')
    expect(campo(l, 238, 238)).toBe('1')
    expect(campo(l, 239, 239)).toBe(' ')
    expect(campo(l, 240, 254)).toBe('000000002446413') // crédito fiscal = IVA liquidado
    expect(campo(l, 270, 280)).toBe('0'.repeat(11))
    expect(campo(l, 281, 310)).toBe(' '.repeat(30))
    expect(campo(l, 311, 325)).toBe('0'.repeat(15))
  })

  it('ALICUOTAS: 84 posiciones con el documento del vendedor', () => {
    const [a] = lineasAlicuotasCompra(c)
    expect(a).toHaveLength(84)
    expect(campo(a!, 1, 3)).toBe('001')
    expect(campo(a!, 29, 30)).toBe('80')
    expect(campo(a!, 31, 50)).toBe('00000000030590360763')
    expect(campo(a!, 51, 65)).toBe('000000011649587')
    expect(campo(a!, 66, 69)).toBe('0005')
    expect(campo(a!, 70, 84)).toBe('000000002446413')
  })

  it('factura C: cantidad de alícuotas 0, sin registros de alícuotas y sin crédito fiscal', () => {
    const fc = desdeFacturaCompra({ ...CENCOSUD, tipo_comprobante: 'C', cbte_tipo_arca: 11, neto: null, iva: null, total: '5000', iva_detalle: [], tributos: [] }).c!
    const lc = lineaCbteCompra(fc)
    expect(campo(lc, 238, 238)).toBe('0')
    // Código de operación «N», como el COMPRAS_CBTE ago-2026 v5 del contador.
    expect(campo(lc, 239, 239)).toBe('N')
    expect(campo(lc, 240, 254)).toBe('0'.repeat(15))
    expect(lineasAlicuotasCompra(fc)).toEqual([])
  })
})

describe('armarLibroCompras', () => {
  it('el libro con la factura real cierra y resume', () => {
    const libro = armarLibroCompras('2026-09', [conFila(CENCOSUD)])
    expect(libro.validaciones.filter(v => v.severidad === 'error')).toEqual([])
    expect(libro.resumen).toMatchObject({ comprobantes: 1, iva: 24464.13, credito_fiscal: 24464.13, perc_iva: 3494.88, perc_iibb: 8154.71, excluidos: 0 })
    expect(libro.archivos.cbte.endsWith('\r\n')).toBe(true)
  })

  it('sin desglose (la #19 Zeramiko) queda FUERA con error', () => {
    const zer: FilaFacturaCompra = { ...CENCOSUD, id: 19, numero: '00051-00008941', neto: null, iva: null, total: '19000',
      desglose_a_revisar: true, iva_detalle: [], tributos: [], proveedor: { razon_social: 'Zeramiko', cuit: '27127040163' } }
    const libro = armarLibroCompras('2026-09', [conFila(zer)])
    expect(libro.resumen.excluidos).toBe(1)
    expect(libro.archivos.cbte).toBe('')
    expect(libro.validaciones[0]!.mensaje).toMatch(/desglose/)
  })

  it('un centavo de redondeo del proveedor: advertencia y se informa; dos centavos: error', () => {
    const uno = armarLibroCompras('2026-09', [conFila({ ...CENCOSUD, total: '152609.60' })])
    expect(uno.resumen.comprobantes).toBe(1)
    expect(uno.validaciones.filter(v => v.severidad === 'error')).toEqual([])
    expect(uno.validaciones.some(v => v.severidad === 'advertencia' && /redondeo/.test(v.mensaje))).toBe(true)
    const dos = armarLibroCompras('2026-09', [conFila({ ...CENCOSUD, total: '152609.61' })])
    expect(dos.validaciones.some(v => v.severidad === 'error' && /No cierra/.test(v.mensaje))).toBe(true)
  })

  it('número sin guion y CUIT inválida quedan fuera con error; el ticket no va y NO deja la posición incompleta', () => {
    const libro = armarLibroCompras('2026-09', [
      conFila({ ...CENCOSUD, id: 1, tipo_comprobante: 'ticket', cbte_tipo_arca: null }),
      conFila({ ...CENCOSUD, id: 2, numero: '4557' }),
      conFila({ ...CENCOSUD, id: 3, proveedor: { razon_social: 'X', cuit: '30590360764' } }),
    ])
    expect(libro.resumen.excluidos).toBe(2)
    expect(libro.resumen.comprobantes).toBe(0)
    expect(libro.validaciones.find(v => v.comprobante.startsWith('ticket'))?.severidad).toBe('info')
  })

  it('la misma factura en dos proveedores del padrón con la misma CUIT: una sola vez, sin contar como excluida', () => {
    const libro = armarLibroCompras('2026-09', [conFila(CENCOSUD), conFila({ ...CENCOSUD, id: 99 })])
    expect(libro.resumen.comprobantes).toBe(1)
    expect(libro.resumen.excluidos).toBe(0)
    expect(libro.validaciones.some(v => v.severidad === 'advertencia' && /dos veces/.test(v.mensaje))).toBe(true)
  })

  it('una factura C con IVA cargado por error no suma IVA al resumen', () => {
    const fc: FilaFacturaCompra = { ...CENCOSUD, id: 7, tipo_comprobante: 'C', cbte_tipo_arca: 11, neto: '1000', iva: '210', total: '1210', iva_detalle: [], tributos: [] }
    const libro = armarLibroCompras('2026-09', [conFila(fc)])
    expect(libro.resumen).toMatchObject({ comprobantes: 1, iva: 0, credito_fiscal: 0 })
  })

  it('la NC resta del crédito fiscal', () => {
    const nc: FilaFacturaCompra = { ...CENCOSUD, id: 50, cbte_tipo_arca: 3, numero: '08837-00000010', total: '1210', neto: '1000', iva: '210',
      iva_detalle: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }], tributos: [] }
    const libro = armarLibroCompras('2026-09', [conFila(CENCOSUD), conFila(nc)])
    expect(libro.resumen.credito_fiscal).toBe(24254.13)
    expect('nc_en_ordenes' in libro.resumen).toBe(false)
  })

  it('una NC A con percepción de IVA resta en crédito fiscal y en percepciones', () => {
    // NC A 003 de Cencosud: neto 1000 + IVA 210 + percepción IVA 30 = 1240.
    const nc: FilaFacturaCompra = { ...CENCOSUD, id: 51, cbte_tipo_arca: 3, numero: '08837-00000011', estado: 'aprobada',
      neto: '1000', iva: '210', total: '1240',
      iva_detalle: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }], tributos: [{ tipo: 'percepcion_iva', importe: 30 }] }
    const libro = armarLibroCompras('2026-09', [conFila(CENCOSUD), conFila(nc)])
    expect(libro.resumen.comprobantes).toBe(2)
    expect(libro.resumen.credito_fiscal).toBe(24254.13)          // 24464.13 − 210
    expect(libro.resumen.perc_iva).toBe(3464.88)                 // 3494.88 − 30
    expect(libro.resumen.total).toBe(151369.59)                  // 152609.59 − 1240
    expect(libro.validaciones.filter(v => v.severidad === 'error')).toEqual([])
    // En el archivo va en positivo, con su código 003: el signo lo pone el tipo.
    const lnc = libro.archivos.cbte.split('\r\n').find(l => l.slice(8, 11) === '003')!
    expect(lnc.slice(104, 119)).toBe('000000000124000')
    expect(lnc.slice(149, 164)).toBe('000000000003000')
  })

  it('la NC sin aprobar avisa como NC, no como factura', () => {
    const nc: FilaFacturaCompra = { ...CENCOSUD, id: 52, cbte_tipo_arca: 3, numero: '08837-00000012', estado: 'pendiente',
      neto: '1000', iva: '210', total: '1210', iva_detalle: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }], tributos: [] }
    const libro = armarLibroCompras('2026-09', [conFila(nc)])
    expect(libro.validaciones.some(v => /^La NC todavía no está aprobada/.test(v.mensaje))).toBe(true)
    expect(libro.validaciones.some(v => /^La factura/.test(v.mensaje))).toBe(false)
  })
})

describe('posicionIva', () => {
  it('a pagar: débito − crédito − percepciones − retenciones', () => {
    const p = posicionIva('2026-09', { debito: 100000, credito: 60000, percepciones: 5000, retenciones: 1000, excluidosVentas: 0, excluidosCompras: 0 })
    expect(p).toMatchObject({ impuesto_determinado: 40000, a_pagar: 34000, libre_disponibilidad: 0, saldo_tecnico_a_favor: 0 })
  })
  it('crédito mayor: saldo técnico a favor y los pagos a cuenta quedan de libre disponibilidad', () => {
    const p = posicionIva('2026-09', { debito: 10000, credito: 30000, percepciones: 3494.88, retenciones: 0, excluidosVentas: 0, excluidosCompras: 1 })
    expect(p).toMatchObject({ impuesto_determinado: -20000, saldo_tecnico_a_favor: 20000, a_pagar: 0, libre_disponibilidad: 3494.88 })
    expect(p.avisos.some(a => /COMPRAS/.test(a))).toBe(true)
  })
  it('ya no informa NC en órdenes de pago', () => {
    const p = posicionIva('2026-09', { debito: 1, credito: 1, percepciones: 0, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0 })
    expect('nc_en_ordenes' in p).toBe(false)
    expect(p.avisos.some(a => /MENOR/.test(a))).toBe(false)
  })
  it('pagos a cuenta que superan el determinado: el sobrante es libre disponibilidad', () => {
    const p = posicionIva('2026-09', { debito: 10000, credito: 8000, percepciones: 3000, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0 })
    expect(p).toMatchObject({ a_pagar: 0, libre_disponibilidad: 1000 })
  })
})

describe('ICL / IDC y pago a cuenta ITC (20261001a/b)', () => {
  // YPF 01420-00284841 (15/08), sin la Tasa Vial: ICL 4.794.943,13 e IDC 530.296,55.
  const YPF: FilaFacturaCompra = {
    id: 532, tipo_comprobante: 'A', cbte_tipo_arca: 1, numero: '01420-00284841', fecha: '2026-08-15',
    neto: '27659148.84', iva: '5808421.26', no_gravado: null, exento: null, total: '39713960.07',
    estado: 'pagada', paga_cliente: false, desglose_a_revisar: false, periodo_iva: '2026-08-01',
    proveedor: { razon_social: 'YPF SOCIEDAD ANONIMA', cuit: '30546689979', icl_computa_pago_a_cuenta: true },
    iva_detalle: [{ alicuota_id: 5, base_imp: 27659148.84, importe: 5808421.26 }],
    tributos: [
      { tipo: 'icl', importe: '4794943.13' }, { tipo: 'idc', importe: '530296.55' },
      { tipo: 'percepcion_iva', importe: '829774.48' }, { tipo: 'percepcion_iibb', importe: '91375.81' },
    ],
  }
  const comoOtro: FilaFacturaCompra = { ...YPF, tributos: YPF.tributos.map(t => (t.tipo === 'icl' || t.tipo === 'idc' ? { ...t, tipo: 'otro' } : t)) }

  it('el LID sale idéntico a cuando ICL e IDC eran «otro» (campo 22)', () => {
    const a = armarLibroCompras('2026-08', [conFila(YPF)])
    const b = armarLibroCompras('2026-08', [conFila(comoOtro)])
    expect(a.archivos).toEqual(b.archivos)
    expect(a.resumen.otros_tributos).toBe(5325239.68)
    expect(a.validaciones.filter(v => v.severidad === 'error')).toEqual([])
  })

  it('45 % del ICL por fila, solo si el proveedor lo computa; el IDC nunca', () => {
    expect(itcComputableDe(YPF)).toBe(2157724.41)
    expect(itcComputableDe({ ...YPF, proveedor: { razon_social: 'X', cuit: '30546689979', icl_computa_pago_a_cuenta: false } })).toBe(0)
    expect(itcComputableDe({ ...YPF, tributos: [{ tipo: 'icl', importe: 0.01 }, { tipo: 'icl', importe: 0.01 }] })).toBe(0)
    expect(armarLibroCompras('2026-08', [conFila(YPF)]).resumen.itc_computable).toBe(2157724.41)
    expect(armarLibroCompras('2026-08', [conFila(comoOtro)]).resumen.itc_computable).toBe(0)
  })

  it('la posición resta el ITC antes que percepciones; el sobrante se traslada, no es libre disponibilidad', () => {
    const p = posicionIva('2026-08', { debito: 100000, credito: 60000, percepciones: 5000, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0, itc: 10000 })
    expect(p).toMatchObject({ impuesto_determinado: 40000, pago_a_cuenta_itc: 10000, itc_computado: 10000, itc_remanente: 0, a_pagar: 25000, libre_disponibilidad: 0 })
    const q = posicionIva('2026-08', { debito: 100000, credito: 95000, percepciones: 2000, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0, itc: 8000 })
    expect(q).toMatchObject({ itc_computado: 5000, itc_remanente: 3000, a_pagar: 0, libre_disponibilidad: 2000 })
    expect(q.avisos.some(a => /ITC/.test(a) && /meses siguientes/.test(a))).toBe(true)
    const r = posicionIva('2026-08', { debito: 1000, credito: 3000, percepciones: 0, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0, itc: 500 })
    expect(r).toMatchObject({ saldo_tecnico_a_favor: 2000, itc_computado: 0, itc_remanente: 500, libre_disponibilidad: 0 })
  })

  it('agosto 2026 real: DF − CF − ITC − percepciones', () => {
    const p = posicionIva('2026-08', { debito: 61932549.48, credito: 28881925.78, percepciones: 1375068.54, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0, itc: 3545511.23 })
    expect(p).toMatchObject({ impuesto_determinado: 33050623.70, itc_computado: 3545511.23, a_pagar: 28130043.93 })
  })
})

describe('período IVA (20260927a)', () => {
  it('una factura de agosto informada en septiembre: fuera_de_mes + validación info, y el campo 1 sigue siendo su fecha', () => {
    const agosto: FilaFacturaCompra = { ...CENCOSUD, id: 30, numero: '08837-00004000', fecha: '2026-08-28', periodo_iva: '2026-09-01' }
    const libro = armarLibroCompras('2026-09', [conFila(CENCOSUD), conFila(agosto)])
    const d = libro.detalle.find(x => x.ref_id === 30)!
    expect(d).toMatchObject({ periodo_iva: '2026-09-01', fuera_de_mes: true, incluido: true })
    expect(libro.detalle.find(x => x.ref_id === 11)).toMatchObject({ periodo_iva: '2026-09-01', fuera_de_mes: false })
    expect(libro.validaciones).toEqual(expect.arrayContaining([
      expect.objectContaining({ severidad: 'info', mensaje: 'Comprobante del 28/08/2026 informado en este período (período IVA corrido).' }),
    ]))
    // Orden por fecha: la de agosto va primero, con SU fecha en el campo 1.
    expect(libro.archivos.cbte.split('\r\n')[0]!.slice(0, 8)).toBe('20260828')
    expect(libro.resumen.comprobantes).toBe(2)
  })

  it('sin periodo_iva (fila vieja) toma el mes de la fecha', () => {
    const vieja = { ...CENCOSUD, periodo_iva: undefined as unknown as string }
    const libro = armarLibroCompras('2026-09', [conFila(vieja)])
    expect(libro.detalle[0]).toMatchObject({ periodo_iva: '2026-09-01', fuera_de_mes: false })
    expect(libro.validaciones.some(v => v.severidad === 'info' && v.mensaje.includes('período IVA corrido'))).toBe(false)
  })

  it('«otros tributos» de ARCA sin clasificar: advertencia', () => {
    const imp: FilaFacturaCompra = {
      ...CENCOSUD, id: 31, numero: '00003-00001234', tributos_a_revisar: true,
      tributos: [{ tipo: 'otro', importe: 3494.88 }, { tipo: 'percepcion_iibb', importe: 8154.71 }],
    }
    const libro = armarLibroCompras('2026-09', [conFila(imp)])
    expect(libro.validaciones).toEqual(expect.arrayContaining([
      expect.objectContaining({ severidad: 'advertencia', mensaje: expect.stringContaining('Otros tributos de ARCA sin clasificar') }),
    ]))
  })
})
