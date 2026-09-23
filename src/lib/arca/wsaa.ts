/**
 * WSAA: el Ticket de Acceso (TA) que pide cada servicio de ARCA (2026-09-23).
 *
 * El TA dura 12 horas y ARCA NO da otro mientras el anterior siga vigente
 * (`coe.alreadyAuthenticated`). Como Render reinicia el proceso y puede haber
 * más de una instancia, el TA vive en la base (`arca_tokens`) y la renovación
 * se reclama con un UPDATE atómico (`arca_reclamar_renovacion`): solo uno por
 * ambiente+servicio pide TA nuevo; el resto espera a que aparezca guardado.
 *
 * Dentro del proceso hay además un cache en memoria y una sola promesa en
 * vuelo por servicio, para que N requests simultáneos no hagan N lecturas.
 *
 * El token y el sign son credenciales: NUNCA loguearlos ni devolverlos en un
 * error.
 */
import forge from 'node-forge'
import type { SupabaseClient } from '@supabase/supabase-js'
import { arcaConfig, arcaCredenciales, type ArcaAmbiente, type ArcaConfig } from './config.js'
import { ArcaError } from './errores.js'
import { cuerpoSoap, nodo, parsearXml, postSoap, texto, xmlEsc } from './soap.js'

export interface TicketAcceso {
  token: string
  sign: string
  expiraAt: Date
}

/**
 * Persistencia del TA, inyectable. En el servidor es Supabase; el script de
 * humo usa un archivo.
 */
export interface TaStore {
  /** El TA guardado, vigente o no. null si no hay. */
  leer(ambiente: ArcaAmbiente, servicio: string): Promise<TicketAcceso | null>
  /** true si este proceso ganó el derecho a pedir TA nuevo a WSAA. */
  reclamarRenovacion(ambiente: ArcaAmbiente, servicio: string): Promise<boolean>
  /** Guarda el TA nuevo y libera el reclamo. */
  guardar(ambiente: ArcaAmbiente, servicio: string, ta: TicketAcceso): Promise<void>
}

/** Un TA que vence en menos de esto ya se considera vencido. */
export const MARGEN_VENCIMIENTO_MS = 5 * 60_000
const ESPERA_ENTRE_LECTURAS_MS = 2_000
const ESPERA_MAXIMA_MS = 30_000

export function taVigente(ta: TicketAcceso | null | undefined, ahora = Date.now()): ta is TicketAcceso {
  return !!ta && !!ta.token && !!ta.sign && ta.expiraAt.getTime() - ahora > MARGEN_VENCIMIENTO_MS
}

// ─── TRA ─────────────────────────────────────────────────────────────────────

/** ISO 8601 en hora argentina (UTC−3, sin horario de verano). */
export function isoArgentina(d: Date): string {
  const corrida = new Date(d.getTime() - 3 * 3600_000)
  return corrida.toISOString().slice(0, 19) + '-03:00'
}

/**
 * El Ticket de Requerimiento de Acceso. Ventana de ±10 minutos alrededor de
 * ahora para tolerar relojes corridos (el TA dura 12 h igual).
 */
export function armarTRA(servicio: string, ahora: Date = new Date(), uniqueId?: number): string {
  const id = uniqueId ?? Math.floor(ahora.getTime() / 1000)
  const desde = new Date(ahora.getTime() - 10 * 60_000)
  const hasta = new Date(ahora.getTime() + 10 * 60_000)
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0">' +
    '<header>' +
    `<uniqueId>${id}</uniqueId>` +
    `<generationTime>${isoArgentina(desde)}</generationTime>` +
    `<expirationTime>${isoArgentina(hasta)}</expirationTime>` +
    '</header>' +
    `<service>${xmlEsc(servicio)}</service>` +
    '</loginTicketRequest>'
  )
}

/**
 * Firma el TRA como CMS/PKCS#7 SignedData con el contenido adentro
 * (attached), SHA-256 y el certificado incluido. Devuelve el DER en base64,
 * que es lo que va en `in0` de loginCms.
 */
export function firmarTRA(tra: string, certPem: string, keyPem: string): string {
  let cert: forge.pki.Certificate
  let key: forge.pki.PrivateKey
  try {
    cert = forge.pki.certificateFromPem(certPem)
    key = forge.pki.privateKeyFromPem(keyPem)
  } catch (e) {
    // El mensaje de forge no incluye el contenido del PEM.
    throw new ArcaError({
      tipo: 'config', codigo: 'ARCA_NO_CONFIGURADO', cause: e,
      mensaje: 'No se pudo leer el certificado o la clave de ARCA (¿PEM RSA válido y sin contraseña?)',
    })
  }
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(tra, 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime! },
    ],
  })
  p7.sign()
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes()
  return forge.util.encode64(der)
}

// ─── loginCms ────────────────────────────────────────────────────────────────

const NS_WSAA = 'http://wsaa.view.sua.dvadac.desein.afip.gov'

export function sobreLoginCms(cmsB64: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="${NS_WSAA}">` +
    '<soapenv:Header/>' +
    `<soapenv:Body><wsaa:loginCms><wsaa:in0>${cmsB64}</wsaa:in0></wsaa:loginCms></soapenv:Body>` +
    '</soapenv:Envelope>'
  )
}

/**
 * Lee la respuesta de loginCms. `loginCmsReturn` trae OTRO XML adentro,
 * escapado como texto (`&lt;loginTicketResponse…`): el parser lo desescapa y
 * se parsea de nuevo.
 */
export function parsearLoginCms(xml: string, httpStatus?: number): TicketAcceso {
  const body = cuerpoSoap(xml, 'WSAA loginCms', httpStatus)
  const interno = texto(nodo(body.loginCmsResponse)?.loginCmsReturn)
  const ticket = interno ? nodo(parsearXml(interno).loginTicketResponse) : undefined
  const token = texto(nodo(ticket?.credentials)?.token)
  const sign = texto(nodo(ticket?.credentials)?.sign)
  const expira = new Date(texto(nodo(ticket?.header)?.expirationTime))
  if (!token || !sign || Number.isNaN(expira.getTime())) {
    throw new ArcaError({
      tipo: 'transporte', codigo: 'ARCA_RESPUESTA_ILEGIBLE', quizasLlego: true, httpStatus,
      mensaje: 'WSAA loginCms: la respuesta no trae token, sign o vencimiento',
    })
  }
  return { token, sign, expiraAt: expira }
}

/** Pide un TA nuevo a WSAA. No mira ni escribe el store: eso es `obtenerTA`. */
export async function loginCms(servicio: string, cfg: ArcaConfig = arcaConfig()): Promise<TicketAcceso> {
  const { certPem, keyPem } = arcaCredenciales()
  const cms = firmarTRA(armarTRA(servicio), certPem, keyPem)
  const { status, xml } = await postSoap({
    url: cfg.urls.wsaa,
    soapAction: '',
    sobre: sobreLoginCms(cms),
    contexto: 'WSAA loginCms',
  })
  return parsearLoginCms(xml, status)
}

// ─── Stores ──────────────────────────────────────────────────────────────────

/**
 * TA en `arca_tokens (ambiente, servicio, token, sign, expira_at,
 * renovando_hasta)` + RPC `arca_reclamar_renovacion(p_ambiente, p_servicio)`.
 * La tabla no tiene grants para anon/authenticated: va con el cliente
 * service_role.
 */
export function crearTaStoreSupabase(db: SupabaseClient): TaStore {
  const falla = (que: string, e: unknown) => new ArcaError({
    tipo: 'transporte', codigo: 'ARCA_TA_STORE', quizasLlego: false, cause: e,
    mensaje: `No se pudo ${que} el ticket de ARCA en la base: ${e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : 'error desconocido'}`,
  })
  return {
    async leer(ambiente, servicio) {
      const { data, error } = await db
        .from('arca_tokens')
        .select('token, sign, expira_at')
        .eq('ambiente', ambiente)
        .eq('servicio', servicio)
        .maybeSingle()
      if (error) throw falla('leer', error)
      if (!data?.token || !data.sign || !data.expira_at) return null
      return { token: data.token as string, sign: data.sign as string, expiraAt: new Date(data.expira_at as string) }
    },
    async reclamarRenovacion(ambiente, servicio) {
      const { data, error } = await db.rpc('arca_reclamar_renovacion', { p_ambiente: ambiente, p_servicio: servicio })
      if (error) throw falla('reclamar la renovación de', error)
      return data === true
    },
    async guardar(ambiente, servicio, ta) {
      const { error } = await db.from('arca_tokens').upsert(
        {
          ambiente, servicio,
          token: ta.token, sign: ta.sign, expira_at: ta.expiraAt.toISOString(),
          renovando_hasta: null,
        },
        { onConflict: 'ambiente,servicio' },
      )
      if (error) throw falla('guardar', error)
    },
  }
}

let storeConfigurado: TaStore | null = null

/** Para scripts y tests: reemplaza el store por defecto (Supabase). */
export function configurarTaStore(store: TaStore | null): void {
  storeConfigurado = store
  cache.clear()
}

async function storePorDefecto(): Promise<TaStore> {
  if (storeConfigurado) return storeConfigurado
  // Import diferido: lib/supabase lanza al importarse si faltan sus env vars,
  // y el script de humo no las necesita.
  const { supabase } = await import('../supabase.js')
  storeConfigurado = crearTaStoreSupabase(supabase)
  return storeConfigurado
}

// ─── obtenerTA ───────────────────────────────────────────────────────────────

const cache = new Map<string, TicketAcceso>()
const enVuelo = new Map<string, Promise<TicketAcceso>>()

/** Olvida el TA en memoria (ej. si WSFE dijo que el token no sirve). No toca la base. */
export function olvidarTA(servicio: string, ambiente?: ArcaAmbiente): void {
  const amb = ambiente ?? arcaConfig().ambiente
  cache.delete(`${amb}:${servicio}`)
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * El TA vigente para `servicio`, renovándolo si hace falta. Orden:
 * memoria → base → (si gana el reclamo) WSAA → si no, espera a que otro lo
 * guarde (cada 2 s, hasta 30 s).
 */
export async function obtenerTA(
  servicio = 'wsfe',
  opts: { store?: TaStore; config?: ArcaConfig; espera?: { entreLecturasMs: number; maximaMs: number } } = {},
): Promise<TicketAcceso> {
  const cfg = opts.config ?? arcaConfig()
  const clave = `${cfg.ambiente}:${servicio}`
  const enMemoria = cache.get(clave)
  if (taVigente(enMemoria)) return enMemoria

  const pendiente = enVuelo.get(clave)
  if (pendiente) return pendiente

  const p = (async () => {
    const store = opts.store ?? (await storePorDefecto())
    const ta = await resolverTA(store, cfg, servicio, opts.espera ?? { entreLecturasMs: ESPERA_ENTRE_LECTURAS_MS, maximaMs: ESPERA_MAXIMA_MS })
    cache.set(clave, ta)
    return ta
  })().finally(() => enVuelo.delete(clave))
  enVuelo.set(clave, p)
  return p
}

async function resolverTA(
  store: TaStore,
  cfg: ArcaConfig,
  servicio: string,
  espera: { entreLecturasMs: number; maximaMs: number },
): Promise<TicketAcceso> {
  const guardado = await store.leer(cfg.ambiente, servicio)
  if (taVigente(guardado)) return guardado

  if (await store.reclamarRenovacion(cfg.ambiente, servicio)) {
    let nuevo: TicketAcceso
    try {
      nuevo = await loginCms(servicio, cfg)
    } catch (e) {
      if (e instanceof ArcaError && e.faultcode === 'coe.alreadyAuthenticated') {
        // ARCA dice que ya hay un TA vigente. Si otro lo guardó mientras
        // tanto, se usa; si no, se perdió y hay que esperar a que venza.
        const otro = await store.leer(cfg.ambiente, servicio)
        if (taVigente(otro)) return otro
        throw new ArcaError({
          tipo: 'soap_fault', codigo: 'ARCA_TA_PERDIDO', quizasLlego: false, faultcode: e.faultcode, cause: e,
          mensaje:
            `ARCA ya entregó un ticket de acceso para ${servicio} (${cfg.ambiente}) que no quedó guardado. ` +
            'No da otro hasta que venza (hasta 12 h): cargalo a mano en arca_tokens o esperá.',
        })
      }
      throw e
    }
    await store.guardar(cfg.ambiente, servicio, nuevo)
    return nuevo
  }

  // Otro proceso está renovando: esperar a que lo guarde.
  const limite = Date.now() + espera.maximaMs
  while (Date.now() < limite) {
    await dormir(espera.entreLecturasMs)
    const ta = await store.leer(cfg.ambiente, servicio)
    if (taVigente(ta)) return ta
  }
  throw new ArcaError({
    tipo: 'transporte', codigo: 'ARCA_TA_EN_RENOVACION', quizasLlego: false,
    mensaje: `Otro proceso está renovando el ticket de ARCA para ${servicio} y no terminó en ${Math.round(espera.maximaMs / 1000)} s. Probá de nuevo en un rato.`,
  })
}
