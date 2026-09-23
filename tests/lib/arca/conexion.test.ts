// Ticket de acceso (cache, reclamo, espera, TA perdido) y clasificación de las
// fallas de red en "no llegó" / "quizás llegó". El transporte HTTP está
// reemplazado por un fetch falso: nada de esto sale a la red.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import forge from 'node-forge'

import { obtenerTA, type TaStore, type TicketAcceso } from '../../../src/lib/arca/wsaa.js'
import { solicitarCAE, ultimoAutorizado } from '../../../src/lib/arca/wsfe.js'
import { postSoap, configurarTransporteHttp, FallaHttp } from '../../../src/lib/arca/soap.js'
import { arcaConfig, type ArcaConfig } from '../../../src/lib/arca/config.js'
import { ArcaError } from '../../../src/lib/arca/errores.js'

const fetchMock = vi.fn<(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>>()
configurarTransporteHttp(async (url, headers, body, signal) => {
  let r: Response
  try {
    r = await fetchMock(url, { method: 'POST', headers, body, signal })
  } catch (e) {
    throw new FallaHttp('conexion', e)
  }
  return { status: r.status, ok: r.ok, text: await r.text() }
})
const fx = (n: string) => readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')
const respuesta = (xml: string, status = 200) => new Response(xml, { status })
const errorDeRed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

let cfg: ArcaConfig
const espera = { entreLecturasMs: 5, maximaMs: 60 }
const vigente = (): TicketAcceso => ({ token: 'tok', sign: 'sig', expiraAt: new Date(Date.now() + 6 * 3600_000) })
let n = 0
const servicioNuevo = () => `srv${++n}` // el cache en memoria es por servicio

function storeFalso(inicial: TicketAcceso | null, gana = true) {
  let guardado = inicial
  const store = {
    leer: vi.fn(async () => guardado),
    reclamarRenovacion: vi.fn(async () => gana),
    guardar: vi.fn(async (_a: string, _s: string, ta: TicketAcceso) => { guardado = ta }),
    liberar: vi.fn(async () => {}),
    poner: (ta: TicketAcceso | null) => { guardado = ta },
  }
  return store as typeof store & TaStore
}

beforeAll(() => {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date('2026-01-01')
  cert.validity.notAfter = new Date('2028-01-01')
  cert.setSubject([{ name: 'commonName', value: 'test' }])
  cert.setIssuer([{ name: 'commonName', value: 'test' }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  vi.stubEnv('ARCA_AMBIENTE', 'homo')
  vi.stubEnv('ARCA_CERT_B64', Buffer.from(forge.pki.certificateToPem(cert)).toString('base64'))
  vi.stubEnv('ARCA_KEY_B64', Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)).toString('base64'))
  cfg = arcaConfig()
})

beforeEach(() => fetchMock.mockReset())

describe('obtenerTA', () => {
  it('TA vigente en la base → no llama a WSAA ni reclama', async () => {
    const store = storeFalso(vigente())
    const ta = await obtenerTA(servicioNuevo(), { store, config: cfg, espera })
    expect(ta.token).toBe('tok')
    expect(store.reclamarRenovacion).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('llamadas simultáneas comparten una sola promesa, y después sale de memoria', async () => {
    const store = storeFalso(vigente())
    const srv = servicioNuevo()
    await Promise.all([1, 2, 3].map(() => obtenerTA(srv, { store, config: cfg, espera })))
    await obtenerTA(srv, { store, config: cfg, espera })
    expect(store.leer).toHaveBeenCalledTimes(1)
  })

  it('TA a punto de vencer (< 5 min) cuenta como vencido', async () => {
    const store = storeFalso({ token: 't', sign: 's', expiraAt: new Date(Date.now() + 60_000) })
    fetchMock.mockResolvedValueOnce(respuesta(fx('loginCms.xml')))
    const ta = await obtenerTA(servicioNuevo(), { store, config: cfg, espera })
    expect(ta.token).toBe('TOKEN_REDACTADO')
  })

  it('gana el reclamo → pide a WSAA con el CMS firmado y guarda', async () => {
    const store = storeFalso(null)
    fetchMock.mockResolvedValueOnce(respuesta(fx('loginCms.xml')))
    const srv = servicioNuevo()
    const ta = await obtenerTA(srv, { store, config: cfg, espera })
    expect(ta).toMatchObject({ token: 'TOKEN_REDACTADO', sign: 'SIGN_REDACTADO' })
    expect(store.guardar).toHaveBeenCalledWith('homo', srv, ta)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://wsaahomo.afip.gov.ar/ws/services/LoginCms')
    expect(String((init as { body: string }).body)).toMatch(/<wsaa:loginCms><wsaa:in0>[A-Za-z0-9+/=]+<\/wsaa:in0>/)
  })

  it('pierde el reclamo → relee hasta que el otro lo guarda', async () => {
    const store = storeFalso(null, false)
    setTimeout(() => store.poner(vigente()), 15)
    const ta = await obtenerTA(servicioNuevo(), { store, config: cfg, espera })
    expect(ta.token).toBe('tok')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.leer.mock.calls.length).toBeGreaterThan(1)
  })

  it('pierde el reclamo y nunca aparece → ARCA_TA_EN_RENOVACION', async () => {
    const store = storeFalso(null, false)
    await expect(obtenerTA(servicioNuevo(), { store, config: cfg, espera }))
      .rejects.toMatchObject({ codigo: 'ARCA_TA_EN_RENOVACION', quizasLlego: false })
  })

  it('alreadyAuthenticated sin TA guardado → ARCA_TA_PERDIDO', async () => {
    const store = storeFalso(null)
    fetchMock.mockResolvedValueOnce(respuesta(fx('loginCms-alreadyAuthenticated.xml'), 500))
    await expect(obtenerTA(servicioNuevo(), { store, config: cfg, espera }))
      .rejects.toMatchObject({ codigo: 'ARCA_TA_PERDIDO', faultcode: 'coe.alreadyAuthenticated' })
    expect(store.guardar).not.toHaveBeenCalled()
  })

  it('alreadyAuthenticated pero otro lo guardó mientras tanto → usa ese', async () => {
    const store = storeFalso(null)
    fetchMock.mockImplementationOnce(async () => {
      store.poner(vigente())
      return respuesta(fx('loginCms-alreadyAuthenticated.xml'), 500)
    })
    const ta = await obtenerTA(servicioNuevo(), { store, config: cfg, espera })
    expect(ta.token).toBe('tok')
  })
})

describe('obtenerTA: reclamo y TA dentro del margen', () => {
  it('WSAA falla (no alreadyAuthenticated) → suelta el reclamo', async () => {
    const store = storeFalso(null)
    fetchMock.mockRejectedValueOnce(errorDeRed('ECONNREFUSED'))
    await expect(obtenerTA(servicioNuevo(), { store, config: cfg, espera })).rejects.toMatchObject({ codigo: 'ARCA_SIN_CONEXION' })
    expect(store.liberar).toHaveBeenCalledTimes(1)
  })

  it('alreadyAuthenticated NO suelta el reclamo (el lease frena el martilleo a WSAA)', async () => {
    const store = storeFalso(null)
    fetchMock.mockResolvedValueOnce(respuesta(fx('loginCms-alreadyAuthenticated.xml'), 500))
    await expect(obtenerTA(servicioNuevo(), { store, config: cfg, espera })).rejects.toMatchObject({ codigo: 'ARCA_TA_PERDIDO' })
    expect(store.liberar).not.toHaveBeenCalled()
  })

  it('alreadyAuthenticated con el TA guardado todavía válido (dentro del margen de 5 min) → usa ese', async () => {
    const casi = { token: 'casi', sign: 's', expiraAt: new Date(Date.now() + 3 * 60_000) }
    const store = storeFalso(casi)
    fetchMock.mockResolvedValueOnce(respuesta(fx('loginCms-alreadyAuthenticated.xml'), 500))
    const ta = await obtenerTA(servicioNuevo(), { store, config: cfg, espera })
    expect(ta.token).toBe('casi')
  })
})

describe('clasificación de fallas', () => {
  const llamar = (timeoutMs?: number) => postSoap({ url: 'https://x', soapAction: 'a', sobre: '<x/>', contexto: 'test', timeoutMs })

  it.each([
    ['ECONNREFUSED', 'ARCA_SIN_CONEXION', false],
    ['ENOTFOUND', 'ARCA_SIN_CONEXION', false],
    ['UND_ERR_CONNECT_TIMEOUT', 'ARCA_SIN_CONEXION', false],
    ['ERR_SSL_DH_KEY_TOO_SMALL', 'ARCA_SIN_CONEXION', false],
    ['ECONNRESET', 'ARCA_CONEXION_CORTADA', true],
    ['UND_ERR_SOCKET', 'ARCA_CONEXION_CORTADA', true],
  ])('%s → %s (quizasLlego=%s)', async (code, codigo, quizasLlego) => {
    fetchMock.mockRejectedValueOnce(errorDeRed(code))
    await expect(llamar()).rejects.toMatchObject({ tipo: 'transporte', codigo, quizasLlego })
  })

  it('timeout propio → tipo timeout, quizás llegó', async () => {
    fetchMock.mockImplementationOnce((_u, init) => new Promise((_r, rej) => {
      (init as { signal: AbortSignal }).signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    await expect(llamar(20)).rejects.toMatchObject({ tipo: 'timeout', codigo: 'ARCA_TIMEOUT', quizasLlego: true })
  })

  it('502 con HTML → quizás llegó; 404 → no llegó', async () => {
    fetchMock.mockResolvedValueOnce(respuesta('<html>bad gateway</html>', 502))
    await expect(llamar()).rejects.toMatchObject({ codigo: 'ARCA_HTTP_ERROR', quizasLlego: true, httpStatus: 502 })
    fetchMock.mockResolvedValueOnce(respuesta('not found', 404))
    await expect(llamar()).rejects.toMatchObject({ codigo: 'ARCA_HTTP_ERROR', quizasLlego: false })
  })

  it('500 con SOAP Fault no lo corta el transporte: lo interpreta quien llama', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(fx('loginCms-alreadyAuthenticated.xml'), 500))
    await expect(llamar()).resolves.toMatchObject({ status: 500 })
  })
})

describe('wsfe con fetch mockeado', () => {
  const ta = vigente()

  it('solicitarCAE manda SOAPAction y el CUIT de CADINC, y devuelve el CAE', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(fx('FECAESolicitar-A.xml')))
    const r = await solicitarCAE({
      ptoVta: 3, cbteTipo: 1, numero: 1, concepto: 3, docTipo: 80, docNro: '20111111112', cbteFch: '20260923',
      impNeto: 100, impIva: 21, impTotal: 121, impTotConc: 0, impOpEx: 0, impTrib: 0,
      fchServDesde: '20260923', fchServHasta: '20260923', fchVtoPago: '20260923', condicionIvaReceptorId: 1,
      iva: [{ id: 5, baseImp: 100, importe: 21 }],
    }, { ta, config: cfg })
    expect(r).toMatchObject({ resultado: 'A', cae: '86380923473688' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://wswhomo.afip.gov.ar/wsfev1/service.asmx')
    const i = init as { headers: Record<string, string>; body: string }
    expect(i.headers.SOAPAction).toBe('"http://ar.gov.afip.dif.FEV1/FECAESolicitar"')
    expect(i.body).toContain('<ar:Cuit>33717191949</ar:Cuit>')
  })

  it('un corte en FECAESolicitar se propaga con quizasLlego=true', async () => {
    fetchMock.mockRejectedValueOnce(errorDeRed('ECONNRESET'))
    const e = await solicitarCAE({
      ptoVta: 3, cbteTipo: 1, numero: 2, concepto: 1, docTipo: 80, docNro: '20111111112', cbteFch: '20260923',
      impNeto: 100, impIva: 21, impTotal: 121, impTotConc: 0, impOpEx: 0, impTrib: 0, condicionIvaReceptorId: 1,
      iva: [{ id: 5, baseImp: 100, importe: 21 }],
    }, { ta, config: cfg }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ArcaError)
    expect((e as ArcaError).quizasLlego).toBe(true)
  })

  it('ultimoAutorizado', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(fx('FECompUltimoAutorizado.xml')))
    await expect(ultimoAutorizado(3, 1, { ta, config: cfg })).resolves.toEqual({ ptoVta: 3, cbteTipo: 1, numero: 0 })
  })
})
