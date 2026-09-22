import { describe, it, expect } from 'vitest'
import { armarCuerpo } from '../../../src/modules/pagos/aviso-pago.cuerpo.js'
import { esEmailValido } from '../../../src/lib/mail.js'

// El aviso de pago sale a TERCEROS (proveedor y estudio contable), así que lo
// que dice el cuerpo se testea: es lo único del sistema que ve alguien de
// afuera, y un mail no se desmanda.

const ORDEN = {
  numero: 8, numero_fmt: 'OP-0008', fecha: '2026-09-21', forma_pago: 'echeq',
  monto_pagado: 24995, referencia: 'LR9MLw0702',
  proveedor_nom: 'NORTE DISTRIBUCIONES SRL', proveedor_cuit: '30714014346',
  cbu_destino: '0070399520000003055000', alias_destino: 'norte.distrib',
}
const FACTURAS = [{ tipo_comprobante: 'A', numero: '00011-00000194', fecha: '2026-08-18', aplicado: 24995 }]
const CHEQUES = [{ numero: '3055', banco: 'Galicia', fecha_cobro: '2026-10-21', monto: 24995 }]

describe('armarCuerpo', () => {
  it('el CBU NUNCA va en el cuerpo, ni al proveedor ni al contador', () => {
    // Poner la cuenta en un mail regala el dato que sirve para estafar
    // («cambió nuestro CBU, pagá acá»). El proveedor ya sabe su cuenta.
    for (const para of ['proveedor', 'contador'] as const) {
      const c = armarCuerpo(para, ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
      for (const texto of [c.html, c.texto, c.asunto]) {
        expect(texto).not.toContain('0070399520000003055000')
        expect(texto).not.toContain('norte.distrib')
      }
    }
  })

  it('el asunto dice de qué se trata y cuánto, sin abrirlo', () => {
    const c = armarCuerpo('proveedor', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
    expect(c.asunto).toContain('OP-0008')
    expect(c.asunto).toContain('24.995,00')
  })

  it('siempre hay versión en texto plano, no sólo html', () => {
    const c = armarCuerpo('contador', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
    expect(c.texto.length).toBeGreaterThan(50)
    expect(c.texto).not.toContain('<div')
  })

  it('lista las facturas cubiertas con lo aplicado a cada una', () => {
    const c = armarCuerpo('contador', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
    expect(c.texto).toContain('00011-00000194')
    expect(c.texto).toContain('24.995,00')
  })

  it('en un pago parcial muestra lo aplicado, no el total de la factura', () => {
    const c = armarCuerpo('proveedor', { ...ORDEN, monto_pagado: 10000 },
      [{ ...FACTURAS[0]!, aplicado: 10000 }], [], 'CADINC SRL')
    expect(c.texto).toContain('10.000,00')
  })

  it('los cheques van con su fecha de cobro: es lo que el proveedor pregunta', () => {
    const c = armarCuerpo('proveedor', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
    expect(c.html).toContain('3055')
    expect(c.html).toContain('21/10/2026')
  })

  it('sin cheques no aparece la sección vacía', () => {
    const c = armarCuerpo('proveedor', { ...ORDEN, forma_pago: 'transferencia' }, FACTURAS, [], 'CADINC SRL')
    expect(c.html).not.toContain('Cheque')
  })

  it('escapa lo que viene de la base: un nombre con < no puede romper el html', () => {
    const c = armarCuerpo('contador', { ...ORDEN, proveedor_nom: 'A <script>x</script> SRL' }, [], [], 'CADINC SRL')
    expect(c.html).not.toContain('<script>')
    expect(c.html).toContain('&lt;script&gt;')
  })

  it('la forma de pago se lee en castellano, no el código', () => {
    expect(armarCuerpo('proveedor', ORDEN, [], [], 'CADINC SRL').html).toContain('E-cheq')
    expect(armarCuerpo('proveedor', { ...ORDEN, forma_pago: 'debito_automatico' }, [], [], 'CADINC SRL').html)
      .toContain('Débito automático')
  })
})

describe('esEmailValido', () => {
  it('acepta direcciones normales', () => {
    expect(esEmailValido('contador@cadinc.com.ar')).toBe(true)
    expect(esEmailValido('elfontanerogalpon@gmail.com')).toBe(true)
  })

  it('rechaza lo que no es una dirección', () => {
    for (const v of ['', '   ', 'sinarroba', 'a@b', 'a@@b.com', 'dos@direcciones.com, otra@x.com',
                     'con espacio@x.com', null, undefined]) {
      expect(esEmailValido(v as string)).toBe(false)
    }
  })

  it('no acepta punto y coma ni coma: son dos destinatarios disfrazados de uno', () => {
    expect(esEmailValido('a@x.com;b@y.com')).toBe(false)
  })
})
