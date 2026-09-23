// Armado de lo que se le manda a ARCA: TRA, firma CMS, sobre de
// FECAESolicitar, y la config por variables de entorno.
import { describe, it, expect } from 'vitest'
import forge from 'node-forge'
import { armarTRA, firmarTRA, isoArgentina } from '../../../src/lib/arca/wsaa.js'
import { sobreFECAESolicitar, redactarAuth, fechaArca, type ComprobanteSolicitud } from '../../../src/lib/arca/wsfe.js'
import { arcaConfig, arcaLoQueFalta, arcaCredenciales } from '../../../src/lib/arca/config.js'
import { ArcaError } from '../../../src/lib/arca/errores.js'

describe('armarTRA', () => {
  const ahora = new Date('2026-09-23T21:00:00.000Z') // 18:00 en Argentina

  it('ventana de ±10 minutos en hora argentina, uniqueId y servicio', () => {
    const tra = armarTRA('wsfe', ahora, 1234)
    expect(tra).toContain('<uniqueId>1234</uniqueId>')
    expect(tra).toContain('<generationTime>2026-09-23T17:50:00-03:00</generationTime>')
    expect(tra).toContain('<expirationTime>2026-09-23T18:10:00-03:00</expirationTime>')
    expect(tra).toContain('<service>wsfe</service>')
    expect(tra.startsWith('<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0">')).toBe(true)
  })

  it('uniqueId por defecto = segundos epoch', () => {
    expect(armarTRA('wsfe', ahora)).toContain(`<uniqueId>${ahora.getTime() / 1000}</uniqueId>`)
  })

  it('isoArgentina cruza la medianoche UTC', () => {
    expect(isoArgentina(new Date('2026-09-24T01:30:00Z'))).toBe('2026-09-23T22:30:00-03:00')
  })
})

describe('firmarTRA', () => {
  // Certificado autofirmado de prueba (1024 bits para que el test sea rápido).
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date('2026-01-01')
  cert.validity.notAfter = new Date('2028-01-01')
  const attrs = [{ name: 'commonName', value: 'test' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const certPem = forge.pki.certificateToPem(cert)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)

  it('CMS SignedData attached, SHA-256, con el certificado adentro', () => {
    const tra = armarTRA('wsfe', new Date('2026-09-23T21:00:00Z'), 1)
    const b64 = firmarTRA(tra, certPem, keyPem)
    const der = forge.util.decode64(b64)
    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as forge.pkcs7.PkcsSignedData
    expect(msg.certificates).toHaveLength(1)
    // Attached: el TRA va literal adentro del DER.
    expect(der.includes(tra)).toBe(true)
    // El OID de SHA-256 aparece en el DER.
    expect(der.includes(forge.asn1.oidToDer(forge.pki.oids.sha256!).getBytes())).toBe(true)
  })

  it('PEM roto → ARCA_NO_CONFIGURADO sin filtrar el contenido', () => {
    try {
      firmarTRA('x', 'no-es-un-pem', 'secreto-que-no-debe-aparecer')
      throw new Error('no lanzó')
    } catch (e) {
      expect(e).toBeInstanceOf(ArcaError)
      expect((e as ArcaError).codigo).toBe('ARCA_NO_CONFIGURADO')
      expect((e as ArcaError).message).not.toContain('secreto-que-no-debe-aparecer')
    }
  })
})

describe('sobreFECAESolicitar', () => {
  const ta = { token: 'T<&>', sign: 'S', expiraAt: new Date('2030-01-01') }
  const base: ComprobanteSolicitud = {
    ptoVta: 3, cbteTipo: 3, numero: 7, concepto: 3, docTipo: 80, docNro: '30-50001091-2',
    cbteFch: '2026-09-23', impNeto: 100.005, impIva: 21, impTotal: 121, impTotConc: 0, impOpEx: 0, impTrib: 0,
    fchServDesde: '20260923', fchServHasta: '20260923', fchVtoPago: '20260923',
    condicionIvaReceptorId: 1,
    iva: [{ id: 5, baseImp: 100, importe: 21 }],
    cbtesAsoc: [{ tipo: 1, ptoVta: 3, nro: 1, cuit: '33717191949', cbteFch: '2026-09-20' }],
  }

  it('Auth con el CUIT de CADINC y el token escapado', () => {
    const s = sobreFECAESolicitar(ta, '33717191949', base)
    expect(s).toContain('<ar:Auth><ar:Token>T&lt;&amp;&gt;</ar:Token><ar:Sign>S</ar:Sign><ar:Cuit>33717191949</ar:Cuit></ar:Auth>')
  })

  it('respeta el orden del WSDL: …MonCotiz, CondicionIVAReceptorId, CbtesAsoc, Iva', () => {
    const s = sobreFECAESolicitar(ta, '33717191949', base)
    const orden = ['Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch', 'ImpTotal', 'ImpTotConc', 'ImpNeto',
      'ImpOpEx', 'ImpTrib', 'ImpIVA', 'FchServDesde', 'FchServHasta', 'FchVtoPago', 'MonId', 'MonCotiz',
      'CondicionIVAReceptorId', 'CbtesAsoc', 'Iva']
    const pos = orden.map((t) => s.indexOf(`<ar:${t}>`))
    expect(pos.every((p) => p > 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
  })

  it('normaliza fechas, documento e importes a 2 decimales', () => {
    const s = sobreFECAESolicitar(ta, '33717191949', base)
    expect(s).toContain('<ar:DocNro>30500010912</ar:DocNro>')
    expect(s).toContain('<ar:CbteFch>20260923</ar:CbteFch>')
    expect(s).toContain('<ar:ImpNeto>100.01</ar:ImpNeto>')
    expect(s).toContain('<ar:CbteAsoc><ar:Tipo>1</ar:Tipo><ar:PtoVta>3</ar:PtoVta><ar:Nro>1</ar:Nro><ar:Cuit>33717191949</ar:Cuit><ar:CbteFch>20260920</ar:CbteFch></ar:CbteAsoc>')
    expect(s).toContain('<ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>100.00</ar:BaseImp><ar:Importe>21.00</ar:Importe></ar:AlicIva>')
    expect(s).toContain('<ar:CbteDesde>7</ar:CbteDesde><ar:CbteHasta>7</ar:CbteHasta>')
    expect(s).toContain('<ar:CantReg>1</ar:CantReg>')
  })

  it('concepto 3 sin fechas de servicio → error antes de mandar', () => {
    const { fchServDesde: _a, ...sinFechas } = base
    expect(() => sobreFECAESolicitar(ta, '33717191949', sinFechas)).toThrow(/FchServDesde/)
  })

  it('redactarAuth tapa token y sign', () => {
    const s = redactarAuth(sobreFECAESolicitar(ta, '33717191949', base))
    expect(s).toContain('<ar:Token>***</ar:Token><ar:Sign>***</ar:Sign>')
  })

  it('fechaArca rechaza basura', () => {
    expect(fechaArca('2026-09-23', 'x')).toBe('20260923')
    expect(() => fechaArca('23/09/2026', 'x')).toThrow(ArcaError)
  })
})

describe('config', () => {
  it('sin nada → dice qué falta, sin valores', () => {
    expect(arcaLoQueFalta({})).toEqual(['ARCA_AMBIENTE', 'ARCA_CERT_B64 o ARCA_CERT_PATH', 'ARCA_KEY_B64 o ARCA_KEY_PATH'])
    try {
      arcaConfig({})
      throw new Error('no lanzó')
    } catch (e) {
      expect((e as ArcaError).codigo).toBe('ARCA_NO_CONFIGURADO')
      expect((e as ArcaError).tipo).toBe('config')
    }
  })

  it('defaults: CUIT de CADINC y PV 3; URLs por ambiente', () => {
    const c = arcaConfig({ ARCA_AMBIENTE: 'homo', ARCA_CERT_B64: 'x', ARCA_KEY_B64: 'y' })
    expect(c).toMatchObject({ ambiente: 'homo', cuit: '33717191949', ptoVta: 3 })
    expect(c.urls.wsfe).toBe('https://wswhomo.afip.gov.ar/wsfev1/service.asmx')
    const p = arcaConfig({ ARCA_AMBIENTE: 'prod', ARCA_PTO_VTA: '4', ARCA_CERT_PATH: '/a', ARCA_KEY_PATH: '/b' })
    expect(p.urls.wsaa).toBe('https://wsaa.afip.gov.ar/ws/services/LoginCms')
    expect(p.urls.wsfe).toBe('https://servicios1.afip.gov.ar/wsfev1/service.asmx')
    expect(p.ptoVta).toBe(4)
  })

  it('ambiente inválido o CUIT mal formado', () => {
    expect(arcaLoQueFalta({ ARCA_AMBIENTE: 'produccion', ARCA_CUIT: '33-71719194-9', ARCA_CERT_B64: 'x', ARCA_KEY_B64: 'y' }))
      .toEqual(['ARCA_AMBIENTE (tiene que ser homo o prod)', 'ARCA_CUIT (11 dígitos, sin guiones)'])
  })

  it('credenciales en base64 que no son PEM → error sin el contenido', () => {
    const env = { ARCA_AMBIENTE: 'homo', ARCA_CERT_B64: Buffer.from('secreto').toString('base64'), ARCA_KEY_B64: 'eQ==' }
    expect(() => arcaCredenciales(env)).toThrow(/no tiene formato PEM/)
    try { arcaCredenciales(env) } catch (e) { expect((e as Error).message).not.toContain('secreto') }
  })
})
