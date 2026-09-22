/**
 * El aviso de pago por mail (2026-09-21).
 *
 * Pedido del dueño: «¿podemos hacer que cuando se genere una OP se mande un
 * mail al contador y al proveedor con los comprobantes de pago?».
 *
 * NO es automático al emitir, y es una decisión, no una limitación: de 9
 * proveedores del padrón, 1 tiene mail cargado. Automático, en 8 de 9 casos no
 * saldría nada y el que emitió creería que el proveedor se enteró. Va con un
 * clic que muestra antes a qué dirección y con qué adjuntos.
 *
 * Cada destinatario recibe lo suyo, que no es lo mismo:
 *   · PROVEEDOR  → el comprobante con el que salió la plata. Es lo que necesita
 *                  para imputar el cobro. NO se le manda la factura: ya es suya.
 *   · CONTADOR   → el par completo, comprobante + las facturas que cubrió, que
 *                  es lo que necesita para cerrar el asiento.
 *
 * NUNCA va el CBU en el cuerpo. El proveedor ya sabe su cuenta y el contador la
 * tiene en el comprobante; ponerla en un mail es regalar un dato que sirve para
 * estafar («cambió nuestro CBU, pagá acá»).
 *
 * Y NUNCA lanza por un fallo de correo: cada intento se registra en
 * `pagos_ordenes_avisos` con su estado y su error. La OP ya está emitida y la
 * plata ya salió — que el SMTP esté caído no puede volverse un problema de la
 * orden.
 */
import { createSupabaseClient, supabase } from '../../lib/supabase.js'
import { enviarMail, esEmailValido, estaConfigurado, loQueFalta, type AdjuntoMail } from '../../lib/mail.js'
import { BUCKET } from './adjuntos.service.js'
import { PagosHttpError } from './pagos.errors.js'
import { armarCuerpo, type Destinatario } from './aviso-pago.cuerpo.js'
export { armarCuerpo } from './aviso-pago.cuerpo.js'
export type { Destinatario } from './aviso-pago.cuerpo.js'

/** La casilla del contador: la del env, o la del usuario activo con rol contador. */
async function emailDelContador(): Promise<string | null> {
  const delEnv = (process.env.CONTADOR_EMAIL ?? '').trim()
  if (esEmailValido(delEnv)) return delEnv
  const { data } = await supabase
    .from('profiles').select('id').eq('rol_key', 'contador').eq('activo', true).limit(1).maybeSingle()
  if (!data) return null
  const { data: u } = await supabase.auth.admin.getUserById((data as { id: string }).id)
  const mail = u?.user?.email ?? ''
  return esEmailValido(mail) ? mail : null
}

export type EstadoAviso = 'enviado' | 'fallado' | 'omitido'

export interface ResultadoAviso {
  destinatario: Destinatario
  estado:       EstadoAviso
  email:        string | null
  adjuntos:     string[]
  error:        string
}

export const avisoPagoService = {
  /** Diagnóstico para la UI: ¿se puede mandar mail desde este servidor? */
  estado() {
    return { configurado: estaConfigurado(), falta: loQueFalta() }
  },

  /**
   * Manda el aviso a quien se pida y registra cada intento. No lanza por un
   * fallo de correo: devuelve un resultado por destinatario.
   */
  async avisar(
    ordenId: number,
    dto: { a_proveedor: boolean; a_contador: boolean; email_proveedor?: string; guardar_email?: boolean },
    userId: string,
    token: string,
  ): Promise<{ resultados: ResultadoAviso[] }> {
    const sb = createSupabaseClient(token)
    const { data: o, error } = await sb.from('v_pagos_ordenes').select('*').eq('id', ordenId).maybeSingle()
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    if (!o) throw new PagosHttpError(404, 'ORDEN_NO_EXISTE')
    const orden = o as Record<string, unknown>
    // Avisar de un pago que se anuló es mandar información falsa.
    if (orden.estado === 'anulada') throw new PagosHttpError(409, 'ORDEN_ANULADA')
    if (!dto.a_proveedor && !dto.a_contador) throw new PagosHttpError(400, 'SIN_DESTINATARIOS')

    const [lineas, cheques, adjOrden] = await Promise.all([
      sb.from('pagos_orden_lineas')
        .select('factura_id, tipo, monto, factura:pagos_facturas(tipo_comprobante, numero, fecha)')
        .eq('orden_id', ordenId).order('id'),
      sb.from('pagos_cheques').select('numero, banco, fecha_cobro, monto')
        .eq('orden_id', ordenId).order('fecha_cobro'),
      sb.from('pagos_ordenes_adjuntos')
        .select('id, tipo, storage_path, nombre_archivo, mime_type')
        .eq('orden_id', ordenId).is('deleted_at', null),
    ])
    if (lineas.error) throw new PagosHttpError(500, 'DB_ERROR', lineas.error.message)

    const facturas = ((lineas.data ?? []) as any[])
      .filter((l) => l.tipo !== 'nota_credito' && l.factura_id != null)
      .map((l) => ({
        tipo_comprobante: l.factura?.tipo_comprobante ?? null,
        numero: l.factura?.numero ?? null,
        fecha: l.factura?.fecha ?? null,
        aplicado: Number(l.monto),
      }))

    const facturaIds = [...new Set(((lineas.data ?? []) as any[])
      .map((l) => l.factura_id).filter((x): x is number => typeof x === 'number'))]
    const adjFactura = facturaIds.length === 0 ? { data: [] as any[] } : await sb
      .from('pagos_facturas_adjuntos')
      .select('id, tipo, storage_path, nombre_archivo, mime_type')
      .in('factura_id', facturaIds).is('deleted_at', null).eq('tipo', 'factura')

    /** Baja del bucket lo que se va a adjuntar. Lo que no baja se omite, no rompe. */
    const bajar = async (filas: any[]): Promise<AdjuntoMail[]> => {
      const out: AdjuntoMail[] = []
      for (const a of filas) {
        const dl = await supabase.storage.from(BUCKET).download(a.storage_path)
        if (dl.error || !dl.data) continue
        out.push({
          filename: String(a.nombre_archivo ?? 'adjunto'),
          content: Buffer.from(await dl.data.arrayBuffer()),
          contentType: a.mime_type ?? undefined,
        })
      }
      return out
    }

    const comprobantes = ((adjOrden.data ?? []) as any[]).filter((a) => a.tipo === 'comprobante_pago')
    const empresa = process.env.EMPRESA_NOMBRE ?? 'CADINC SRL'
    const responderA = (process.env.SMTP_REPLY_TO ?? '').trim() || undefined

    const registrar = async (r: ResultadoAviso) => {
      await supabase.from('pagos_ordenes_avisos').insert({
        orden_id: ordenId, destinatario: r.destinatario, email: r.email,
        estado: r.estado, adjuntos: r.adjuntos, error: r.error, enviado_por: userId,
      })
    }

    const resultados: ResultadoAviso[] = []

    const mandarA = async (destinatario: Destinatario, email: string | null, filas: any[]) => {
      if (!email || !esEmailValido(email)) {
        const r: ResultadoAviso = {
          destinatario, estado: 'omitido', email: email ?? null, adjuntos: [],
          error: email ? `La dirección «${email}» no tiene forma de dirección` : 'No hay dirección cargada',
        }
        resultados.push(r)
        await registrar(r)
        return
      }
      const adjuntos = await bajar(filas)
      const nombres = adjuntos.map((a) => a.filename)
      try {
        const cuerpo = armarCuerpo(destinatario, orden, facturas,
          ((cheques.data ?? []) as any[]).map((c) => ({
            numero: String(c.numero), banco: String(c.banco ?? ''),
            fecha_cobro: String(c.fecha_cobro), monto: Number(c.monto),
          })), empresa)
        await enviarMail({ para: email, asunto: cuerpo.asunto, texto: cuerpo.texto, html: cuerpo.html, adjuntos, responderA })
        const r: ResultadoAviso = { destinatario, estado: 'enviado', email, adjuntos: nombres, error: '' }
        resultados.push(r)
        await registrar(r)
      } catch (e) {
        const r: ResultadoAviso = {
          destinatario, estado: 'fallado', email, adjuntos: nombres,
          error: e instanceof Error ? e.message : 'no se pudo enviar',
        }
        resultados.push(r)
        await registrar(r)
      }
    }

    if (dto.a_proveedor) {
      const delPadron = String(orden.proveedor_email ?? '').trim()
      const email = (dto.email_proveedor ?? '').trim() || delPadron
      // Si vino una dirección nueva y se pidió guardarla, queda en el padrón:
      // así el próximo aviso no la vuelve a pedir.
      if (dto.guardar_email && esEmailValido(dto.email_proveedor) && dto.email_proveedor !== delPadron) {
        await supabase.from('pagos_proveedores')
          .update({ email: dto.email_proveedor!.trim(), updated_by: userId })
          .eq('id', Number(orden.proveedor_id))
      }
      // El proveedor recibe SOLO el comprobante del pago: la factura ya es suya.
      await mandarA('proveedor', email || null, comprobantes)
    }

    if (dto.a_contador) {
      // El contador recibe el par completo: sin el comprobante ve la deuda pero
      // no puede cerrar el asiento.
      await mandarA('contador', await emailDelContador(), [...comprobantes, ...((adjFactura.data ?? []) as any[])])
    }

    return { resultados }
  },

  /** Lo que ya se mandó de esta orden, para que la ficha no lo repita a ciegas. */
  async historial(ordenId: number, token: string) {
    const sb = createSupabaseClient(token)
    const { data, error } = await sb.from('pagos_ordenes_avisos')
      .select('id, destinatario, email, estado, adjuntos, error, enviado_at, enviado_por')
      .eq('orden_id', ordenId).order('enviado_at', { ascending: false })
    if (error) throw new PagosHttpError(500, 'DB_ERROR', error.message)
    return data ?? []
  },
}
