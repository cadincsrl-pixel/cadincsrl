// FCE MiPyME A (201) y su NC (203), fase 6 (2026-09-23): opcionales de WSFE,
// vencimiento de pago, qué tipo corresponde según WSFECRED, y el sobre /
// parseo de consultarMontoObligadoRecepcion.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  armarComprobante, opcionalesFce, correspondeFce, tipoPara, esFce, MONTO_MINIMO_FCE, type FJ,
} from '../../../src/modules/facturacion/reglas.js'
import { cacheVigente, hoyAr } from '../../../src/modules/facturacion/reglas.js'
import {
  sobreFECAESolicitar, sobreMontoObligado, parsearMontoObligado, parsearFECompConsultar, ArcaError,
} from '../../../src/lib/arca/index.js'

const TA = { token: 'tok', sign: 'sig', expiraAt: new Date() }
const fx = (n: string) => readFileSync(path.join(__dirname, '../../lib/arca/fixtures', n), 'utf8')

function fj201(over: Partial<FJ['factura']> = {}): FJ {
  return {
    factura: {
      id: 20, ambiente: 'homo', pto_vta: 3, cbte_tipo: 201, numero: null, numero_intentado: null, estado: 'emitiendo',
      concepto: 3, fecha_cbte: '2026-09-11', fch_vto_pago: '2026-09-11', cliente_id: 43,
      rec_doc_tipo: 80, rec_doc_nro: '30502793175', rec_condicion_iva_id: 1,
      producto: 'AVANCE DE OBRA', centro_costo: 'ARCOR', moneda: 'PES', cotizacion: 1,
      imp_neto: 5_000_000, imp_iva: 1_050_000, imp_trib: 0, imp_op_ex: 0, imp_tot_conc: 0, imp_total: 6_050_000,
      intento_at: null, updated_at: '2026-09-11T12:00:00Z', emitida_por: 'u', created_by: 'u',
      fce_cbu: '0070397820000000473657', fce_alias: 'CADINC.GALICIA', fce_transmision: 'SCA', fce_referencia: null,
      nc_anulacion: null,
      ...over,
    },
    renglones: [],
    alicuotas: [{ alicuota_id: 5, tasa: 0.21, base_imp: 5_000_000, importe: 1_050_000 }],
    asociados: [],
  }
}

describe('FCE 201: armado', () => {
  it('manda 2101 CBU, 2102 alias, 27 SCA y el vencimiento de pago que eligió el usuario', () => {
    const c = armarComprobante(fj201({ fch_vto_pago: '2026-10-11' }), 1)
    expect(c.cbteTipo).toBe(201)
    expect(c.fchServDesde).toBe('20260911')
    expect(c.fchVtoPago).toBe('20261011')
    expect(c.opcionales).toEqual([
      { id: '2101', valor: '0070397820000000473657' },
      { id: '2102', valor: 'CADINC.GALICIA' },
      { id: '27', valor: 'SCA' },
    ])
  })

  it('sin alias no manda 2102; con referencia comercial manda 23; ADC', () => {
    expect(opcionalesFce({ cbte_tipo: 201, fce_cbu: '285', fce_alias: null, fce_transmision: 'ADC', fce_referencia: '4500278113', nc_anulacion: null }))
      .toEqual([{ id: '2101', valor: '285' }, { id: '23', valor: '4500278113' }, { id: '27', valor: 'ADC' }])
  })

  it('el sobre pone Opcionales DESPUÉS de Iva (orden del WSDL)', () => {
    const xml = sobreFECAESolicitar(TA, '33717191949', armarComprobante(fj201(), 1))
    expect(xml).toMatch(/<\/ar:Iva><ar:Opcionales><ar:Opcional><ar:Id>2101<\/ar:Id><ar:Valor>0070397820000000473657<\/ar:Valor><\/ar:Opcional>/)
    expect(xml).toMatch(/<ar:Opcional><ar:Id>27<\/ar:Id><ar:Valor>SCA<\/ar:Valor><\/ar:Opcional><\/ar:Opcionales><\/ar:FECAEDetRequest>/)
    expect(xml).toContain('<ar:FchVtoPago>20260911</ar:FchVtoPago>')
    expect(xml).toContain('<ar:CbteTipo>201</ar:CbteTipo>')
  })

  it('una Factura A común no lleva Opcionales', () => {
    const c = armarComprobante(fj201({ cbte_tipo: 1, fce_cbu: null, fce_alias: null, fce_transmision: null }), 1)
    expect(c.opcionales).toBeUndefined()
    expect(sobreFECAESolicitar(TA, '33717191949', c)).not.toContain('Opcionales')
  })
})

describe('NC FCE 203: armado', () => {
  function fj203(anul: 'S' | 'N'): FJ {
    const fj = fj201({ cbte_tipo: 203, fce_cbu: null, fce_alias: null, fce_transmision: null, nc_anulacion: anul, fecha_cbte: '2026-09-23' })
    fj.asociados = [{ asociada_id: 20, cbte_tipo: 201, pto_vta: 3, numero: 1, cuit: '33717191949', fecha_cbte: '2026-09-11' }]
    return fj
  }

  it('sin CBU ni vencimiento de pago; opcional 22 y CbtesAsoc con Cuit y CbteFch', () => {
    const c = armarComprobante(fj203('N'), 2)
    expect(c.fchVtoPago).toBeUndefined()
    expect(c.fchServDesde).toBe('20260923')
    expect(c.opcionales).toEqual([{ id: '22', valor: 'N' }])
    expect(c.cbtesAsoc).toEqual([{ tipo: 201, ptoVta: 3, nro: 1, cuit: '33717191949', cbteFch: '20260911' }])
    const xml = sobreFECAESolicitar(TA, '33717191949', c)
    expect(xml).not.toContain('FchVtoPago')
    expect(xml).not.toContain('2101')
    expect(xml).toContain('<ar:Opcional><ar:Id>22</ar:Id><ar:Valor>N</ar:Valor></ar:Opcional>')
  })

  it('anulación total → 22 = S', () => {
    expect(armarComprobante(fj203('S'), 3).opcionales).toEqual([{ id: '22', valor: 'S' }])
  })
})

describe('qué tipo corresponde', () => {
  it('tipoPara con FCE', () => {
    expect(tipoPara('A', false, true)).toBe(201)
    expect(tipoPara('A', true, true)).toBe(203)
    expect(tipoPara('A', false)).toBe(1)
    expect(esFce(201)).toBe(true)
    expect(esFce(1)).toBe(false)
  })

  it('obligado y total ≥ su monto → FCE; debajo → A; no obligado → A; sin dato → null', () => {
    const info = { obligado: true, montoDesde: 5_549_862 }
    expect(correspondeFce(info, 5_549_862)).toBe(true)
    expect(correspondeFce(info, 5_549_861.99)).toBe(false)
    expect(correspondeFce({ obligado: false, montoDesde: null }, 99_000_000)).toBe(false)
    expect(correspondeFce({ obligado: null, montoDesde: null }, 99_000_000)).toBeNull()
    expect(correspondeFce(null, 99_000_000)).toBeNull()
    // Sin monto del receptor, el piso general.
    expect(correspondeFce({ obligado: true, montoDesde: null }, MONTO_MINIMO_FCE - 1)).toBe(false)
    // Mínimo vigente a la fecha (20260929e): se pasa como parámetro.
    expect(correspondeFce({ obligado: true, montoDesde: null }, 6_000_000, 6_500_000)).toBe(false)
    expect(correspondeFce({ obligado: true, montoDesde: null }, 6_500_000, 6_500_000)).toBe(true)
  })

  it('cache de 30 días y hoy en Argentina', () => {
    const ahora = Date.parse('2026-09-23T12:00:00Z')
    expect(cacheVigente('2026-09-01T12:00:00Z', ahora)).toBe(true)
    expect(cacheVigente('2026-08-20T12:00:00Z', ahora)).toBe(false)
    expect(cacheVigente(null, ahora)).toBe(false)
    expect(hoyAr(Date.parse('2026-09-24T02:00:00Z'))).toBe('2026-09-23')
  })
})

describe('WSFECRED consultarMontoObligadoRecepcion', () => {
  it('sobre: solo el raíz con namespace; authRequest con cuitRepresentada; fecha yyyy-mm-dd', () => {
    const xml = sobreMontoObligado(TA, '33717191949', '30-50279317-5', '20260923')
    expect(xml).toContain('<fec:consultarMontoObligadoRecepcionRequest><authRequest><token>tok</token><sign>sig</sign><cuitRepresentada>33717191949</cuitRepresentada></authRequest>')
    expect(xml).toContain('<cuitConsultada>30502793175</cuitConsultada><fechaEmision>2026-09-23</fechaEmision>')
    expect(xml).toContain('xmlns:fec="http://ar.gob.afip.wsfecred/FECredService/"')
  })

  it('obligado S con monto (sintético, forma del WSDL)', () => {
    const xml = '<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
      '<ns2:consultarMontoObligadoRecepcionResponse xmlns:ns2="http://ar.gob.afip.wsfecred/FECredService/">' +
      '<consultarMontoObligadoRecepcionReturn><obligado>S</obligado><montoDesde>5549862.00</montoDesde></consultarMontoObligadoRecepcionReturn>' +
      '</ns2:consultarMontoObligadoRecepcionResponse></S:Body></S:Envelope>'
    expect(parsearMontoObligado(xml)).toEqual({ obligado: true, montoDesde: 5549862, observaciones: [] })
  })

  it('no obligado con observación (sintético)', () => {
    const xml = '<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
      '<ns2:consultarMontoObligadoRecepcionResponse xmlns:ns2="http://ar.gob.afip.wsfecred/FECredService/">' +
      '<consultarMontoObligadoRecepcionReturn><obligado>N</obligado>' +
      '<arrayObservacion><codigoDescripcion><codigo>1</codigo><descripcion>No es gran empresa</descripcion></codigoDescripcion></arrayObservacion>' +
      '</consultarMontoObligadoRecepcionReturn></ns2:consultarMontoObligadoRecepcionResponse></S:Body></S:Envelope>'
    expect(parsearMontoObligado(xml)).toEqual({ obligado: false, montoDesde: null, observaciones: [{ code: 1, msg: 'No es gran empresa' }] })
  })

  it('arrayErrores → rechazo (sintético)', () => {
    const xml = '<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
      '<ns2:consultarMontoObligadoRecepcionResponse xmlns:ns2="http://ar.gob.afip.wsfecred/FECredService/">' +
      '<consultarMontoObligadoRecepcionReturn><arrayErrores><codigoDescripcion><codigo>1100</codigo><descripcion>CUIT inválida</descripcion></codigoDescripcion></arrayErrores>' +
      '</consultarMontoObligadoRecepcionReturn></ns2:consultarMontoObligadoRecepcionResponse></S:Body></S:Envelope>'
    expect(() => parsearMontoObligado(xml)).toThrow(ArcaError)
  })

  it('fault REAL de homologación (23/09/2026): la CUIT de CADINC no está en la base de prueba de WSFECRED', () => {
    let err: unknown
    try { parsearMontoObligado(fx('consultarMontoObligadoRecepcion-fault-homo.xml'), 500) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ArcaError)
    expect((err as ArcaError).tipo).toBe('soap_fault')
    expect((err as ArcaError).message).toContain('common_business_014')
  })
})

describe('FECompConsultar con Opcionales', () => {
  it('lee los opcionales del comprobante', () => {
    const xml = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      '<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet>' +
      '<Concepto>3</Concepto><DocTipo>80</DocTipo><DocNro>30502793175</DocNro><CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta>' +
      '<CbteFch>20260911</CbteFch><ImpTotal>6050000</ImpTotal><CbteTipo>201</CbteTipo><PtoVta>3</PtoVta>' +
      '<Opcionales><Opcional><Id>2101</Id><Valor>0070397820000000473657</Valor></Opcional></Opcionales>' +
      '<Resultado>A</Resultado><CodAutorizacion>12345678901234</CodAutorizacion></ResultGet></FECompConsultarResult></FECompConsultarResponse>' +
      '</soap:Body></soap:Envelope>'
    expect(parsearFECompConsultar(xml)?.opcionales).toEqual([{ id: '2101', valor: '0070397820000000473657' }])
  })
})
