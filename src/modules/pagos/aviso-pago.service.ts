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
import { getEmpresa } from '../../lib/empresa.js'
import { armarCuerpo, armarPrueba, comprobantesDelAviso, destinatariosProveedor, type Destinatario } from './aviso-pago.cuerpo.js'
import { nombreRemitenteEfectivo, pagosConfigService, responderAEfectivo } from './config.service.js'
export { armarCuerpo, comprobantesDelAviso, destinatariosProveedor } from './aviso-pago.cuerpo.js'
export type { Destinatario } from './aviso-pago.cuerpo.js'

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
    dto: { a_proveedor: boolean; a_contador: boolean; email_proveedor?: string; emails_proveedor?: string[]; guardar_email?: boolean },
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

    const facturaIds = [...new Set(((lineas.data ?? []) as any[])
      .map((l) => l.factura_id).filter((x): x is number => typeof x === 'number'))]

    // NC aprobadas y vigentes aplicadas a cada factura (20260925a): el mail
    // dice «menos NC aplicadas $X» para que el proveedor entienda por qué se
    // pagó menos que el total. Best-effort: si falla, el aviso sale sin eso.
    const ncPorFactura = new Map<number, number>()
    if (facturaIds.length > 0) {
      const { data: aps } = await sb.from('pagos_nc_aplicaciones').select('nc_id, factura_id, monto').in('factura_id', facturaIds)
      const filas = (aps ?? []) as { nc_id: number; factura_id: number; monto: number | string }[]
      const ncIds = [...new Set(filas.map((a) => Number(a.nc_id)))]
      if (ncIds.length > 0) {
        const { data: ncs } = await sb.from('pagos_facturas').select('id, estado, aprobada_at').in('id', ncIds)
        const ok = new Set(((ncs ?? []) as { id: number; estado: string; aprobada_at: string | null }[])
          .filter((n) => n.estado !== 'anulada' && n.aprobada_at != null).map((n) => Number(n.id)))
        for (const a of filas) {
          if (!ok.has(Number(a.nc_id))) continue
          const k = Number(a.factura_id)
          ncPorFactura.set(k, Math.round(((ncPorFactura.get(k) ?? 0) + Number(a.monto)) * 100) / 100)
        }
      }
    }

    const facturas = ((lineas.data ?? []) as any[])
      .filter((l) => l.tipo !== 'nota_credito' && l.factura_id != null)
      .map((l) => ({
        tipo_comprobante: l.factura?.tipo_comprobante ?? null,
        numero: l.factura?.numero ?? null,
        fecha: l.factura?.fecha ?? null,
        aplicado: Number(l.monto),
        nc_aplicadas: ncPorFactura.get(Number(l.factura_id)) ?? 0,
      }))
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

    // Lo que prueba el pago: el comprobante y, con cheque/e-cheq, el archivo de
    // cada cheque (20260929w: en un e-cheq ése ES el comprobante).
    const comprobantes = comprobantesDelAviso(orden.forma_pago as string | null, (adjOrden.data ?? []) as any[])
    // Nombre de fantasía de empresa_config; EMPRESA_NOMBRE del env queda como fallback (en getEmpresa).
    const empresa = (await getEmpresa()).nombre_fantasia
    // Configuración de Compras (20260929i): a quién le llega el del contador
    // (pantalla → env → perfil), Reply-To, nombre del From y pie.
    const config = await pagosConfigService.obtener()
    const responderA = responderAEfectivo(config.aviso.responder_a) ?? undefined
    const nombreRemitente = nombreRemitenteEfectivo(config.aviso.nombre_remitente, empresa) ?? undefined
    const pie = config.aviso.pie_texto

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
          })), empresa, { pie })
        await enviarMail({ para: email, asunto: cuerpo.asunto, texto: cuerpo.texto, html: cuerpo.html, adjuntos, responderA, nombreRemitente })
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
      const provId = Number(orden.proveedor_id)
      // Contactos del proveedor (20260925e). Sin elegir, van los que tienen
      // «recibe avisos»; si no hay ninguno, el email suelto viejo del padrón.
      const { data: cont, error: eCont } = await sb.from('pagos_proveedor_contactos')
        .select('email, recibe_avisos').eq('proveedor_id', provId).not('email', 'is', null)
      const contactos = ((cont ?? []) as { email: string; recibe_avisos: boolean }[])
      const { emails, pedidos, conocidos } = destinatariosProveedor({
        pedidos: dto.emails_proveedor ?? (dto.email_proveedor ? [dto.email_proveedor] : []),
        contactos, delPadron: String(orden.proveedor_email ?? ''),
      })
      // Las direcciones nuevas quedan como contacto: el próximo aviso ya las trae.
      // Si no se pudo leer la lista, no se guarda nada: todas parecerían nuevas.
      if (dto.guardar_email && !eCont) {
        const nuevas = pedidos.filter((e) => esEmailValido(e) && !conocidos.has(e))
        if (nuevas.length) {
          const { count } = await supabase.from('pagos_proveedor_contactos')
            .select('id', { count: 'exact', head: true }).eq('proveedor_id', provId)
          const { error: eIns } = await supabase.from('pagos_proveedor_contactos').insert(nuevas.map((email, i) => ({
            proveedor_id: provId, email, rol: 'administracion', recibe_avisos: true,
            orden: (count ?? 0) + i + 1, created_by: userId, updated_by: userId,
          })))
          // Best-effort: el aviso sale igual; guardar la dirección es un extra.
          if (eIns) console.warn('[aviso-pago] no se guardó el contacto nuevo:', eIns.message)
        }
      }
      // El proveedor recibe SOLO el comprobante del pago: la factura ya es suya.
      // Un mail por dirección: si una rebota, las otras salen igual y queda cada intento.
      if (emails.length === 0) await mandarA('proveedor', null, comprobantes)
      for (const email of emails) await mandarA('proveedor', email, comprobantes)
    }

    if (dto.a_contador) {
      // El contador recibe el par completo: sin el comprobante ve la deuda pero
      // no puede cerrar el asiento.
      await mandarA('contador', config.aviso.contador_email_efectivo, [...comprobantes, ...((adjFactura.data ?? []) as any[])])
    }

    return { resultados }
  },

  /**
   * Mail de prueba desde Compras › Configuración: sale con el remitente, el
   * Reply-To y el pie configurados, para ver cómo le llega a un tercero. A
   * diferencia del aviso, un fallo SÍ se devuelve como error: es lo que se
   * quiere saber.
   */
  async probar(para: string): Promise<{ ok: true; para: string; remitente: string; message_id: string }> {
    if (!esEmailValido(para)) throw new PagosHttpError(400, 'EMAIL_INVALIDO')
    if (!estaConfigurado()) throw new PagosHttpError(409, 'MAIL_NO_CONFIGURADO', { falta: loQueFalta() })
    pagosConfigService.olvidarCache()
    const config = await pagosConfigService.obtener()
    const empresa = (await getEmpresa()).nombre_fantasia
    const cuerpo = armarPrueba(empresa, config.aviso.pie_texto)
    try {
      const r = await enviarMail({
        para, asunto: cuerpo.asunto, texto: cuerpo.texto, html: cuerpo.html,
        responderA: responderAEfectivo(config.aviso.responder_a) ?? undefined,
        nombreRemitente: nombreRemitenteEfectivo(config.aviso.nombre_remitente, empresa) ?? undefined,
      })
      return { ok: true, para, remitente: config.aviso.remitente_efectivo, message_id: r.messageId }
    } catch (e) {
      throw new PagosHttpError(502, 'MAIL_NO_ENVIADO', { mensaje: e instanceof Error ? e.message : 'no se pudo enviar' })
    }
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
