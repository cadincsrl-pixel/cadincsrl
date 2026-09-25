/**
 * Configuración de ARCA por variables de entorno (2026-09-23).
 *
 *   ARCA_AMBIENTE   homo | prod                     (obligatoria)
 *   ARCA_CUIT       CUIT de CADINC, va en el Auth de WSFE (default 33717191949)
 *   ARCA_PTO_VTA    punto de venta del ERP          (default 3)
 *   ARCA_CERT_B64 / ARCA_KEY_B64    PEM en base64 (Render), o bien
 *   ARCA_CERT_PATH / ARCA_KEY_PATH  ruta al PEM (local; acepta `~/`).
 *
 * El CUIT del Auth es SIEMPRE el de CADINC, no el del certificado: en
 * homologación el certificado está a nombre del representante (CUIT
 * 20359214570) y CADINC va como representada.
 *
 * Igual que `lib/mail.ts`: si falta algo NO explota al importar. Explota al
 * usarse, con `ARCA_NO_CONFIGURADO` y la lista de lo que falta — nunca con el
 * contenido del certificado ni de la clave.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { ArcaError } from './errores.js'

export type ArcaAmbiente = 'homo' | 'prod'

export interface ArcaUrls {
  wsaa: string
  wsfe: string
  /** WSFECRED (FCE MiPyME): consultarMontoObligadoRecepcion. URLs del WSDL (verificadas 2026-09-23). */
  wsfecred: string
  /** Padrón A5 (ws_sr_constancia_inscripcion): getPersona_v2. URLs del WSDL (verificadas 2026-09-23). */
  padron: string
}

export const ARCA_URLS: Record<ArcaAmbiente, ArcaUrls> = {
  homo: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
    wsfecred: 'https://fwshomo.afip.gov.ar/wsfecred/FECredService',
    padron: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
  },
  prod: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
    wsfecred: 'https://serviciosjava.afip.gob.ar/wsfecred/FECredService',
    padron: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
  },
}

export const ARCA_CUIT_DEFAULT = '33717191949'
export const ARCA_PTO_VTA_DEFAULT = 3

export interface ArcaConfig {
  ambiente: ArcaAmbiente
  /** CUIT de CADINC (11 dígitos, sin guiones). */
  cuit: string
  ptoVta: number
  urls: ArcaUrls
}

export interface ArcaCredenciales {
  certPem: string
  keyPem: string
}

type Env = Record<string, string | undefined>

function limpio(v: string | undefined): string {
  return (v ?? '').trim()
}

/** Lo que falta o está mal, para poder decirlo sin adivinar. Nunca incluye valores secretos. */
export function arcaLoQueFalta(env: Env = process.env): string[] {
  const falta: string[] = []
  const amb = limpio(env.ARCA_AMBIENTE)
  if (!amb) falta.push('ARCA_AMBIENTE')
  else if (amb !== 'homo' && amb !== 'prod') falta.push('ARCA_AMBIENTE (tiene que ser homo o prod)')

  const cuit = limpio(env.ARCA_CUIT) || ARCA_CUIT_DEFAULT
  if (!/^\d{11}$/.test(cuit)) falta.push('ARCA_CUIT (11 dígitos, sin guiones)')

  const pv = limpio(env.ARCA_PTO_VTA)
  if (pv && !(/^\d{1,5}$/.test(pv) && Number(pv) >= 1)) falta.push('ARCA_PTO_VTA (número de 1 a 99999)')

  if (!limpio(env.ARCA_CERT_B64) && !limpio(env.ARCA_CERT_PATH)) falta.push('ARCA_CERT_B64 o ARCA_CERT_PATH')
  if (!limpio(env.ARCA_KEY_B64) && !limpio(env.ARCA_KEY_PATH)) falta.push('ARCA_KEY_B64 o ARCA_KEY_PATH')
  return falta
}

export function arcaEstaConfigurado(env: Env = process.env): boolean {
  return arcaLoQueFalta(env).length === 0
}

function noConfigurado(detalle: string, cause?: unknown): ArcaError {
  return new ArcaError({
    tipo: 'config',
    codigo: 'ARCA_NO_CONFIGURADO',
    mensaje: `La conexión con ARCA no está configurada en el servidor: ${detalle}`,
    quizasLlego: false,
    cause,
  })
}

/** Ambiente, CUIT, punto de venta y URLs. Lanza ARCA_NO_CONFIGURADO si falta algo. */
export function arcaConfig(env: Env = process.env): ArcaConfig {
  const falta = arcaLoQueFalta(env)
  if (falta.length) throw noConfigurado(`falta ${falta.join(', ')}`)
  const ambiente = limpio(env.ARCA_AMBIENTE) as ArcaAmbiente
  return {
    ambiente,
    cuit: limpio(env.ARCA_CUIT) || ARCA_CUIT_DEFAULT,
    ptoVta: limpio(env.ARCA_PTO_VTA) ? Number(limpio(env.ARCA_PTO_VTA)) : ARCA_PTO_VTA_DEFAULT,
    urls: ARCA_URLS[ambiente],
  }
}

function expandirHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p
}

function leerPem(nombre: 'certificado' | 'clave', b64: string, path: string, marca: RegExp): string {
  let pem: string
  if (b64) {
    pem = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8')
  } else {
    try {
      pem = readFileSync(expandirHome(path), 'utf8')
    } catch (e) {
      // El mensaje del fs trae la ruta, no el contenido: se puede mostrar.
      throw noConfigurado(`no se pudo leer el ${nombre} (${e instanceof Error ? e.message : 'error de lectura'})`, e)
    }
  }
  if (!marca.test(pem)) throw noConfigurado(`el ${nombre} no tiene formato PEM`)
  return pem
}

/**
 * Certificado y clave privada en PEM. Solo los usa WSAA al renovar el token.
 * NUNCA loguear el resultado.
 */
export function arcaCredenciales(env: Env = process.env): ArcaCredenciales {
  const falta = arcaLoQueFalta(env)
  if (falta.length) throw noConfigurado(`falta ${falta.join(', ')}`)
  return {
    certPem: leerPem('certificado', limpio(env.ARCA_CERT_B64), limpio(env.ARCA_CERT_PATH), /-----BEGIN CERTIFICATE-----/),
    keyPem: leerPem('clave', limpio(env.ARCA_KEY_B64), limpio(env.ARCA_KEY_PATH), /-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/),
  }
}

/**
 * Solo el certificado (PEM), sin la clave: para leer su vencimiento
 * (`certificado.ts`). NUNCA devolverlo por la API ni loguearlo.
 */
export function arcaCertificadoPem(env: Env = process.env): string {
  const b64 = limpio(env.ARCA_CERT_B64)
  const path = limpio(env.ARCA_CERT_PATH)
  if (!b64 && !path) throw noConfigurado('falta ARCA_CERT_B64 o ARCA_CERT_PATH')
  return leerPem('certificado', b64, path, /-----BEGIN CERTIFICATE-----/)
}
