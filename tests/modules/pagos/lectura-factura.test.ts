/**
 * «Archivo primero» (20260924u): el QR de ARCA, la fusión con la lectura de
 * la IA y los controles que ve la persona. Todo puro.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/lib/supabase.js', () => ({ supabase: {}, createSupabaseClient: () => ({}) }))

import { parsearQrArca, tipoDesdeArca, arcaDesdeLetra, alicuotaIdDe, CUIT_CADINC } from '../../../src/modules/pagos/lectura/arca.js'
import { fusionar, controlesDeContexto, fmtPuntoVenta, fmtNumeroCbte } from '../../../src/modules/pagos/lectura/fusion.js'
import type { LecturaIA } from '../../../src/modules/pagos/lectura/ia.js'
import { importesEfectivos, validarImportes, valorComparable } from '../../../src/modules/pagos/pagos.service.js'
import { camposEditados } from '../../../src/modules/pagos/lectura.service.js'
import { CreateFacturaSchema } from '../../../src/modules/pagos/pagos.schema.js'

const qrJson = {
  ver: 1, fecha: '2026-09-18', cuit: 30590360763, ptoVta: 8837, tipoCmp: 1, nroCmp: 4557,
  importe: 152609.59, moneda: 'PES', ctz: 1, tipoDocRec: 80, nroDocRec: 33717191949,
  tipoCodAut: 'E', codAut: 76384512345678,
}
const url = (o: unknown) => 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(o)).toString('base64')

describe('parsearQrArca', () => {
  it('lee el QR normal', () => {
    const q = parsearQrArca(url(qrJson))!
    expect(q.cuit).toBe('30590360763')
    expect(q.ptoVta).toBe(8837)
    expect(q.nroCmp).toBe(4557)
    expect(q.importe).toBe(152609.59)
    expect(q.nroDocRec).toBe(CUIT_CADINC)
    expect(q.codAut).toBe('76384512345678')
    expect(q.fecha).toBe('2026-09-18')
  })
  it('tolera base64url sin padding y la URL codificada', () => {
    const b64 = Buffer.from(JSON.stringify(qrJson)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(parsearQrArca(`https://serviciosweb.afip.gob.ar/genericos/comprobantes/cae.aspx?p=${encodeURIComponent(b64)}`)?.cuit).toBe('30590360763')
  })
  it('tolera JSON con comillas simples', () => {
    const roto = "{'ver':1,'fecha':'2026-09-18','cuit':30590360763,'ptoVta':12,'tipoCmp':6,'nroCmp':99,'importe':100.5,'moneda':'PES'}"
    const q = parsearQrArca('https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(roto).toString('base64'))
    expect(q?.tipoCmp).toBe(6)
    expect(q?.importe).toBe(100.5)
  })
  it('null si no es un QR de ARCA', () => {
    expect(parsearQrArca('https://mercadopago.com/xyz')).toBeNull()
    expect(parsearQrArca('')).toBeNull()
    expect(parsearQrArca(url({ foo: 1 }))).toBeNull()
  })
})

describe('códigos ARCA', () => {
  it('tipo de comprobante', () => {
    expect(tipoDesdeArca(1)).toEqual({ tipo: 'A', esNotaCredito: false })
    expect(tipoDesdeArca(6)?.tipo).toBe('B')
    expect(tipoDesdeArca(11)?.tipo).toBe('C')
    expect(tipoDesdeArca(51)?.tipo).toBe('A')
    expect(tipoDesdeArca(3)).toEqual({ tipo: 'A', esNotaCredito: true })
    expect(tipoDesdeArca(4)?.tipo).toBe('recibo')
    expect(tipoDesdeArca(999)).toBeNull()
    expect(arcaDesdeLetra('A', 'factura')).toBe(1)
    expect(arcaDesdeLetra('B', 'nota_credito')).toBe(8)
    expect(arcaDesdeLetra('C', 'recibo')).toBe(15)
  })
  it('alícuotas', () => {
    expect(alicuotaIdDe(21)).toBe(5)
    expect(alicuotaIdDe(10.5)).toBe(4)
    expect(alicuotaIdDe(27)).toBe(6)
    expect(alicuotaIdDe(0)).toBe(3)
    expect(alicuotaIdDe(19)).toBeNull()
  })
  it('formato de número', () => {
    expect(fmtPuntoVenta(11)).toBe('00011')
    expect(fmtPuntoVenta('0012')).toBe('00012')
    expect(fmtNumeroCbte('194')).toBe('00000194')
  })
})

const iaBase: LecturaIA = {
  legible: true,
  emisor_cuit: '30-59036076-3', emisor_razon_social: 'Cencosud S.A.',
  receptor_cuit: '33717191949', receptor_razon_social: 'CADINC SRL',
  letra: 'A', clase: 'factura', codigo_comprobante: 1,
  punto_venta: '08837', numero: '00004557',
  fecha_emision: '18/09/2026', fecha_vencimiento_pago: null,
  cae: '76384512345678', cae_vencimiento: '2026-09-28', moneda: null,
  neto_gravado_total: 120000, no_gravado: null, exento: null,
  iva: [{ alicuota_pct: 21, base_imponible: 120000, importe: 25200 }],
  tributos: [
    { tipo: 'percepcion_iibb', jurisdiccion: 'Tucumán', descripcion: 'Perc. IIBB Tucumán', alicuota_pct: 3.5, base_imponible: 120000, importe: 4200 },
    { tipo: 'percepcion_iva', jurisdiccion: null, descripcion: 'Perc. IVA RG 2408', alicuota_pct: 3, base_imponible: 120000, importe: 3209.59 },
  ],
  total: 152609.59, comprobantes_asociados: [], detalle_breve: 'Materiales de ferretería', concepto_id: 2, notas: null,
}

describe('fusionar', () => {
  it('QR + IA coinciden: todo qr+ia y sin errores', () => {
    const r = fusionar(parsearQrArca(url(qrJson)), iaBase, { hoy: '2026-09-24' })
    expect(r.estado).toBe('qr+ia')
    expect(r.propuesta.emisor_cuit).toBe('30590360763')
    expect(r.propuesta.tipo_comprobante).toBe('A')
    expect(r.propuesta.punto_venta).toBe('08837')
    expect(r.propuesta.numero_comprobante).toBe('00004557')
    expect(r.propuesta.fecha).toBe('2026-09-18')
    expect(r.propuesta.iva).toEqual([{ alicuota_id: 5, base_imp: 120000, importe: 25200 }])
    expect(r.propuesta.tributos).toHaveLength(2)
    expect(r.fuente_por_campo.total).toBe('qr+ia')
    expect(r.fuente_por_campo.iva).toBe('ia')
    expect(r.avisos.filter((a) => a.severidad === 'error')).toEqual([])
  })
  it('el QR manda y avisa si la IA leyó otro total', () => {
    const r = fusionar(parsearQrArca(url(qrJson)), { ...iaBase, total: 152690.59 }, { hoy: '2026-09-24' })
    expect(r.propuesta.total).toBe(152609.59)
    expect(r.fuente_por_campo.total).toBe('qr')
    expect(r.avisos.some((a) => a.campo === 'total' && a.severidad === 'error')).toBe(true)
  })
  it('neto vs bases: unos centavos de redondeo no avisan, una diferencia real sí', () => {
    const dos = [{ alicuota_pct: 21, base_imponible: 147518.84, importe: 30978.96 }, { alicuota_pct: 10.5, base_imponible: 6196.50, importe: 650.63 }]
    const casi = fusionar(null, { ...iaBase, tributos: [], neto_gravado_total: 153715.32, iva: dos, total: 185344.91 }, { hoy: '2026-09-25' })
    expect(casi.avisos.some((a) => a.codigo === 'NETO_DISTINTO_DE_BASES')).toBe(false)
    const lejos = fusionar(null, { ...iaBase, tributos: [], neto_gravado_total: 153000, iva: dos, total: 185344.91 }, { hoy: '2026-09-25' })
    expect(lejos.avisos.some((a) => a.codigo === 'NETO_DISTINTO_DE_BASES')).toBe(true)
  })
  it('no cierra → error en total', () => {
    const r = fusionar(null, { ...iaBase, tributos: [] }, { hoy: '2026-09-24' })
    expect(r.estado).toBe('ia')
    expect(r.avisos.some((a) => a.codigo === 'NO_CIERRA' && a.severidad === 'error')).toBe(true)
    expect(r.avisos.some((a) => a.codigo === 'SIN_QR')).toBe(true)
  })
  it('receptor que no es CADINC → error', () => {
    const r = fusionar(parsearQrArca(url({ ...qrJson, nroDocRec: 20111111112 })), iaBase, { hoy: '2026-09-24' })
    expect(r.avisos.some((a) => a.codigo === 'RECEPTOR_NO_ES_CADINC')).toBe(true)
  })
  it('nota de crédito: aviso INFORMATIVO (se carga como NC, 20260925a) y la propuesta lleva clase', () => {
    const r = fusionar(parsearQrArca(url({ ...qrJson, tipoCmp: 3 })), null, { hoy: '2026-09-24' })
    expect(r.estado).toBe('qr')
    expect(r.avisos.find((a) => a.codigo === 'ES_NOTA_DE_CREDITO')?.severidad).toBe('info')
    expect(r.propuesta.clase).toBe('nota_credito')
    expect(r.propuesta.tipo_comprobante).toBe('A')
  })
  it('una factura lleva clase factura y sin asociados, aunque la IA invente alguno', () => {
    const r = fusionar(parsearQrArca(url(qrJson)), { ...iaBase, comprobantes_asociados: [{ letra: 'A', punto_venta: '1', numero: '45' }] }, { hoy: '2026-09-24' })
    expect(r.propuesta.clase).toBe('factura')
    expect(r.propuesta.comprobantes_asociados).toEqual([])
  })
  it('NC leída por la IA (sin QR): clase por letra + clase, y los asociados normalizados', () => {
    const r = fusionar(null, {
      ...iaBase, clase: 'nota_credito', codigo_comprobante: null, numero: '00000012',
      comprobantes_asociados: [{ letra: 'A', punto_venta: '0001', numero: '45' }, { letra: 'A', punto_venta: null, numero: null }],
    }, { hoy: '2026-09-24' })
    expect(r.propuesta.cbte_tipo_arca).toBe(3)
    expect(r.propuesta.clase).toBe('nota_credito')
    expect(r.propuesta.comprobantes_asociados).toEqual([{ letra: 'A', punto_venta: '00001', numero: '00000045' }])
    expect(r.avisos.some((a) => a.severidad === 'error' && a.codigo === 'ES_NOTA_DE_CREDITO')).toBe(false)
  })
  it('duplicada: el mensaje dice «nota de crédito» si es NC', () => {
    const p = fusionar(parsearQrArca(url({ ...qrJson, tipoCmp: 3 })), null, { hoy: '2026-09-24' }).propuesta
    const av = controlesDeContexto(p, { proveedor: { id: 1, razon_social: 'X', activo: true }, duplicadas: [{ id: 9, numero: 'x', estado: 'aprobada' }], archivoRepetido: null })
    expect(av.find((a) => a.codigo === 'FACTURA_YA_CARGADA')?.mensaje).toMatch(/^Esta nota de crédito/)
  })
  it('sin IA: lo del QR y aviso', () => {
    const r = fusionar(parsearQrArca(url(qrJson)), null, { hoy: '2026-09-24' })
    expect(r.propuesta.total).toBe(152609.59)
    expect(r.propuesta.cae).toBe('76384512345678')
    expect(r.avisos.some((a) => a.codigo === 'SIN_LECTURA_IA')).toBe(true)
  })
  it('dos renglones de la misma alícuota se suman; alícuota rara se avisa', () => {
    const r = fusionar(null, {
      ...iaBase, tributos: [], total: 1210 + 121 + 50,
      neto_gravado_total: 1100,
      iva: [
        { alicuota_pct: 21, base_imponible: 1000, importe: 210 },
        { alicuota_pct: 21, base_imponible: 100, importe: 21 },
        { alicuota_pct: 19, base_imponible: 50, importe: 50 },
      ],
    }, { hoy: '2026-09-24' })
    expect(r.propuesta.iva).toEqual([{ alicuota_id: 5, base_imp: 1100, importe: 231 }])
    expect(r.avisos.some((a) => a.codigo === 'ALICUOTA_DESCONOCIDA')).toBe(true)
  })
})

describe('controlesDeContexto', () => {
  const p = fusionar(parsearQrArca(url(qrJson)), iaBase, { hoy: '2026-09-24' }).propuesta
  it('proveedor nuevo, duplicada y archivo repetido', () => {
    const av = controlesDeContexto(p, { proveedor: null, duplicadas: [{ id: 11, numero: '08837-00004557', estado: 'pagada' }], archivoRepetido: { factura_id: 11 } })
    expect(av.map((a) => a.codigo).sort()).toEqual(['ARCHIVO_YA_CARGADO', 'FACTURA_YA_CARGADA', 'PROVEEDOR_NUEVO'])
  })
  it('proveedor conocido y activo: sin avisos', () => {
    expect(controlesDeContexto(p, { proveedor: { id: 3, razon_social: 'Cencosud', activo: true }, duplicadas: [], archivoRepetido: null })).toEqual([])
  })
})

describe('importes con desglose', () => {
  const base = {
    fecha: '2026-09-18', total: 1240, neto: null, iva: null,
    iva_detalle: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }],
    tributos: [{ tipo: 'percepcion_iibb', importe: 30 }],
  }
  it('deriva neto, IVA y percepciones como la base', () => {
    const e = importesEfectivos(base)
    expect([e.neto, e.iva, e.percepciones, e.otros]).toEqual([1000, 210, 30, null])
  })
  it('imputable = total − percepciones (las percepciones no se reparten)', () => {
    expect(() => validarImportes(base, [{ obra_cod: 'X', monto: 1210, obs: '' }], { validarFecha: false })).not.toThrow()
    expect(() => validarImportes(base, [{ obra_cod: 'X', monto: 1240, obs: '' }], { validarFecha: false })).toThrow('IMPUTACION_NO_CUADRA')
  })
  it('no gravado y exento entran en el cierre', () => {
    expect(() => validarImportes({ ...base, total: 1340, no_gravado: 60, exento: 40 }, null, { validarFecha: false })).not.toThrow()
    expect(() => validarImportes({ ...base, total: 1340 }, null, { validarFecha: false })).toThrow('DESGLOSE_NO_CUADRA')
  })
  it('impuestos internos van a otros', () => {
    const e = importesEfectivos({ ...base, tributos: [{ tipo: 'impuestos_internos', importe: 30 }] })
    expect([e.percepciones, e.otros]).toEqual([null, 30])
  })
  it('valorComparable', () => {
    expect(valorComparable('1000.00')).toBe(valorComparable(1000))
    expect(valorComparable(null)).toBe(valorComparable(undefined))
  })
})

describe('schema', () => {
  const ok = {
    proveedor_id: 1, tipo_comprobante: 'A', numero: '0001-00000001', fecha: '2026-09-18', total: 1240,
    descripcion: 'algo', concepto_id: 2, imputaciones: [{ obra_cod: 'X', monto: 1210 }],
  }
  it('acepta el desglose y rechaza alícuotas repetidas o inválidas', () => {
    expect(CreateFacturaSchema.safeParse({ ...ok, iva_detalle: [{ alicuota_id: 5, base_imp: 1000, importe: 210 }] }).success).toBe(true)
    expect(CreateFacturaSchema.safeParse({ ...ok, iva_detalle: [{ alicuota_id: 5, base_imp: 1, importe: 1 }, { alicuota_id: 5, base_imp: 1, importe: 1 }] }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...ok, iva_detalle: [{ alicuota_id: 7, base_imp: 1, importe: 1 }] }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...ok, cae: '123' }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...ok, cbte_tipo_arca: 1, tributos: [{ tipo: 'percepcion_iibb', jurisdiccion: 'Tucumán', importe: 30 }] }).success).toBe(true)
  })
})

describe('camposEditados', () => {
  it('marca lo que la persona cambió de la propuesta', () => {
    const p = fusionar(parsearQrArca(url(qrJson)), iaBase, { hoy: '2026-09-24' }).propuesta
    expect(camposEditados(p, {
      numero: '8837-4557', fecha: '2026-09-18', total: 152609.59, tipo_comprobante: 'A',
      iva: p.iva, tributos: p.tributos,
    })).toEqual([])
    expect(camposEditados(p, {
      numero: '8837-4558', fecha: '2026-09-17', total: 152609.59, tipo_comprobante: 'A', iva: [], tributos: p.tributos,
    })).toEqual(['numero', 'fecha', 'iva'])
  })
})

describe('QR reales mal armados (prueba del 24/09)', () => {
  it('importe con ceros a la izquierda = centavos, y JSON roto', () => {
    const raw = '{"ver":1,"fecha":"2026-09-21","cuit":30542851836,"ptoVta":0012,"tipoCmp":01,"nroCmp":00402141,"importe":000000013838240,"moneda":"PES","ctz":1,"tipoDocRec":80,"nroDocRec":33717191949,"tipoCodAut"="E"."codAut":86384033085212}'
    const q = parsearQrArca('https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(raw).toString('base64'))!
    expect(q.importe).toBe(138382.4)
    expect(q.ptoVta).toBe(12)
    expect(q.nroCmp).toBe(402141)
    expect(q.codAut).toBe('86384033085212')
  })
  it('importe en centavos sin ceros: se corrige con el total del papel', () => {
    const r = fusionar(parsearQrArca(url({ ...qrJson, importe: 15260959 })), iaBase, { hoy: '2026-09-24' })
    expect(r.propuesta.total).toBe(152609.59)
    expect(r.avisos.some((a) => a.codigo === 'QR_IMPORTE_EN_CENTAVOS')).toBe(true)
    expect(r.avisos.some((a) => a.severidad === 'error')).toBe(false)
  })
  it('QR con otro total y el desglose del papel cierra con el papel: manda el papel', () => {
    const r = fusionar(parsearQrArca(url({ ...qrJson, importe: 150000 })), iaBase, { hoy: '2026-09-24' })
    expect(r.propuesta.total).toBe(152609.59)
    expect(r.avisos.some((a) => a.codigo === 'QR_TOTAL_NO_CIERRA')).toBe(true)
  })
  it('número distinto: manda el QR pero es error', () => {
    const r = fusionar(parsearQrArca(url({ ...qrJson, nroCmp: 455 })), iaBase, { hoy: '2026-09-24' })
    expect(r.propuesta.numero_comprobante).toBe('00000455')
    expect(r.avisos.find((a) => a.campo === 'numero_comprobante')?.severidad).toBe('error')
  })
})
