/**
 * El CUERPO del aviso de pago. Puro a propósito: sin Supabase ni SMTP, para
 * poder probar qué ve un tercero sin levantar nada.
 *
 * Es lo único del sistema que lee alguien de afuera de CADINC (el proveedor y
 * el estudio contable), y un mail no se desmanda. Por eso vive aparte y tiene
 * sus tests.
 *
 * NUNCA va el CBU ni el alias en el cuerpo. El proveedor ya sabe su cuenta y
 * el contador la tiene en el comprobante; ponerla en un mail es regalar el
 * dato que sirve para estafar («cambió nuestro CBU, pagá acá»). Hay un test
 * que lo verifica para los dos destinatarios.
 */

export type Destinatario = 'proveedor' | 'contador'

export interface FacturaDelAviso {
  tipo_comprobante: string | null
  numero:           string | null
  fecha:            string | null
  /** Lo que ESTA orden le aplicó. En un pago parcial es menos que el total. */
  aplicado:         number
}

export interface ChequeDelAviso {
  numero:      string
  banco:       string
  fecha_cobro: string
  monto:       number
}

export interface CuerpoMail { asunto: string; texto: string; html: string }

const fmtM = (v: unknown) =>
  '$' + Number(v ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtF = (s: string | null | undefined) => {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return y && m && d ? `${d}/${m}/${y}` : '—'
}

const FORMA_LABEL: Record<string, string> = {
  transferencia: 'Transferencia', efectivo: 'Efectivo', cheque: 'Cheque', echeq: 'E-cheq',
  tarjeta: 'Tarjeta', debito_automatico: 'Débito automático', otro: 'Otro',
  nota_credito: 'Solo nota de crédito',
}

/** Escapa lo que va al HTML: los nombres vienen de la base y pueden traer `<`. */
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
}

/**
 * El cuerpo del mail. Exportado para poder probarlo sin SMTP: es donde se
 * decide qué ve un tercero, así que se testea.
 */
export function armarCuerpo(
  para: Destinatario,
  o: Record<string, unknown>,
  facturas: FacturaDelAviso[],
  cheques: ChequeDelAviso[],
  empresa: string,
): CuerpoMail {
  const op = String(o.numero_fmt ?? `OP-${o.numero}`)
  const prov = String(o.proveedor_nom ?? '')
  const forma = FORMA_LABEL[String(o.forma_pago ?? '')] ?? String(o.forma_pago ?? '')
  const monto = fmtM(o.monto_pagado)

  const asunto = para === 'proveedor'
    ? `${empresa} — Comprobante de pago ${op} · ${monto}`
    : `${empresa} — ${op} · ${prov} · ${monto}`

  const filasFacturas = facturas.map((f) =>
    `<tr><td style="padding:4px 10px 4px 0">${esc(`${f.tipo_comprobante ?? ''} ${f.numero ?? 's/n'}`.trim())}</td>`
    + `<td style="padding:4px 10px 4px 0;color:#666">${esc(fmtF(f.fecha))}</td>`
    + `<td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${esc(fmtM(f.aplicado))}</td></tr>`).join('')

  const filasCheques = cheques.map((c) =>
    `<tr><td style="padding:4px 10px 4px 0">N° ${esc(c.numero)}${c.banco ? ` · ${esc(c.banco)}` : ''}</td>`
    + `<td style="padding:4px 10px 4px 0;color:#666">se cobra el ${esc(fmtF(c.fecha_cobro))}</td>`
    + `<td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${esc(fmtM(c.monto))}</td></tr>`).join('')

  const saludo = para === 'proveedor'
    ? `Les informamos que se registró el pago <b>${esc(op)}</b> a favor de <b>${esc(prov)}</b>.`
    : `Pago registrado: <b>${esc(op)}</b> a <b>${esc(prov)}</b>${o.proveedor_cuit ? ` (CUIT ${esc(o.proveedor_cuit)})` : ''}.`

  const cierre = para === 'proveedor'
    ? 'Adjuntamos el comprobante. Ante cualquier diferencia, responder este correo.'
    : 'Se adjuntan el comprobante del pago y las facturas que cubre.'

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1C1C1E;max-width:620px">
  <div style="font-size:18px;font-weight:700;color:#1A365D">${esc(empresa)}</div>
  <div style="color:#666;margin:2px 0 14px">Aviso de pago</div>
  <p style="margin:0 0 12px">${saludo}</p>
  <table style="border-collapse:collapse;margin:0 0 14px">
    <tr><td style="padding:3px 14px 3px 0;color:#666">Fecha del pago</td><td><b>${esc(fmtF(String(o.fecha ?? '')))}</b></td></tr>
    <tr><td style="padding:3px 14px 3px 0;color:#666">Forma de pago</td><td><b>${esc(forma)}</b></td></tr>
    <tr><td style="padding:3px 14px 3px 0;color:#666">Importe</td><td><b>${esc(monto)}</b></td></tr>
    ${o.referencia ? `<tr><td style="padding:3px 14px 3px 0;color:#666">Referencia</td><td>${esc(o.referencia)}</td></tr>` : ''}
  </table>
  ${facturas.length > 0 ? `<div style="font-weight:700;margin:0 0 4px">Comprobantes cubiertos</div>
  <table style="border-collapse:collapse;margin:0 0 14px">${filasFacturas}</table>` : ''}
  ${cheques.length > 0 ? `<div style="font-weight:700;margin:0 0 4px">${cheques.length === 1 ? 'Cheque entregado' : 'Cheques entregados'}</div>
  <table style="border-collapse:collapse;margin:0 0 14px">${filasCheques}</table>` : ''}
  <p style="margin:0 0 12px">${esc(cierre)}</p>
  <div style="color:#999;font-size:11px;border-top:1px solid #DDD;padding-top:8px">
    Correo generado por el sistema de gestión de ${esc(empresa)}.
  </div>
</div>`

  const lineas = [
    `${empresa} — Aviso de pago`, '',
    para === 'proveedor'
      ? `Se registró el pago ${op} a favor de ${prov}.`
      : `Pago registrado: ${op} a ${prov}.`,
    '',
    `Fecha del pago: ${fmtF(String(o.fecha ?? ''))}`,
    `Forma de pago: ${forma}`,
    `Importe: ${monto}`,
    o.referencia ? `Referencia: ${o.referencia}` : '',
    '',
    ...(facturas.length > 0
      ? ['Comprobantes cubiertos:', ...facturas.map((f) =>
          `  ${`${f.tipo_comprobante ?? ''} ${f.numero ?? 's/n'}`.trim()}  ${fmtF(f.fecha)}  ${fmtM(f.aplicado)}`), '']
      : []),
    ...(cheques.length > 0
      ? [cheques.length === 1 ? 'Cheque entregado:' : 'Cheques entregados:', ...cheques.map((c) =>
          `  N° ${c.numero}${c.banco ? ` · ${c.banco}` : ''}  se cobra el ${fmtF(c.fecha_cobro)}  ${fmtM(c.monto)}`), '']
      : []),
    cierre,
  ].filter((l) => l !== '' || true)

  return { asunto, texto: lineas.join('\n'), html }
}

