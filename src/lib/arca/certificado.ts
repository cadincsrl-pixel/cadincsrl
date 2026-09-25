/**
 * Vencimiento del certificado de ARCA (tanda 6, ítem 3).
 *
 * Lee el X.509 de ARCA_CERT_B64 / ARCA_CERT_PATH con `node:crypto` y devuelve
 * SOLO datos públicos: cuándo vence, cuántos días faltan, el CN y el CUIT del
 * sujeto. Nunca el PEM ni la clave.
 *
 * En homologación el certificado está a nombre del representante: su CUIT no
 * es el de CADINC (ARCA_CUIT) y eso es normal (ver config.ts).
 */
import { X509Certificate } from 'node:crypto'
import { arcaCertificadoPem } from './config.js'

export interface InfoCertificado {
  /** ISO 8601 (UTC). */
  vence_el: string
  /** Días enteros que faltan (negativo si ya venció). */
  dias_restantes: number
  vencido: boolean
  sujeto_cn: string | null
  /** 11 dígitos, del `serialNumber` del sujeto («CUIT 20359214570»). */
  cuit_certificado: string | null
}

const DIA_MS = 86_400_000

/** Un campo del DN (`CN=…`), en el formato multilínea de Node. */
function campoDn(dn: string, clave: string): string | null {
  for (const linea of dn.split(/\r?\n/)) {
    const i = linea.indexOf('=')
    if (i > 0 && linea.slice(0, i).trim().toLowerCase() === clave.toLowerCase()) return linea.slice(i + 1).trim() || null
  }
  return null
}

/** Pura: datos públicos de un certificado PEM. Lanza si el PEM no es legible. */
export function infoCertificado(pem: string, ahora: Date = new Date()): InfoCertificado {
  const x = new X509Certificate(pem)
  const vence = new Date(x.validTo)
  if (Number.isNaN(vence.getTime())) throw new Error('el certificado no trae una fecha de vencimiento legible')
  const ms = vence.getTime() - ahora.getTime()
  const serial = campoDn(x.subject, 'serialNumber')
  const cuit = serial?.replace(/\D/g, '') ?? ''
  return {
    vence_el: vence.toISOString(),
    dias_restantes: Math.floor(ms / DIA_MS),
    vencido: ms <= 0,
    sujeto_cn: campoDn(x.subject, 'CN'),
    cuit_certificado: /^\d{11}$/.test(cuit) ? cuit : null,
  }
}

type Env = Record<string, string | undefined>

// Cache del PEM parseado: el vencimiento se recalcula contra `ahora` en cada
// llamada; solo se evita releer y parsear el certificado.
let cache: { fuente: string; vence: Date; cn: string | null; cuit: string | null } | null = null

/**
 * El certificado del proceso. `null` + `error` si no está configurado o no se
 * pudo leer: el diagnóstico lo muestra, nunca rompe.
 */
export function certificadoDelProceso(env: Env = process.env, ahora: Date = new Date()): {
  certificado: InfoCertificado | null
  error: string | null
} {
  const fuente = `${(env.ARCA_CERT_B64 ?? '').trim()}|${(env.ARCA_CERT_PATH ?? '').trim()}`
  if (fuente === '|') return { certificado: null, error: 'no configurado' }
  try {
    if (!cache || cache.fuente !== fuente) {
      const info = infoCertificado(arcaCertificadoPem(env), ahora)
      cache = { fuente, vence: new Date(info.vence_el), cn: info.sujeto_cn, cuit: info.cuit_certificado }
    }
    const ms = cache.vence.getTime() - ahora.getTime()
    return {
      certificado: {
        vence_el: cache.vence.toISOString(),
        dias_restantes: Math.floor(ms / DIA_MS),
        vencido: ms <= 0,
        sujeto_cn: cache.cn,
        cuit_certificado: cache.cuit,
      },
      error: null,
    }
  } catch {
    // El mensaje puede traer la ruta: no se expone, alcanza con saber que falló.
    return { certificado: null, error: 'no se pudo leer' }
  }
}

/** Para los tests. */
export function olvidarCertificado(): void {
  cache = null
}
