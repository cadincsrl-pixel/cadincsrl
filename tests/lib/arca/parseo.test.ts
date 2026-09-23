// Parseo de respuestas de ARCA. Los fixtures son respuestas REALES de
// homologación del 2026-09-23 (scripts/arca-humo.ts --fixtures); el de
// loginCms tiene token y sign redactados. Los casos marcados "sintético"
// siguen el formato documentado de ARCA pero no salieron de una llamada real.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parsearLoginCms } from '../../../src/lib/arca/wsaa.js'
import {
  parsearFECAESolicitar, parsearUltimoAutorizado, parsearFECompConsultar,
  parsearCondicionIvaReceptor, parsearTiposIva, parsearFEDummy,
} from '../../../src/lib/arca/wsfe.js'
import { ArcaError } from '../../../src/lib/arca/errores.js'

const fx = (n: string) => readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')

const envolver = (cuerpo: string) =>
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
  `<soap:Body>${cuerpo}</soap:Body></soap:Envelope>`

function capturar(fn: () => unknown): ArcaError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ArcaError) return e
    throw e
  }
  throw new Error('no lanzó')
}

describe('parsearLoginCms', () => {
  it('desescapa loginCmsReturn y saca token, sign y vencimiento', () => {
    const ta = parsearLoginCms(fx('loginCms.xml'))
    expect(ta.token).toBe('TOKEN_REDACTADO')
    expect(ta.sign).toBe('SIGN_REDACTADO')
    expect(ta.expiraAt.toISOString()).toBe('2026-09-24T09:22:14.181Z')
  })

  it('alreadyAuthenticated → soap_fault con el faultcode sin prefijo', () => {
    const xml = fx('loginCms-alreadyAuthenticated.xml')
    const e = capturar(() => parsearLoginCms(xml, 500))
    expect(e.tipo).toBe('soap_fault')
    expect(e.faultcode).toBe('coe.alreadyAuthenticated')
    expect(e.quizasLlego).toBe(false)
    expect(e.httpStatus).toBe(500)
  })

  it('sin credenciales → respuesta ilegible', () => {
    const xml = envolver('<loginCmsResponse><loginCmsReturn>&lt;loginTicketResponse/&gt;</loginCmsReturn></loginCmsResponse>')
    expect(capturar(() => parsearLoginCms(xml)).codigo).toBe('ARCA_RESPUESTA_ILEGIBLE')
  })
})

describe('parsearFECAESolicitar', () => {
  it('aprobado: número, CAE de 14 dígitos como string y observaciones', () => {
    const r = parsearFECAESolicitar(fx('FECAESolicitar-A.xml'))
    expect(r).toMatchObject({
      resultado: 'A', numero: 1, cae: '86380923473688', caeVto: '20261003', fchProceso: '20260923184202',
      errores: [], eventos: [],
    })
    expect(r.observaciones).toHaveLength(1)
    expect(r.observaciones[0]!.code).toBe(10217)
  })

  it('rechazado: resultado R sin CAE, el motivo viene en observaciones', () => {
    const r = parsearFECAESolicitar(fx('FECAESolicitar-R.xml'))
    expect(r).toMatchObject({ resultado: 'R', numero: 5, cae: null, caeVto: null, errores: [] })
    expect(r.observaciones.map((o) => o.code)).toEqual([10016])
  })

  it('rechazo de cabecera con Errors y sin detalle (sintético) → R con errores', () => {
    const xml = envolver(
      '<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult>' +
      '<Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No validaron las fechas del token GenTime, ExpTime, NowUTC</Msg></Err></Errors>' +
      '</FECAESolicitarResult></FECAESolicitarResponse>')
    const r = parsearFECAESolicitar(xml)
    expect(r.resultado).toBe('R')
    expect(r.errores).toEqual([{ code: 600, msg: expect.stringContaining('ValidacionDeToken') }])
  })

  it('dice A pero sin CAE → incierto (quizasLlego)', () => {
    const xml = fx('FECAESolicitar-A.xml').replace('<CAE>86380923473688</CAE>', '<CAE />')
    const e = capturar(() => parsearFECAESolicitar(xml))
    expect(e.codigo).toBe('ARCA_RESPUESTA_ILEGIBLE')
    expect(e.quizasLlego).toBe(true)
  })

  it('HTML de un balanceador → ilegible y quizás llegó', () => {
    const e = capturar(() => parsearFECAESolicitar('<html><body>Bad gateway</body></html>', 502))
    expect(e.tipo).toBe('transporte')
    expect(e.quizasLlego).toBe(true)
  })
})

describe('parsearUltimoAutorizado', () => {
  it('lee el último número del talonario', () => {
    expect(parsearUltimoAutorizado(fx('FECompUltimoAutorizado.xml'))).toEqual({ ptoVta: 3, cbteTipo: 1, numero: 0 })
  })

  it('con Errors (sintético) → rechazo', () => {
    const xml = envolver(
      '<FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><PtoVta>0</PtoVta><CbteTipo>0</CbteTipo><CbteNro>0</CbteNro>' +
      '<Errors><Err><Code>11002</Code><Msg>El punto de venta no se encuentra habilitado</Msg></Err></Errors>' +
      '</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>')
    const e = capturar(() => parsearUltimoAutorizado(xml))
    expect(e.tipo).toBe('rechazo')
    expect(e.errores[0]!.code).toBe(11002)
  })
})

describe('parsearFECompConsultar', () => {
  it('trae el comprobante emitido con su CAE e IVA', () => {
    const c = parsearFECompConsultar(fx('FECompConsultar.xml'))
    expect(c).toMatchObject({
      ptoVta: 3, cbteTipo: 1, numero: 1, concepto: 3, docTipo: 80, docNro: '20111111112',
      impTotal: 121, impNeto: 100, impIva: 21, resultado: 'A',
      codAutorizacion: '86380923473688', emisionTipo: 'CAE', fchVto: '20261003', condicionIvaReceptorId: 1,
    })
    expect(c!.iva).toEqual([{ id: 5, baseImp: 100, importe: 21 }])
  })

  it('602 "no existe" (sintético) → null, para reconciliar', () => {
    const xml = envolver(
      '<FECompConsultarResponse><FECompConsultarResult><Errors><Err><Code>602</Code>' +
      '<Msg>No existen datos en nuestros registros para los parametros ingresados.</Msg></Err></Errors>' +
      '</FECompConsultarResult></FECompConsultarResponse>')
    expect(parsearFECompConsultar(xml)).toBeNull()
  })
})

describe('parámetros', () => {
  it('condiciones IVA del receptor para clase A', () => {
    expect(parsearCondicionIvaReceptor(fx('FEParamGetCondicionIvaReceptor-A.xml')).map((c) => c.id)).toEqual([1, 6, 13, 16])
  })

  it('tipos de IVA', () => {
    const t = parsearTiposIva(fx('FEParamGetTiposIva.xml'))
    expect(t.find((x) => x.id === 5)?.descripcion).toBe('21%')
    expect(t.map((x) => x.id)).toEqual([3, 4, 5, 6, 8, 9])
  })

  it('FEDummy', () => {
    expect(parsearFEDummy(fx('FEDummy.xml'))).toEqual({ appServer: 'OK', dbServer: 'OK', authServer: 'OK' })
  })
})
