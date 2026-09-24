/**
 * Libro IVA Digital de Compras: posiciones de los registros (Anexo I, 325 y 84),
 * B/C sin alícuotas, exclusiones y la posición de IVA del mes.
 */
import { describe, it, expect } from 'vitest'
import {
  armarLibroCompras, desdeFacturaCompra, lineaCbteCompra, lineasAlicuotasCompra, partirNumero, posicionIva,
  tipoLidDe, type FilaFacturaCompra,
} from '../../../src/modules/facturacion/lid-compras.js'

// La factura 11 real (Cencosud, 18/09): 21 % + percepción IVA + IIBB Tucumán.
const CENCOSUD: FilaFacturaCompra = {
  id: 11, tipo_comprobante: 'A', cbte_tipo_arca: 1, numero: '08837-00004557', fecha: '2026-09-18',
  neto: '116495.87', iva: '24464.13', no_gravado: null, exento: null, total: '152609.59',
  estado: 'pagada', paga_cliente: false, desglose_a_revisar: false,
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
    expect(campo(l, 37, 52)).toBe('0'.repeat(16))
    expect(campo(l, 53, 54)).toBe('80')
    expect(campo(l, 55, 74)).toBe('00000000030590360763')
    expect(campo(l, 75, 104)).toBe('Cencosud S.A'.padEnd(30))
    expect(campo(l, 105, 119)).toBe('000000015260959')
    expect(campo(l, 150, 164)).toBe('000000000349488') // percepción IVA
    expect(campo(l, 180, 194)).toBe('000000000815471') // IIBB
    expect(campo(l, 225, 227)).toBe('PES')
    expect(campo(l, 228, 237)).toBe('0001000000')
    expect(campo(l, 238, 238)).toBe('1')
    expect(campo(l, 239, 239)).toBe('0')
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

  it('no cierra por un centavo: error, pero se informa', () => {
    const f = { ...CENCOSUD, total: '152609.60' }
    const libro = armarLibroCompras('2026-09', [conFila(f)])
    expect(libro.resumen.comprobantes).toBe(1)
    expect(libro.validaciones.some(v => v.severidad === 'error' && /No cierra/.test(v.mensaje))).toBe(true)
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

  it('la NC resta y las NC de OP sin comprobante avisan', () => {
    const nc: FilaFacturaCompra = { ...CENCOSUD, id: 50, cbte_tipo_arca: 3, numero: '08837-00000010', total: '1210', neto: '1000', iva: '210',
      iva_detalle: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }], tributos: [] }
    const libro = armarLibroCompras('2026-09', [conFila(CENCOSUD), conFila(nc)],
      [{ orden: 'OP-0007', proveedor: 'ABC', nc_numero: '0001-1', nc_fecha: '2026-09-10', monto: 500 }])
    expect(libro.resumen.credito_fiscal).toBe(24254.13)
    expect(libro.validaciones.some(v => /órdenes de pago/.test(v.comprobante))).toBe(true)
    expect(libro.resumen.nc_en_ordenes).toBe(1)
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
  it('las NC en órdenes de pago avisan que el crédito real es menor', () => {
    const p = posicionIva('2026-09', { debito: 1, credito: 1, percepciones: 0, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0, ncEnOrdenes: 2 })
    expect(p.nc_en_ordenes).toBe(2)
    expect(p.avisos.some(a => /MENOR/.test(a))).toBe(true)
  })
  it('pagos a cuenta que superan el determinado: el sobrante es libre disponibilidad', () => {
    const p = posicionIva('2026-09', { debito: 10000, credito: 8000, percepciones: 3000, retenciones: 0, excluidosVentas: 0, excluidosCompras: 0 })
    expect(p).toMatchObject({ a_pagar: 0, libre_disponibilidad: 1000 })
  })
})
