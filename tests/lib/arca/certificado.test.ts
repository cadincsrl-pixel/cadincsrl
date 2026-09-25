// Vencimiento del certificado de ARCA (tanda 6, ítem 3). El fixture es un
// certificado autofirmado DE PRUEBA (sin la clave), generado con openssl el
// 2026-09-25: vence el 30/10/2027 10:51:50 UTC.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { infoCertificado, certificadoDelProceso, olvidarCertificado } from '../../../src/lib/arca/certificado.js'

const PEM = readFileSync(path.join(__dirname, 'fixtures', 'certificado-prueba.pem'), 'utf8')
const B64 = Buffer.from(PEM).toString('base64')

beforeEach(() => olvidarCertificado())

describe('infoCertificado', () => {
  it('vencimiento, días restantes, CN y CUIT del serialNumber', () => {
    const i = infoCertificado(PEM, new Date('2027-10-01T10:51:50Z'))
    expect(i.vence_el).toBe('2027-10-30T10:51:50.000Z')
    expect(i.dias_restantes).toBe(29)
    expect(i.vencido).toBe(false)
    expect(i.sujeto_cn).toBe('cadinc-test')
    expect(i.cuit_certificado).toBe('20359214570')
  })

  it('vencido', () => {
    const i = infoCertificado(PEM, new Date('2027-11-01T00:00:00Z'))
    expect(i.vencido).toBe(true)
    expect(i.dias_restantes).toBeLessThan(0)
  })

  it('no devuelve nada del PEM', () => {
    const txt = JSON.stringify(infoCertificado(PEM))
    expect(txt).not.toContain('BEGIN')
    expect(txt).not.toContain(PEM.split('\n')[1]!.slice(0, 20))
  })
})

describe('certificadoDelProceso', () => {
  it('lee ARCA_CERT_B64', () => {
    const r = certificadoDelProceso({ ARCA_CERT_B64: B64 }, new Date('2027-10-29T10:51:50Z'))
    expect(r.error).toBeNull()
    expect(r.certificado?.dias_restantes).toBe(1)
  })

  it('sin certificado: null + «no configurado», no lanza', () => {
    expect(certificadoDelProceso({})).toEqual({ certificado: null, error: 'no configurado' })
  })

  it('certificado ilegible: «no se pudo leer», sin la ruta ni el contenido', () => {
    const r = certificadoDelProceso({ ARCA_CERT_PATH: '/no/existe/cert.pem' })
    expect(r).toEqual({ certificado: null, error: 'no se pudo leer' })
    const basura = certificadoDelProceso({ ARCA_CERT_B64: Buffer.from('-----BEGIN CERTIFICATE-----\nxxx\n-----END CERTIFICATE-----').toString('base64') })
    expect(basura.error).toBe('no se pudo leer')
  })
})
