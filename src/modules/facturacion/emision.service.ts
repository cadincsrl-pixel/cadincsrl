/**
 * Emisión contra ARCA (WSFEv1) y reconciliación. La máquina de estados vive
 * en la base (20260924c); acá se orquesta:
 *
 *   ventas_iniciar_emision  (borrador → emitiendo; toma el lock del talonario)
 *   → FECompUltimoAutorizado
 *   → ventas_marcar_intento(último + 1)      ← persistido ANTES de llamar
 *   → FECAESolicitar
 *   → ventas_confirmar_emision(A | R | incierto)
 *
 * Qué pasa cuando algo falla:
 *   - ANTES de que el pedido pueda llegar a ARCA (sin ticket, sin conexión,
 *     SOAP fault, último autorizado que no responde): la factura se devuelve a
 *     borrador y la respuesta es 503 ARCA_NO_DISPONIBLE. Se puede volver a
 *     emitir enseguida.
 *     Cómo: `ventas_volver_a_borrador` desde `emitiendo` exige que el intento
 *     esté quieto hace 2 min (protege un request en vuelo). Como acá SABEMOS
 *     que no hay nada en vuelo, se pasa primero por `error_reconciliar`
 *     (confirmar con `incierto`) y de ahí a borrador, que no tiene esa espera.
 *     Queda en los eventos con el motivo.
 *   - Si el pedido PUDO haber llegado (timeout, conexión cortada a mitad,
 *     respuesta ilegible): `incierto` → `error_reconciliar` y 202
 *     EMISION_INCIERTA. La UI hace polling a /reconciliar; el cron también.
 *   - Rechazo de ARCA: `rechazada` y 422 ARCA_RECHAZO con errores Y
 *     observaciones (el 10016 viene en Obs).
 *
 * Reconciliar: FECompUltimoAutorizado; si es menor que el número intentado,
 * ARCA no lo tiene → borrador. Si no, FECompConsultar: si coincide documento y
 * total → autorizada con el CAE de ARCA; si no coincide → 409
 * CONFLICTO_NUMERACION y queda trabada (alerta en el log).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.js'
import {
  ArcaError, arcaConfig, arcaLoQueFalta, obtenerTA, ultimoAutorizado, solicitarCAE, consultarComprobante, feDummy,
  configurarTaStore, configurarTrazaXml, crearTaStoreSupabase,
  type ArcaConfig, type ResultadoCAE, type TrazaXml,
} from '../../lib/arca/index.js'
import { FacturacionHttpError, errorArca, mapRpcError, type PgError } from './facturacion.errors.js'
import { ambienteProceso, leerFJ, rpc, talonarioProceso } from './comun.js'
import { armarComprobante, coincideConsultado, pResDeCAE, pResDeConsultado, type FJ, type PRes } from './reglas.js'

// ── Traza: cada intercambio con WSFE a ventas_facturas_arca_log ─────────────

const contextoFactura = new AsyncLocalStorage<{ facturaId: number }>()

/** Corre `fn` con la factura en contexto: la traza la asocia a cada llamada a WSFE. */
export function conFactura<T>(facturaId: number, fn: () => Promise<T>): Promise<T> {
  return contextoFactura.run({ facturaId }, fn)
}

/** Métodos que se loguean aunque no haya factura en contexto. */
const SIEMPRE = new Set(['FECAESolicitar', 'FECompConsultar'])

export function trazaSupabase(db: SupabaseClient, ambiente: () => string | null): TrazaXml {
  return (t) => {
    const facturaId = contextoFactura.getStore()?.facturaId ?? null
    // FEDummy / último autorizado del GET /arca/estado no llenan el log.
    if (facturaId == null && !SIEMPRE.has(t.metodo)) return
    const amb = ambiente()
    if (!amb) return
    void (async () => {
      try {
        const { error } = await db.from('ventas_facturas_arca_log').insert({
          factura_id: facturaId,
          ambiente: amb,
          metodo: t.metodo,
          request_xml: t.pedido,      // Token y Sign ya vienen como ***
          response_xml: t.respuesta,
          http_status: t.httpStatus,
          duracion_ms: t.duracionMs ?? null,
          error: t.error ?? null,
        })
        if (error) console.error('[facturacion] no se pudo guardar el log de ARCA:', error.message)
      } catch (e) {
        console.error('[facturacion] no se pudo guardar el log de ARCA:', e instanceof Error ? e.message : e)
      }
    })()
  }
}

let iniciado = false
/** TaStore en `arca_tokens` + traza al log. Se llama una vez al arrancar (app.ts). */
export function iniciarArca(db: SupabaseClient = supabase): void {
  if (iniciado) return
  iniciado = true
  configurarTaStore(crearTaStoreSupabase(db))
  configurarTrazaXml(trazaSupabase(db, () => ambienteProceso()))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function configOr503(): ArcaConfig {
  try {
    return arcaConfig()
  } catch (e) {
    throw new FacturacionHttpError(503, 'ARCA_NO_CONFIGURADO', { falta: arcaLoQueFalta() , mensaje: e instanceof Error ? e.message : String(e) })
  }
}

/** Hasta cuándo no se puede pedir otro TA (aprox.): el vencimiento del guardado + 30 min. */
async function hastaTaPerdido(db: SupabaseClient, ambiente: string): Promise<string | null> {
  const { data } = await db.from('arca_tokens').select('expira_at').eq('ambiente', ambiente).eq('servicio', 'wsfe').maybeSingle()
  const exp = (data as { expira_at: string | null } | null)?.expira_at
  if (!exp) return null
  return new Date(Math.max(new Date(exp).getTime(), Date.now()) + 30 * 60_000).toISOString()
}

async function aHttp(db: SupabaseClient, e: unknown, ambiente: string, extra?: Record<string, unknown>): Promise<FacturacionHttpError> {
  const err = errorArca(e, extra)
  if (err.code === 'ARCA_TA_PERDIDO') {
    err.detail = { ...(err.detail as object), hasta: await hastaTaPerdido(db, ambiente), aproximado: true }
  }
  return err
}

const mensajeDe = (e: unknown) => (e instanceof ArcaError ? `${e.codigo}: ${e.message}` : e instanceof Error ? e.message : String(e))

/**
 * La factura quedó en `emitiendo` y el pedido NO llegó a ARCA: volverla a
 * borrador ya (ver encabezado). Best-effort: si falla, el cron la reconcilia.
 */
async function liberarSinEnviar(db: SupabaseClient, id: number, numero: number | null, motivo: string, userId: string): Promise<FJ | null> {
  try {
    await rpc(db, 'ventas_confirmar_emision', {
      p_id: id, p_res: { resultado: 'incierto', error: `no se envió a ARCA: ${motivo}` }, p_user_id: userId,
    })
    return await rpc<FJ>(db, 'ventas_volver_a_borrador', {
      p_id: id, p_numero_consultado: numero, p_motivo: `ARCA no recibió el pedido: ${motivo}`.slice(0, 500), p_user_id: userId,
    })
  } catch (e) {
    console.error(`[facturacion] factura ${id}: no se pudo devolver a borrador tras una falla previa al envío:`, mensajeDe(e))
    return null
  }
}

/** confirmar_emision con reintentos: si ARCA autorizó, no puede perderse por un tropiezo de la base. */
async function confirmar(db: SupabaseClient, id: number, pRes: PRes, userId: string): Promise<FJ> {
  let ultimo: unknown
  for (let i = 0; i < 3; i++) {
    try {
      return await rpc<FJ>(db, 'ventas_confirmar_emision', { p_id: id, p_res: pRes, p_user_id: userId })
    } catch (e) {
      ultimo = e
      // Otro (reconciliación) ya la cerró: devolver lo que quedó.
      if (e instanceof FacturacionHttpError && e.code === 'FACTURA_NO_EMITIENDO') return leerFJ(db, id)
      if (e instanceof FacturacionHttpError && e.status < 500) throw e
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw ultimo
}

// ── Emitir ──────────────────────────────────────────────────────────────────

export const emisionService = {
  /**
   * Emite UN comprobante. Resuelve con el FJ autorizado (200) o lanza
   * FacturacionHttpError: 422 ARCA_RECHAZO / 202 EMISION_INCIERTA (con
   * `extra.factura`), 409 EMISION_EN_CURSO, 503 ARCA_*.
   */
  async emitir(id: number, userId: string, forzar: boolean, db: SupabaseClient = supabase): Promise<FJ> {
    const cfg = configOr503()
    const talonario = talonarioProceso()
    if (cfg.ambiente !== talonario.ambiente) throw new FacturacionHttpError(503, 'ARCA_NO_CONFIGURADO', { falta: ['ARCA_AMBIENTE'] })

    // Ticket ANTES de tocar la factura: la falla más común (TA perdido, WSAA
    // caído, certificado) no deja nada a medio camino.
    try {
      await obtenerTA('wsfe', { config: cfg })
    } catch (e) {
      throw await aHttp(db, e, cfg.ambiente)
    }

    const fj = await rpc<FJ & { ultimo_local: number | null }>(db, 'ventas_iniciar_emision', {
      p_id: id, p_ambiente: cfg.ambiente, p_user_id: userId, p_forzar: forzar,
    })
    const f = fj.factura

    return conFactura(id, async () => {
      // 1. Último autorizado en ARCA.
      let numero: number
      try {
        const ult = await ultimoAutorizado(Number(f.pto_vta), Number(f.cbte_tipo), { config: cfg })
        numero = ult.numero + 1
      } catch (e) {
        await liberarSinEnviar(db, id, null, mensajeDe(e), userId)
        throw await aHttp(db, e, cfg.ambiente, { factura_id: id })
      }

      // 2. El número, persistido antes de llamar.
      try {
        await rpc(db, 'ventas_marcar_intento', { p_id: id, p_numero: numero, p_user_id: userId })
      } catch (e) {
        await liberarSinEnviar(db, id, null, `marcar intento: ${mensajeDe(e)}`, userId)
        if (e instanceof FacturacionHttpError && e.code === 'NUMERO_DESFASADO') {
          console.error(`[facturacion] ALERTA factura ${id}: ARCA dice último ${numero - 1} y la base ya tiene ese número o más`, e.detail)
        }
        throw e
      }

      // 3. El CAE.
      let res: ResultadoCAE
      try {
        res = await solicitarCAE(armarComprobante(fj, numero), { config: cfg })
      } catch (e) {
        if (e instanceof ArcaError && !e.quizasLlego) {
          await liberarSinEnviar(db, id, numero, mensajeDe(e), userId)
          throw await aHttp(db, e, cfg.ambiente, { factura_id: id })
        }
        // Pudo haber llegado: NO reintentar a ciegas.
        console.error(`[facturacion] factura ${id}: emisión incierta (número ${numero}):`, mensajeDe(e))
        const incierta = await confirmar(db, id, { resultado: 'incierto', error: mensajeDe(e).slice(0, 1000) }, userId)
          .catch(() => null)
        throw new FacturacionHttpError(202, 'EMISION_INCIERTA', { numero_intentado: numero, mensaje: mensajeDe(e) },
          { factura: incierta ?? (await leerFJ(db, id).catch(() => null)) })
      }

      // 4. Resultado.
      let final: FJ
      try {
        final = await confirmar(db, id, pResDeCAE(res), userId)
      } catch (e) {
        // ARCA contestó pero la base no lo pudo guardar. Si fue A, la
        // reconciliación lo levanta con FECompConsultar.
        console.error(`[facturacion] ALERTA factura ${id}: ARCA respondió ${res.resultado} (CAE ${res.cae ?? '-'}) y no se pudo guardar:`, mensajeDe(e))
        throw new FacturacionHttpError(202, 'EMISION_INCIERTA', { numero_intentado: numero, resultado_arca: res.resultado },
          { factura: await leerFJ(db, id).catch(() => null) })
      }
      if (res.resultado === 'R') {
        throw new FacturacionHttpError(422, 'ARCA_RECHAZO', { errores: res.errores, observaciones: res.observaciones }, { factura: final })
      }
      console.log(`[facturacion] factura ${id} autorizada: ${f.cbte_tipo}-${f.pto_vta}-${numero} CAE ${res.cae}`)
      return final
    })
  },

  /**
   * Reconciliación de una factura `error_reconciliar` o `emitiendo`
   * (idempotente: sobre una autorizada, borrador, rechazada o descartada
   * devuelve el FJ sin tocar nada). `userId` es quien pide; el cron pasa el
   * que la emitió.
   */
  async reconciliar(id: number, userId: string, db: SupabaseClient = supabase): Promise<FJ> {
    let fj = await leerFJ(db, id)
    const f = fj.factura
    if (f.estado !== 'error_reconciliar' && f.estado !== 'emitiendo') return fj

    // Un intento en vuelo (< 2 min) no se toca: lo cierra el request que lo hizo.
    const quieto = Date.now() - new Date(f.intento_at ?? f.updated_at).getTime() >= 2 * 60_000
    if (f.estado === 'emitiendo' && !quieto) return fj

    const numero = f.numero_intentado != null ? Number(f.numero_intentado) : null
    if (numero == null) {
      // Nunca se mandó un número: no hay nada que buscar en ARCA.
      return rpc<FJ>(db, 'ventas_volver_a_borrador', {
        p_id: id, p_numero_consultado: null, p_motivo: 'reconciliación: no se llegó a pedir número', p_user_id: userId,
      })
    }

    const cfg = configOr503()
    if (cfg.ambiente !== f.ambiente) throw new FacturacionHttpError(409, 'AMBIENTE_NO_COINCIDE', { esperado: cfg.ambiente, factura: f.ambiente })

    return conFactura(id, async () => {
      let ultimo: number
      try {
        ultimo = (await ultimoAutorizado(Number(f.pto_vta), Number(f.cbte_tipo), { config: cfg })).numero
      } catch (e) {
        throw await aHttp(db, e, cfg.ambiente, { factura_id: id })
      }

      if (ultimo < numero) {
        // ARCA no llegó a ese número: el pedido no se autorizó. De vuelta a borrador.
        try {
          return await rpc<FJ>(db, 'ventas_volver_a_borrador', {
            p_id: id, p_numero_consultado: numero,
            p_motivo: `reconciliación: ARCA tiene hasta el ${ultimo}, no el ${numero}`, p_user_id: userId,
          })
        } catch (e) {
          if (e instanceof FacturacionHttpError && e.code === 'EMISION_EN_CURSO') return leerFJ(db, id)
          throw e
        }
      }

      let consultado
      try {
        consultado = await consultarComprobante(Number(f.pto_vta), Number(f.cbte_tipo), numero, { config: cfg })
      } catch (e) {
        throw await aHttp(db, e, cfg.ambiente, { factura_id: id })
      }
      if (consultado && coincideConsultado(f, consultado)) {
        fj = await confirmar(db, id, pResDeConsultado(consultado), userId)
        console.log(`[facturacion] factura ${id} reconciliada como autorizada: número ${numero} CAE ${consultado.codAutorizacion}`)
        return fj
      }
      const detalle = {
        factura_id: id, numero,
        factura: { doc_nro: f.rec_doc_nro, imp_total: Number(f.imp_total) },
        arca: consultado
          ? { doc_nro: consultado.docNro, imp_total: consultado.impTotal, resultado: consultado.resultado, cae: consultado.codAutorizacion }
          : null,
        ultimo_arca: ultimo,
      }
      console.error(`[facturacion] ALERTA CONFLICTO_NUMERACION factura ${id}: ARCA tiene otro comprobante con el número ${numero}`, detalle)
      throw new FacturacionHttpError(409, 'CONFLICTO_NUMERACION', detalle)
    })
  },

  /**
   * Cron: reconcilia `error_reconciliar` y `emitiendo` quietas hace > 2 min
   * del ambiente del proceso. El usuario de la RPC es quien la emitió.
   */
  async reconciliarPendientes(db: SupabaseClient = supabase) {
    const amb = ambienteProceso()
    if (!amb || arcaLoQueFalta().length) return { revisadas: 0, resultados: [], omitido: 'ARCA_NO_CONFIGURADO' }
    const { data, error } = await db.from('ventas_facturas')
      .select('id, estado, intento_at, updated_at, emitida_por, created_by')
      .eq('ambiente', amb).in('estado', ['error_reconciliar', 'emitiendo']).order('id')
    if (error) throw mapRpcError(error as PgError)
    const limite = Date.now() - 2 * 60_000
    const filas = ((data ?? []) as Array<{ id: number; estado: string; intento_at: string | null; updated_at: string; emitida_por: string | null; created_by: string | null }>)
      .filter((f) => f.estado === 'error_reconciliar' || new Date(f.intento_at ?? f.updated_at).getTime() < limite)
    const resultados: Array<{ id: number; estado?: string; error?: string }> = []
    for (const f of filas) {
      const uid = f.emitida_por ?? f.created_by
      if (!uid) { resultados.push({ id: f.id, error: 'SIN_USUARIO' }); continue }
      try {
        const r = await this.reconciliar(f.id, uid, db)
        resultados.push({ id: f.id, estado: r.factura.estado })
      } catch (e) {
        resultados.push({ id: f.id, error: e instanceof FacturacionHttpError ? e.code : mensajeDe(e) })
      }
    }
    return { revisadas: filas.length, resultados }
  },

  /** GET /arca/estado. Nunca rompe: si ARCA no responde, `dummy: null` y `error`. */
  async estado() {
    const falta = arcaLoQueFalta()
    const ambiente = ambienteProceso()
    const pto = talonarioSeguro()
    const base = { ambiente, configurado: falta.length === 0, falta, pto_vta: pto }
    if (falta.length) return { ...base, dummy: null, ultimo: null, error: null }
    const cfg = arcaConfig()
    let dummy: { appServer: string; dbServer: string; authServer: string } | null = null
    let ultimo: { '1': number; '3': number; '6': number; '8': number } | null = null
    const errores: string[] = []
    try {
      dummy = await feDummy({ config: cfg })
    } catch (e) {
      errores.push(`FEDummy: ${mensajeDe(e)}`)
    }
    try {
      const [a, nca, b, ncb] = await Promise.all([1, 3, 6, 8].map((t) => ultimoAutorizado(cfg.ptoVta, t, { config: cfg })))
      ultimo = { '1': a!.numero, '3': nca!.numero, '6': b!.numero, '8': ncb!.numero }
    } catch (e) {
      errores.push(`Último autorizado: ${mensajeDe(e)}`)
    }
    return { ...base, dummy, ultimo, error: errores.length ? errores.join(' · ') : null }
  },
}

function talonarioSeguro(): number {
  try {
    return talonarioProceso().ptoVta
  } catch {
    const pv = (process.env.ARCA_PTO_VTA ?? '').trim()
    return pv && /^\d{1,5}$/.test(pv) ? Number(pv) : 3
  }
}
