/**
 * WSFECRED: Registro de Facturas de Crédito Electrónica MiPyMEs (2026-09-23).
 *
 * Por ahora una sola operación: `consultarMontoObligadoRecepcion`, que dice
 * si un CUIT está obligado a recibir FCE y desde qué monto. Es lo que decide
 * si a un cliente se le hace Factura A o Factura de Crédito MiPyME.
 *
 * Datos del WSDL (bajado el 23/09/2026):
 *   homo  https://fwshomo.afip.gov.ar/wsfecred/FECredService
 *   prod  https://serviciosjava.afip.gob.ar/wsfecred/FECredService
 *   targetNamespace http://ar.gob.afip.wsfecred/FECredService/
 *   Sin `elementFormDefault`: solo el elemento raíz del pedido va con
 *   namespace; los hijos (authRequest, cuitConsultada, …) van SIN prefijo.
 *   `fechaEmision` es xsd:date (yyyy-mm-dd), `obligado` es 'S' | 'N'.
 *
 * Usa su propio ticket de WSAA (servicio `wsfecred`), guardado en
 * `arca_tokens` como el de WSFE. En el Auth va el CUIT de CADINC
 * (`cuitRepresentada`), nunca el del certificado.
 */
import { arcaConfig, type ArcaConfig } from './config.js'
import { ArcaError, type ErrArca } from './errores.js'
import { cuerpoSoap, lista, nodo, postSoap, texto, xmlEsc, type XmlNodo } from './soap.js'
import { obtenerTA, type TicketAcceso } from './wsaa.js'

export const NS_WSFECRED = 'http://ar.gob.afip.wsfecred/FECredService/'
export const SERVICIO_WSFECRED = 'wsfecred'

export interface MontoObligadoRecepcion {
  /** true = el CUIT está obligado a recibir FCE; null = ARCA no lo dijo. */
  obligado: boolean | null
  /** Desde qué total la factura tiene que ser FCE (null si no vino). */
  montoDesde: number | null
  observaciones: ErrArca[]
}

export interface OpcionesWsfecred {
  config?: ArcaConfig
  /** Para scripts/tests; si no, `obtenerTA('wsfecred')`. */
  ta?: TicketAcceso
}

function fechaIso(s: string): string {
  const d = s.trim().slice(0, 10)
  const iso = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: 'fechaEmision: se espera yyyy-mm-dd' })
  }
  return iso
}

/** El sobre de consultarMontoObligadoRecepcion. Exportado para tests. */
export function sobreMontoObligado(ta: TicketAcceso, cuitRepresentada: string, cuitConsultada: string, fecha: string): string {
  const cuit = cuitConsultada.replace(/\D/g, '')
  if (!/^\d{11}$/.test(cuit)) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_COMPROBANTE_INVALIDO', mensaje: 'cuitConsultada: 11 dígitos' })
  }
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fec="${NS_WSFECRED}">` +
    '<soapenv:Header/><soapenv:Body>' +
    '<fec:consultarMontoObligadoRecepcionRequest>' +
    '<authRequest>' +
    `<token>${xmlEsc(ta.token)}</token><sign>${xmlEsc(ta.sign)}</sign>` +
    `<cuitRepresentada>${xmlEsc(cuitRepresentada.replace(/\D/g, ''))}</cuitRepresentada>` +
    '</authRequest>' +
    `<cuitConsultada>${cuit}</cuitConsultada>` +
    `<fechaEmision>${fechaIso(fecha)}</fechaEmision>` +
    '</fec:consultarMontoObligadoRecepcionRequest>' +
    '</soapenv:Body></soapenv:Envelope>'
  )
}

function codigos(n: XmlNodo | undefined, item: string): ErrArca[] {
  return lista(n?.[item]).map((c) => ({ code: Number(texto(c.codigo) || 0), msg: texto(c.descripcion) }))
}

export function parsearMontoObligado(xml: string, httpStatus?: number): MontoObligadoRecepcion {
  const body = cuerpoSoap(xml, 'WSFECRED consultarMontoObligadoRecepcion', httpStatus)
  const r = nodo(nodo(body.consultarMontoObligadoRecepcionResponse)?.consultarMontoObligadoRecepcionReturn)
  if (!r) {
    throw new ArcaError({
      tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: false, httpStatus,
      mensaje: 'WSFECRED consultarMontoObligadoRecepcion: la respuesta no trae consultarMontoObligadoRecepcionReturn',
    })
  }
  const errores = [
    ...codigos(nodo(r.arrayErrores), 'codigoDescripcion'),
    ...lista(nodo(r.arrayErroresFormato)?.codigoDescripcionString).map((c) => ({ code: 0, msg: `${texto(c.codigo)}: ${texto(c.descripcion)}` })),
  ]
  if (errores.length) {
    throw new ArcaError({
      tipo: 'rechazo', codigo: 'ARCA_ERROR', quizasLlego: false, errores,
      mensaje: `WSFECRED consultarMontoObligadoRecepcion: ${errores.map((e) => `${e.code} ${e.msg}`).join(' | ')}`,
    })
  }
  const ob = texto(r.obligado).toUpperCase()
  const monto = texto(r.montoDesde)
  return {
    obligado: ob === 'S' ? true : ob === 'N' ? false : null,
    montoDesde: monto && Number.isFinite(Number(monto)) ? Number(monto) : null,
    observaciones: codigos(nodo(r.arrayObservacion), 'codigoDescripcion'),
  }
}

/** ¿El CUIT está obligado a recibir FCE a esa fecha, y desde qué monto? Una consulta, sin cache. */
export async function consultarMontoObligadoRecepcion(
  cuit: string,
  fecha: string,
  opts: OpcionesWsfecred = {},
): Promise<MontoObligadoRecepcion> {
  const cfg = opts.config ?? arcaConfig()
  const ta = opts.ta ?? (await obtenerTA(SERVICIO_WSFECRED, { config: cfg }))
  const { status, xml } = await postSoap({
    url: cfg.urls.wsfecred,
    soapAction: `${NS_WSFECRED}consultarMontoObligadoRecepcion`,
    sobre: sobreMontoObligado(ta, cfg.cuit, cuit, fecha),
    contexto: 'WSFECRED consultarMontoObligadoRecepcion',
    timeoutMs: 20_000,
  })
  return parsearMontoObligado(xml, status)
}
