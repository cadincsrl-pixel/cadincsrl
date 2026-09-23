// Reglas puras de Facturación: totales (espejo de ventas_guardar_borrador),
// fechas, concepto, armado del FECAESolicitar desde el FJ de la base, p_res de
// confirmar_emision, coincidencia en la reconciliación y resumen.
import { describe, it, expect } from 'vitest'
import {
  calcularTotales, importeNetoRenglon, redondear, aYyyymmdd, deYyyymmdd, conceptoDe, esNC, admiteLetraA,
  armarComprobante, pResDeCAE, pResDeConsultado, coincideConsultado, resumir, normDoc, CONDICIONES_IVA,
  letraDe, letraDeTipo, tipoPara, requiereIdentificacion, TOPE_CF_IDENTIFICACION, TIPOS_HABILITADOS,
  type FJ,
} from '../../../src/modules/facturacion/reglas.js'
import { sobreFECAESolicitar, type ComprobanteConsultado } from '../../../src/lib/arca/index.js'

describe('redondeo y totales', () => {
  it('redondea half-up como numeric de Postgres', () => {
    expect(redondear(1.005, 2)).toBe(1.01)
    expect(redondear(2.675, 2)).toBe(2.68)
    expect(redondear(-1.005, 2)).toBe(-1.01)
    expect(redondear(0.1 + 0.2, 2)).toBe(0.3)
  })

  it('neto del renglón = round(round(cant,4) × round(precio,3), 2)', () => {
    expect(importeNetoRenglon({ cantidad: 1, precio_unit: 1000 })).toBe(1000)
    expect(importeNetoRenglon({ cantidad: 3, precio_unit: 0.335 })).toBe(1.01) // 1.005 → 1.01
    expect(importeNetoRenglon({ cantidad: 1.23456, precio_unit: 10 })).toBe(12.35) // cant → 1.2346
    expect(importeNetoRenglon({ precio_unit: 99.9999 })).toBe(100) // precio → 100.000, cantidad default 1
  })

  it('1 renglón de 1000 al 21 %', () => {
    const t = calcularTotales([{ cantidad: 1, precio_unit: 1000, alicuota_id: 5 }])
    expect(t).toEqual({ neto: 1000, iva: 210, total: 1210, alicuotas: [{ alicuota_id: 5, tasa: 0.21, base_imp: 1000, importe: 210 }] })
  })

  it('el IVA va sobre la base AGRUPADA, no renglón por renglón', () => {
    // Renglón por renglón: 3 × round(0.105, 2) = 3 × 0.11 = 0.33. Agrupado: round(1.5 × 0.21) = 0.32.
    const t = calcularTotales([
      { cantidad: 1, precio_unit: 0.5, alicuota_id: 5 },
      { cantidad: 1, precio_unit: 0.5, alicuota_id: 5 },
      { cantidad: 1, precio_unit: 0.5, alicuota_id: 5 },
    ])
    expect(t.iva).toBe(0.32)
    expect(t.total).toBe(1.82)
  })

  it('varias alícuotas, ordenadas por id; 0 % cuenta en neto', () => {
    const t = calcularTotales([
      { cantidad: 2, precio_unit: 100, alicuota_id: 5 },
      { cantidad: 1, precio_unit: 333.333, alicuota_id: 4 },
      { cantidad: 1, precio_unit: 50 },          // default 21 %
      { cantidad: 1, precio_unit: 10, alicuota_id: 3 },
    ])
    expect(t.alicuotas.map((a) => a.alicuota_id)).toEqual([3, 4, 5])
    expect(t.alicuotas).toEqual([
      { alicuota_id: 3, tasa: 0, base_imp: 10, importe: 0 },
      { alicuota_id: 4, tasa: 0.105, base_imp: 333.33, importe: 35 },   // 34.99965 → 35.00
      { alicuota_id: 5, tasa: 0.21, base_imp: 250, importe: 52.5 },
    ])
    expect(t.neto).toBe(593.33)
    expect(t.iva).toBe(87.5)
    expect(t.total).toBe(680.83)
  })

  it('alícuota desconocida lanza', () => {
    expect(() => calcularTotales([{ precio_unit: 1, alicuota_id: 7 }])).toThrow()
  })
})

describe('fechas, concepto, letra', () => {
  it('yyyymmdd ida y vuelta', () => {
    expect(aYyyymmdd('2026-09-24')).toBe('20260924')
    expect(aYyyymmdd('2026-09-24T10:00:00Z')).toBe('20260924')
    expect(deYyyymmdd('20261004')).toBe('2026-10-04')
    expect(deYyyymmdd('')).toBeNull()
    expect(deYyyymmdd(null)).toBeNull()
    expect(() => aYyyymmdd('24/09/2026')).toThrow()
  })

  it('concepto: transporte 2, avance de obra 3', () => {
    expect(conceptoDe('TRANSPORTE')).toBe(2)
    expect(conceptoDe('AVANCE DE OBRA')).toBe(3)
  })

  it('NC y letra A', () => {
    expect(esNC(3)).toBe(true)
    expect(esNC(1)).toBe(false)
    expect(admiteLetraA(80, 1)).toBe(true)
    expect(admiteLetraA(80, 6)).toBe(true)
    expect(admiteLetraA(80, 5)).toBe(false)
    expect(admiteLetraA(96, 1)).toBe(false)
    expect(CONDICIONES_IVA.filter((c) => c.admite_a).map((c) => c.id)).toEqual([1, 6, 13, 16])
  })

  it('documento normalizado', () => {
    expect(normDoc(80, '20-11111111-2')).toBe('20111111112')
    expect(normDoc(99, '123')).toBe('0')
    expect(normDoc(96, '')).toBeNull()
  })
})

// ── Armado desde el FJ ─────────────────────────────────────────────────────

function fjBase(over: Partial<FJ['factura']> = {}): FJ {
  return {
    factura: {
      id: 10, ambiente: 'homo', pto_vta: 3, cbte_tipo: 1, numero: null, numero_intentado: null, estado: 'emitiendo',
      concepto: 3, fecha_cbte: '2026-09-24', fch_vto_pago: '2026-09-24', cliente_id: 1,
      rec_doc_tipo: 80, rec_doc_nro: '20111111112', rec_condicion_iva_id: 1,
      producto: 'AVANCE DE OBRA', centro_costo: 'ANIMAR', moneda: 'PES', cotizacion: 1,
      imp_neto: 1000, imp_iva: 210, imp_trib: 0, imp_op_ex: 0, imp_tot_conc: 0, imp_total: 1210,
      intento_at: null, updated_at: '2026-09-24T12:00:00Z', emitida_por: 'u', created_by: 'u',
      ...over,
    },
    renglones: [],
    alicuotas: [{ alicuota_id: 5, tasa: 0.21, base_imp: 1000, importe: 210 }],
    asociados: [],
  }
}

describe('armarComprobante', () => {
  it('Factura A avance de obra: concepto 3 con FchServDesde = Hasta = VtoPago = CbteFch', () => {
    const c = armarComprobante(fjBase(), 7)
    expect(c).toMatchObject({
      ptoVta: 3, cbteTipo: 1, numero: 7, concepto: 3, docTipo: 80, docNro: '20111111112', cbteFch: '20260924',
      impTotal: 1210, impNeto: 1000, impIva: 210, impTrib: 0, impOpEx: 0, impTotConc: 0,
      fchServDesde: '20260924', fchServHasta: '20260924', fchVtoPago: '20260924',
      monId: 'PES', monCotiz: 1, condicionIvaReceptorId: 1,
      iva: [{ id: 5, baseImp: 1000, importe: 210 }],
    })
    expect(c.cbtesAsoc).toBeUndefined()
  })

  it('concepto 1 no manda fechas de servicio', () => {
    const c = armarComprobante(fjBase({ concepto: 1 }), 1)
    expect(c.fchServDesde).toBeUndefined()
    expect(c.fchVtoPago).toBeUndefined()
  })

  it('NC A: CbtesAsoc con el CUIT de CADINC y la fecha de la factura', () => {
    const fj = fjBase({ cbte_tipo: 3, imp_neto: 100, imp_iva: 21, imp_total: 121 })
    fj.alicuotas = [{ alicuota_id: 5, tasa: 0.21, base_imp: 100, importe: 21 }]
    fj.asociados = [{ asociada_id: 9, cbte_tipo: 1, pto_vta: 3, numero: 7, cuit: '33717191949', fecha_cbte: '2026-09-23' }]
    const c = armarComprobante(fj, 2)
    expect(c.cbtesAsoc).toEqual([{ tipo: 1, ptoVta: 3, nro: 7, cuit: '33717191949', cbteFch: '20260923' }])
    // Y el sobre lo acepta (orden del WSDL: CondicionIVAReceptorId, CbtesAsoc, Iva).
    const xml = sobreFECAESolicitar({ token: 't', sign: 's', expiraAt: new Date() }, '33717191949', c)
    expect(xml).toMatch(/<ar:CondicionIVAReceptorId>1<\/ar:CondicionIVAReceptorId><ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>1<\/ar:Tipo><ar:PtoVta>3<\/ar:PtoVta><ar:Nro>7<\/ar:Nro><ar:Cuit>33717191949<\/ar:Cuit><ar:CbteFch>20260923<\/ar:CbteFch>/)
    expect(xml).toMatch(/<ar:CbteTipo>3<\/ar:CbteTipo>/)
  })

  it('números que vienen como string desde la base', () => {
    const fj = fjBase({ imp_total: '1210.00' as unknown as number, pto_vta: '3' as unknown as number })
    const c = armarComprobante(fj, 1)
    expect(c.impTotal).toBe(1210)
    expect(c.ptoVta).toBe(3)
  })
})

describe('Factura B (fase 5)', () => {
  it('la letra sale del cliente: A = CUIT + 1/6/13/16; B = 4/5/7/8/9/10/15; el resto, ninguna', () => {
    expect(letraDe(80, 1)).toBe('A')
    expect(letraDe(80, 6)).toBe('A')
    expect(letraDe(80, 13)).toBe('A')
    expect(letraDe(80, 16)).toBe('A')
    for (const c of [4, 5, 7, 8, 9, 10, 15]) {
      expect(letraDe(80, c)).toBe('B')
      expect(letraDe(96, c)).toBe('B')
      expect(letraDe(99, c)).toBe('B')
    }
    // RI o monotributo sin CUIT: ARCA no los acepta en la B → corregir el cliente.
    expect(letraDe(96, 1)).toBeNull()
    expect(letraDe(99, 6)).toBeNull()
    expect(letraDe(86, 1)).toBeNull()
  })

  it('cada condición admite exactamente una clase (FEParamGetCondicionIvaReceptor A/B, homologación 23/09)', () => {
    for (const c of CONDICIONES_IVA) expect(c.admite_a !== c.admite_b).toBe(true)
    expect(CONDICIONES_IVA.filter((c) => c.admite_b).map((c) => c.id)).toEqual([4, 5, 7, 8, 9, 10, 15])
  })

  it('tipo por letra y NC; letra por tipo', () => {
    expect(tipoPara('A', false)).toBe(1)
    expect(tipoPara('A', true)).toBe(3)
    expect(tipoPara('B', false)).toBe(6)
    expect(tipoPara('B', true)).toBe(8)
    expect(letraDeTipo(1)).toBe('A')
    expect(letraDeTipo(3)).toBe('A')
    expect(letraDeTipo(201)).toBe('A')
    expect(letraDeTipo(6)).toBe('B')
    expect(letraDeTipo(8)).toBe('B')
    expect(letraDeTipo(11)).toBeNull()
    expect([...TIPOS_HABILITADOS]).toEqual([1, 3, 6, 8])
  })

  it('consumidor final sin identificar: desde $ 10.000.000 inclusive (RG 5700/2025)', () => {
    expect(TOPE_CF_IDENTIFICACION).toBe(10_000_000)
    expect(requiereIdentificacion(6, 99, 9_999_999.99)).toBe(false)
    expect(requiereIdentificacion(6, 99, 10_000_000)).toBe(true)
    expect(requiereIdentificacion(8, 99, 12_000_000)).toBe(true)
    expect(requiereIdentificacion(6, 96, 50_000_000)).toBe(false)   // con DNI, sin tope
    expect(requiereIdentificacion(1, 99, 50_000_000)).toBe(false)   // la A ya exige CUIT
  })

  it('FB a consumidor final sin identificar: DocTipo 99, DocNro 0, IVA discriminado y condición 5', () => {
    const fj = fjBase({ cbte_tipo: 6, rec_doc_tipo: 99, rec_doc_nro: '0', rec_condicion_iva_id: 5 })
    const c = armarComprobante(fj, 1)
    expect(c).toMatchObject({
      cbteTipo: 6, docTipo: 99, docNro: '0', impNeto: 1000, impIva: 210, impTotal: 1210,
      condicionIvaReceptorId: 5, iva: [{ id: 5, baseImp: 1000, importe: 210 }],
    })
    const xml = sobreFECAESolicitar({ token: 't', sign: 's', expiraAt: new Date() }, '33717191949', c)
    expect(xml).toMatch(/<ar:DocTipo>99<\/ar:DocTipo><ar:DocNro>0<\/ar:DocNro>/)
    expect(xml).toMatch(/<ar:Iva><ar:AlicIva><ar:Id>5<\/ar:Id>/)
  })

  it('NC B: CbtesAsoc apunta a la FB (tipo 6)', () => {
    const fj = fjBase({ cbte_tipo: 8, rec_doc_tipo: 96, rec_doc_nro: '30111222', rec_condicion_iva_id: 5 })
    fj.asociados = [{ asociada_id: 9, cbte_tipo: 6, pto_vta: 3, numero: 4, cuit: '33717191949', fecha_cbte: '2026-09-23' }]
    const c = armarComprobante(fj, 1)
    expect(c.cbtesAsoc).toEqual([{ tipo: 6, ptoVta: 3, nro: 4, cuit: '33717191949', cbteFch: '20260923' }])
  })

  it('reconciliación con consumidor final: DocNro 0 contra 0', () => {
    const f = { rec_doc_nro: '0', imp_total: 1210, cbte_tipo: 6, pto_vta: 3 }
    const c = { resultado: 'A', codAutorizacion: '12345678901234', cbteTipo: 6, ptoVta: 3, docNro: '0', impTotal: 1210 } as unknown as ComprobanteConsultado
    expect(coincideConsultado(f, c)).toBe(true)
  })
})

describe('p_res de confirmar_emision', () => {
  it('A: CAE y vencimiento en YYYY-MM-DD', () => {
    expect(pResDeCAE({
      resultado: 'A', numero: 7, cae: '86390123456789', caeVto: '20261004', fchProceso: null,
      observaciones: [], errores: [], eventos: [],
    })).toEqual({ resultado: 'A', numero: 7, cae: '86390123456789', cae_vto: '2026-10-04', observaciones: [], errores: [] })
  })

  it('R: errores y observaciones (el 10016 viene en Obs)', () => {
    const r = pResDeCAE({
      resultado: 'R', numero: 7, cae: null, caeVto: null, fchProceso: null,
      observaciones: [{ code: 10016, msg: 'fecha' }], errores: [], eventos: [],
    })
    expect(r).toEqual({ resultado: 'R', numero: 7, observaciones: [{ code: 10016, msg: 'fecha' }], errores: [] })
  })
})

function consultado(over: Partial<ComprobanteConsultado> = {}): ComprobanteConsultado {
  return {
    ptoVta: 3, cbteTipo: 1, numero: 7, concepto: 3, docTipo: 80, docNro: '20111111112', cbteFch: '20260924',
    impTotal: 1210, impTotConc: 0, impNeto: 1000, impOpEx: 0, impTrib: 0, impIva: 210, monId: 'PES', monCotiz: 1,
    condicionIvaReceptorId: 1, resultado: 'A', codAutorizacion: '86390123456789', emisionTipo: 'CAE',
    fchVto: '20261004', fchProceso: '20260924101010', iva: [], cbtesAsoc: [], observaciones: [],
    ...over,
  }
}

describe('reconciliación', () => {
  const f = fjBase().factura
  it('coincide con mismo documento y total', () => {
    expect(coincideConsultado(f, consultado())).toBe(true)
    expect(coincideConsultado(f, consultado({ docNro: '020111111112' }))).toBe(true)
  })
  it('no coincide si cambia el total, el documento, el tipo o no está aprobado', () => {
    expect(coincideConsultado(f, consultado({ impTotal: 1210.01 }))).toBe(false)
    expect(coincideConsultado(f, consultado({ docNro: '30111111118' }))).toBe(false)
    expect(coincideConsultado(f, consultado({ cbteTipo: 3 }))).toBe(false)
    expect(coincideConsultado(f, consultado({ resultado: 'R' }))).toBe(false)
    expect(coincideConsultado(f, consultado({ codAutorizacion: '' }))).toBe(false)
  })
  it('p_res desde FECompConsultar', () => {
    expect(pResDeConsultado(consultado())).toEqual({
      resultado: 'A', numero: 7, cae: '86390123456789', cae_vto: '2026-10-04', fecha_cbte: '2026-09-24', observaciones: [], errores: [],
    })
  })
})

describe('resumen', () => {
  it('agrupa por mes, centro de costo, producto y letra; la NC resta', () => {
    const r = resumir([
      { mes: '2026-09', centro_costo: 'ANIMAR', producto: 'AVANCE DE OBRA', letra: 'A', es_nc: false, imp_neto: 1000, imp_iva: 210, imp_total: 1210 },
      { mes: '2026-09', centro_costo: 'ANIMAR', producto: 'AVANCE DE OBRA', letra: 'A', es_nc: false, imp_neto: 500, imp_iva: 105, imp_total: 605 },
      { mes: '2026-09', centro_costo: 'ANIMAR', producto: 'AVANCE DE OBRA', letra: 'A', es_nc: true, imp_neto: 100, imp_iva: 21, imp_total: 121 },
      { mes: '2026-09', centro_costo: null, producto: 'TRANSPORTE', letra: 'A', es_nc: false, imp_neto: 10, imp_iva: 2.1, imp_total: 12.1 },
      { mes: '2026-08', centro_costo: 'ANIMAR', producto: 'AVANCE DE OBRA', letra: 'A', es_nc: true, imp_neto: 1, imp_iva: 0.21, imp_total: 1.21 },
    ])
    expect(r).toEqual([
      { mes: '2026-09', centro_costo: null, producto: 'TRANSPORTE', letra: 'A', cantidad: 1, neto: 10, iva: 2.1, total: 12.1 },
      { mes: '2026-09', centro_costo: 'ANIMAR', producto: 'AVANCE DE OBRA', letra: 'A', cantidad: 3, neto: 1400, iva: 294, total: 1694 },
      { mes: '2026-08', centro_costo: 'ANIMAR', producto: 'AVANCE DE OBRA', letra: 'A', cantidad: 1, neto: -1, iva: -0.21, total: -1.21 },
    ])
  })
})
