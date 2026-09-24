/**
 * Padrón de ARCA: los datos de un CUIT desde la constancia de inscripción
 * (fase 7 de Facturación, 2026-09-23).
 *
 * Servicio `ws_sr_constancia_inscripcion` (padrón "A5"), método
 * `getPersona_v2`. Datos del WSDL (bajado el 23/09/2026, homo y prod iguales
 * salvo el host):
 *   homo  https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5
 *   prod  https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5
 *   targetNamespace http://a5.soap.ws.server.puc.sr/
 *   `elementFormDefault="unqualified"`: solo el elemento raíz va con prefijo;
 *   token, sign, cuitRepresentada e idPersona van SIN namespace.
 *   soapAction vacío. Errores de validación → SOAP Fault (SRValidationException).
 *
 * Usa su propio ticket de WSAA (servicio `ws_sr_constancia_inscripcion`),
 * guardado en `arca_tokens` como el de WSFE. En `cuitRepresentada` va el CUIT
 * de CADINC, nunca el del certificado.
 *
 * Es SOLO LECTURA: no emite ni registra nada en ARCA.
 *
 * ── Cómo se deduce la condición de IVA ──────────────────────────────────────
 * ARCA no la devuelve como tal: hay que mirar los impuestos inscriptos
 * (`datosRegimenGeneral.impuesto`, estado `AC` = activo) y si tiene
 * `datosMonotributo`. Códigos de impuesto: 30 IVA, 32 IVA exento, 34 IVA no
 * alcanzado, 20 monotributo, 21 monotributo social (a veces viene como
 * categoría del 20 con "SOCIAL" en la descripción).
 *   - monotributo (datosMonotributo o impuesto 20 activo) → 6
 *     (13 si dice "social", 16 si dice "promovido": dudosa)
 *   - IVA (30) activo → 1
 *   - IVA exento (32) activo → 4
 *   - IVA no alcanzado (34) activo → 15 (dudosa)
 *   - nada de lo anterior → 5 consumidor final (dudosa: puede ser un sujeto
 *     no categorizado, o una sociedad con los impuestos dados de baja)
 * También es dudosa si tiene IVA y monotributo a la vez, o si la clave no
 * está ACTIVA. "Dudosa" = la UI la precarga pero pide revisarla.
 */
import { arcaConfig, type ArcaConfig } from './config.js'
import { ArcaError } from './errores.js'
import { cuerpoSoap, lista, nodo, postSoap, texto, xmlEsc, type XmlNodo } from './soap.js'
import { obtenerTA, type TicketAcceso } from './wsaa.js'

export const NS_PADRON = 'http://a5.soap.ws.server.puc.sr/'
export const SERVICIO_PADRON = 'ws_sr_constancia_inscripcion'

export const IMPUESTO_IVA = 30
export const IMPUESTO_IVA_EXENTO = 32
export const IMPUESTO_IVA_NO_ALCANZADO = 34
export const IMPUESTO_MONOTRIBUTO = 20
export const IMPUESTO_MONOTRIBUTO_SOCIAL = 21

export interface PadronDomicilio {
  direccion: string
  localidad: string
  cod_postal: string
  provincia: string
  id_provincia: number | null
}

export interface PadronImpuesto {
  id: number
  descripcion: string
  estado: string
  periodo: number | null
}

export interface PadronActividad {
  id: number
  descripcion: string
  orden: number | null
}

export interface PersonaPadron {
  cuit: string
  razon_social: string
  /** FISICA | JURIDICA */
  tipo_persona: string
  /** ACTIVO, INACTIVO, … */
  estado_clave: string
  domicilio_fiscal: PadronDomicilio | null
  /** Condición IVA sugerida (ids de FEParamGetCondicionIvaReceptor). */
  condicion_iva_id: number
  /** true = no alcanza con mirar el padrón: revisarla a mano. */
  condicion_iva_dudosa: boolean
  /** Por qué se sugirió esa condición, en castellano. */
  condicion_iva_motivo: string
  es_monotributo: boolean
  es_exento: boolean
  categoria_monotributo: string | null
  impuestos: PadronImpuesto[]
  actividades: PadronActividad[]
  /** Errores parciales de ARCA (errorRegimenGeneral / errorMonotributo) que no impidieron leer los datos. */
  avisos: string[]
}

export interface OpcionesPadron {
  config?: ArcaConfig
  /** Para scripts/tests; si no, `obtenerTA('ws_sr_constancia_inscripcion')`. */
  ta?: TicketAcceso
}

function cuitLimpio(cuit: string): string {
  const c = String(cuit ?? '').replace(/\D/g, '')
  if (!/^\d{11}$/.test(c)) {
    throw new ArcaError({ tipo: 'config', codigo: 'ARCA_PADRON_CUIT_INVALIDO', mensaje: 'El CUIT tiene que tener 11 dígitos' })
  }
  return c
}

/** El sobre de getPersona_v2. Exportado para tests. */
export function sobreGetPersona(ta: TicketAcceso, cuitRepresentada: string, cuit: string): string {
  const id = cuitLimpio(cuit)
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="${NS_PADRON}">` +
    '<soapenv:Header/><soapenv:Body>' +
    '<a5:getPersona_v2>' +
    `<token>${xmlEsc(ta.token)}</token><sign>${xmlEsc(ta.sign)}</sign>` +
    `<cuitRepresentada>${xmlEsc(cuitRepresentada.replace(/\D/g, ''))}</cuitRepresentada>` +
    `<idPersona>${id}</idPersona>` +
    '</a5:getPersona_v2>' +
    '</soapenv:Body></soapenv:Envelope>'
  )
}

const num = (v: unknown): number | null => {
  const t = texto(v)
  return t && Number.isFinite(Number(t)) ? Number(t) : null
}

function errores(n: XmlNodo | undefined): string[] {
  if (!n) return []
  const e = n.error
  const l = Array.isArray(e) ? e.map(texto) : [texto(e)]
  const msgs = l.map((s) => s.trim()).filter(Boolean)
  const m = texto(n.mensaje).trim()
  if (m && !msgs.includes(m)) msgs.push(m)
  return msgs
}

function impuestos(n: XmlNodo | undefined): PadronImpuesto[] {
  return lista(n?.impuesto).map((i) => ({
    id: num(i.idImpuesto) ?? 0,
    descripcion: texto(i.descripcionImpuesto),
    estado: texto(i.estadoImpuesto),
    periodo: num(i.periodo),
  }))
}

function actividades(n: XmlNodo | undefined): PadronActividad[] {
  return lista(n?.actividad).map((a) => ({
    id: num(a.idActividad) ?? 0,
    descripcion: texto(a.descripcionActividad),
    orden: num(a.orden),
  }))
}

/**
 * La condición de IVA que sugiere el padrón. Ver el encabezado. Pura, para
 * poder testearla sin XML.
 */
export function deducirCondicionIva(p: {
  impuestos: PadronImpuesto[]
  tieneMonotributo: boolean
  categoriaMonotributo?: string | null
  estadoClave?: string
}): { id: number; dudosa: boolean; motivo: string; es_monotributo: boolean; es_exento: boolean } {
  // Si ARCA no manda el estado se toma como activo (el padrón A5 no siempre lo trae).
  const activo = (i: PadronImpuesto) => !i.estado || i.estado.toUpperCase() === 'AC'
  const tiene = (id: number) => p.impuestos.some((i) => i.id === id && activo(i))
  const cat = (p.categoriaMonotributo ?? '').toUpperCase()
  const esMono = p.tieneMonotributo || tiene(IMPUESTO_MONOTRIBUTO) || tiene(IMPUESTO_MONOTRIBUTO_SOCIAL)
  const iva = tiene(IMPUESTO_IVA)
  const exento = tiene(IMPUESTO_IVA_EXENTO)
  const claveInactiva = !!p.estadoClave && p.estadoClave.toUpperCase() !== 'ACTIVO'
  const inactiva = claveInactiva ? ` La clave figura ${p.estadoClave} en ARCA.` : ''

  let r: { id: number; dudosa: boolean; motivo: string }
  if (esMono && iva) {
    r = { id: 1, dudosa: true, motivo: 'Figura inscripto en IVA y en el monotributo a la vez: revisar.' }
  } else if (esMono) {
    if (tiene(IMPUESTO_MONOTRIBUTO_SOCIAL) || cat.includes('SOCIAL')) {
      r = { id: 13, dudosa: true, motivo: 'Monotributo social según el padrón.' }
    } else if (cat.includes('PROMOVIDO')) {
      r = { id: 16, dudosa: true, motivo: 'Monotributo promovido según el padrón.' }
    } else {
      r = { id: 6, dudosa: false, motivo: 'Inscripto en el monotributo.' }
    }
  } else if (iva) {
    r = { id: 1, dudosa: false, motivo: 'Inscripto en IVA (impuesto 30).' }
  } else if (exento) {
    r = { id: 4, dudosa: false, motivo: 'IVA exento (impuesto 32).' }
  } else if (tiene(IMPUESTO_IVA_NO_ALCANZADO)) {
    r = { id: 15, dudosa: true, motivo: 'IVA no alcanzado (impuesto 34).' }
  } else {
    r = {
      id: 5, dudosa: true,
      motivo: 'No tiene IVA ni monotributo activos en el padrón: se sugiere consumidor final, pero puede ser un sujeto no categorizado.',
    }
  }
  return {
    ...r,
    dudosa: r.dudosa || claveInactiva,
    motivo: r.motivo + inactiva,
    es_monotributo: esMono,
    es_exento: !iva && !esMono && exento,
  }
}

/** Traduce el texto de un error del padrón a un código estable. */
function codigoDeError(msgs: string[]): string {
  const t = msgs.join(' ').toLowerCase()
  if (/no existe persona|inexistente|no existe/.test(t)) return 'ARCA_PADRON_CUIT_INEXISTENTE'
  if (/no alcanzad|no se encuentra alcanzad/.test(t)) return 'ARCA_PADRON_NO_ALCANZADO'
  if (/cancelad|inactiv|baja/.test(t)) return 'ARCA_PADRON_CLAVE_INACTIVA'
  return 'ARCA_PADRON_SIN_DATOS'
}

const MENSAJES: Record<string, string> = {
  ARCA_PADRON_CUIT_INEXISTENTE: 'ARCA no tiene a nadie con ese CUIT',
  ARCA_PADRON_NO_ALCANZADO: 'ARCA no da la constancia de inscripción de ese CUIT (no está alcanzado)',
  ARCA_PADRON_CLAVE_INACTIVA: 'El CUIT está cancelado, inactivo o dado de baja en ARCA',
  // Típico: "La CUIT registra una o más actividades económicas que no
  // pertenecen al nomenclador…" — ARCA no da la constancia hasta que el
  // contribuyente actualice sus actividades. Los datos hay que cargarlos a mano.
  ARCA_PADRON_SIN_DATOS: 'ARCA no da la constancia de inscripción de ese CUIT',
  ARCA_PADRON_SIN_AUTORIZACION: 'El certificado del ERP no está autorizado a consultar el padrón de ARCA (ws_sr_constancia_inscripcion)',
}

function errorPadron(codigo: string, detalle: string[], httpStatus?: number, cause?: unknown): ArcaError {
  const extra = detalle.length ? `: ${detalle.join(' | ')}` : ''
  return new ArcaError({
    tipo: 'rechazo', codigo, quizasLlego: false, httpStatus, cause,
    errores: detalle.map((msg) => ({ code: 0, msg })),
    mensaje: `${MENSAJES[codigo] ?? MENSAJES.ARCA_PADRON_SIN_DATOS}${extra}`,
  })
}

/** "TUCUMAN" → "Tucuman"; "CIUDAD AUTONOMA BUENOS AIRES" → "Ciudad Autonoma Buenos Aires". */
export function nombrePropio(s: string): string {
  const chicas = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e'])
  return espacios(s).toLowerCase()
    .replace(/(^|[\s(.-])(\p{L}+)/gu, (_, a: string, w: string) => a + (a && chicas.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
}

/** Colapsa espacios repetidos (ARCA manda "AV.  LEANDRO ALEM"). */
export function espacios(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * El domicilio en una línea, con el formato que ya usan los clientes cargados
 * a mano ("Av Fulvio S Pagani 487 - Arroyito"): dirección - localidad (CP).
 */
export function domicilioEnLinea(d: PadronDomicilio | null): string {
  if (!d) return ''
  const partes = [espacios(d.direccion), espacios(d.localidad)].filter(Boolean)
  const linea = partes.join(' - ')
  return espacios(d.cod_postal) ? `${linea} (CP ${espacios(d.cod_postal)})` : linea
}

export function parsearGetPersona(xml: string, cuit: string, httpStatus?: number): PersonaPadron {
  let body: XmlNodo
  try {
    body = cuerpoSoap(xml, 'Padrón getPersona_v2', httpStatus)
  } catch (e) {
    if (e instanceof ArcaError && e.tipo === 'soap_fault') {
      const msg = e.message.replace(/^.*?:\s*ARCA respondió un error \([^)]*\):\s*/, '')
      if (/no existe persona/i.test(msg)) throw errorPadron('ARCA_PADRON_CUIT_INEXISTENTE', [msg], httpStatus, e)
      if (/no autorizad|not authorized|cuit representada|representad/i.test(msg)) {
        throw errorPadron('ARCA_PADRON_SIN_AUTORIZACION', [msg], httpStatus, e)
      }
    }
    throw e
  }
  const r = nodo(nodo(body.getPersona_v2Response)?.personaReturn)
  if (!r) throw errorPadron('ARCA_PADRON_CUIT_INEXISTENTE', [], httpStatus)

  const gen = nodo(r.datosGenerales)
  const errConst = errores(nodo(r.errorConstancia))
  if (!gen) {
    // Sin datos generales: la constancia no se puede dar (no alcanzado, baja…).
    const quien = [texto(nodo(r.errorConstancia)?.apellido), texto(nodo(r.errorConstancia)?.nombre)].filter(Boolean).join(' ')
    throw errorPadron(codigoDeError(errConst), quien ? [...errConst, `(${quien})`] : errConst, httpStatus)
  }

  const rg = nodo(r.datosRegimenGeneral)
  const mono = nodo(r.datosMonotributo)
  const imps = [...impuestos(rg), ...impuestos(mono)]
  const categoria = nodo(mono?.categoriaMonotributo)
  const catDesc = categoria ? texto(categoria.descripcionCategoria) : null
  const estadoClave = texto(gen.estadoClave)
  const cond = deducirCondicionIva({ impuestos: imps, tieneMonotributo: !!mono, categoriaMonotributo: catDesc, estadoClave })

  const dom = nodo(gen.domicilioFiscal)
  const razon = texto(gen.razonSocial) || [texto(gen.apellido), texto(gen.nombre)].filter(Boolean).join(' ')
  const acts = [...actividades(rg), ...actividades(mono)]
  const principal = nodo(mono?.actividadMonotributista)
  if (principal) acts.unshift({ id: num(principal.idActividad) ?? 0, descripcion: texto(principal.descripcionActividad), orden: num(principal.orden) })

  return {
    cuit: texto(gen.idPersona) || cuitLimpio(cuit),
    razon_social: espacios(razon),
    tipo_persona: texto(gen.tipoPersona),
    estado_clave: estadoClave,
    domicilio_fiscal: dom
      ? {
          direccion: texto(dom.direccion),
          localidad: texto(dom.localidad),
          cod_postal: texto(dom.codPostal),
          provincia: texto(dom.descripcionProvincia),
          id_provincia: num(dom.idProvincia),
        }
      : null,
    condicion_iva_id: cond.id,
    condicion_iva_dudosa: cond.dudosa,
    condicion_iva_motivo: cond.motivo,
    es_monotributo: cond.es_monotributo,
    es_exento: cond.es_exento,
    categoria_monotributo: catDesc,
    impuestos: imps,
    // Las primeras 10 alcanzan para reconocer al cliente (ARCOR tiene 30).
    actividades: acts.sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99)).slice(0, 10),
    // errorRegimenGeneral / errorMonotributo son ruido cuando el otro régimen
    // vino (un RI siempre trae "no es monotributista"): solo si no vino ninguno.
    avisos: [...errConst, ...(rg || mono ? [] : [...errores(nodo(r.errorRegimenGeneral)), ...errores(nodo(r.errorMonotributo))])],
  }
}

/** Los datos de un CUIT según el padrón de ARCA. Una consulta, sin cache. */
export async function consultarPersona(cuit: string, opts: OpcionesPadron = {}): Promise<PersonaPadron> {
  const id = cuitLimpio(cuit)
  const cfg = opts.config ?? arcaConfig()
  const ta = opts.ta ?? (await obtenerTA(SERVICIO_PADRON, { config: cfg }))
  const { status, xml } = await postSoap({
    url: cfg.urls.padron,
    soapAction: '',
    sobre: sobreGetPersona(ta, cfg.cuit, id),
    contexto: 'Padrón getPersona_v2',
    timeoutMs: 20_000,
  })
  return parsearGetPersona(xml, id, status)
}
