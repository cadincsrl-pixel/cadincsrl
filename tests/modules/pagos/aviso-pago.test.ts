import { describe, it, expect } from 'vitest'
import { armarCuerpo, armarPrueba, pieConCbu } from '../../../src/modules/pagos/aviso-pago.cuerpo.js'
import { esEmailValido, parsearFrom, armarFrom, fromComoTexto } from '../../../src/lib/mail.js'
import { comprobantesDelAviso, destinatariosProveedor } from '../../../src/modules/pagos/aviso-pago.cuerpo.js'

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
  it('con NC aplicadas a la factura dice «menos NC aplicadas $X» sin tocar el importe; sin NC no dice nada', () => {
    const c = armarCuerpo('proveedor', ORDEN, [{ ...FACTURAS[0]!, nc_aplicadas: 5005 }], CHEQUES, 'CADINC SRL')
    expect(c.texto).toContain('menos NC aplicadas $5.005,00')
    expect(c.html).toContain('menos NC aplicadas $5.005,00')
    expect(c.texto).toContain('Importe: $24.995,00')
    const sin = armarCuerpo('proveedor', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
    expect(sin.texto).not.toContain('NC aplicadas')
  })

  it('el CBU NUNCA va en el cuerpo, ni al proveedor ni al contador', () => {
    // Poner la cuenta en un mail regala el dato que sirve para estafar
    // («cambió nuestro CBU, pagá acá»). El proveedor ya sabe su cuenta.
    for (const para of ['proveedor', 'contador', 'compras'] as const) {
      const c = armarCuerpo(para, ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
      for (const texto of [c.html, c.texto, c.asunto]) {
        expect(texto).not.toContain('0070399520000003055000')
        expect(texto).not.toContain('norte.distrib')
      }
    }
  })

  it('el CBU tampoco entra por el pie: un pie con CBU o alias no se imprime', () => {
    for (const pie of ['Pagar al 0070399520000003055000', 'CBU 0070 3995 2000 0003 0550 00', 'alias norte.distrib']) {
      for (const para of ['proveedor', 'contador', 'compras'] as const) {
        const c = armarCuerpo(para, ORDEN, FACTURAS, CHEQUES, 'CADINC SRL', { pie })
        for (const texto of [c.html, c.texto, c.asunto]) {
          expect(texto).not.toContain('0070399520000003055000')
          expect(texto).not.toContain('0070 3995')
          expect(texto).not.toContain('norte.distrib')
        }
      }
    }
  })

  it('el pie se imprime escapado, en html y en texto', () => {
    const pie = 'Consultas: pagos@cadinc.com.ar · www.cadinc.com.ar <b>x</b>'
    const c = armarCuerpo('proveedor', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL', { pie })
    expect(c.texto).toContain(pie)
    expect(c.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(c.html).not.toContain('<b>x</b>')
    const sin = armarCuerpo('proveedor', ORDEN, FACTURAS, CHEQUES, 'CADINC SRL')
    expect(sin.texto).not.toContain('Consultas')
    expect(armarPrueba('CADINC', pie).html).toContain('&lt;b&gt;')
  })

  it('pieConCbu: CBU/CVU y alias sí; dominios, mails, teléfonos y palabras comunes no', () => {
    expect(pieConCbu('0070399520000003055000')).toBe(true)
    expect(pieConCbu('0070-3995-2000-0003-0550-00')).toBe(true)
    expect(pieConCbu('Alias: Norte.Distrib.')).toBe(true)
    expect(pieConCbu('Consultas: pagos@cadinc.com.ar o www.cadinc.com.ar')).toBe(false)
    expect(pieConCbu('Tel 381-4123456, de lunes-viernes. Gracias por su atención')).toBe(false)
    expect(pieConCbu('')).toBe(false)
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

describe('destinatariosProveedor (varios contactos, 20260925e)', () => {
  const contactos = [
    { email: 'Adm@Prov.com', recibe_avisos: true },
    { email: 'vendedor@prov.com', recibe_avisos: false },
    { email: 'pagos@prov.com', recibe_avisos: true },
  ]
  it('sin elegir: los que reciben avisos, en minúscula', () => {
    expect(destinatariosProveedor({ pedidos: [], contactos, delPadron: '' }).emails).toEqual(['adm@prov.com', 'pagos@prov.com'])
  })
  it('lo elegido para este envío manda, sin repetir', () => {
    const r = destinatariosProveedor({ pedidos: ['vendedor@prov.com', 'VENDEDOR@prov.com', 'nuevo@prov.com'], contactos, delPadron: '' })
    expect(r.emails).toEqual(['vendedor@prov.com', 'nuevo@prov.com'])
    expect(r.conocidos.has('nuevo@prov.com')).toBe(false)
  })
  it('sin contactos con aviso: el email viejo del padrón; sin nada: vacío', () => {
    expect(destinatariosProveedor({ pedidos: [], contactos: [], delPadron: ' Viejo@Prov.com ' }).emails).toEqual(['viejo@prov.com'])
    expect(destinatariosProveedor({ pedidos: [], contactos: [{ email: 'x@y.com', recibe_avisos: false }], delPadron: '' }).emails).toEqual([])
    // Con contactos y todos destildados, NO cae al email viejo del padrón.
    expect(destinatariosProveedor({ pedidos: [], contactos: [{ email: 'x@y.com', recibe_avisos: false }], delPadron: 'viejo@p.com' }).emails).toEqual([])
  })
})

describe('From del mail', () => {
  it('parsea SMTP_FROM con y sin nombre', () => {
    expect(parsearFrom('pagos@cadinc.com.ar')).toEqual({ nombre: '', direccion: 'pagos@cadinc.com.ar' })
    expect(parsearFrom('CADINC SRL <pagos@cadinc.com.ar>')).toEqual({ nombre: 'CADINC SRL', direccion: 'pagos@cadinc.com.ar' })
    expect(parsearFrom('"CADINC, SRL" <pagos@cadinc.com.ar>')).toEqual({ nombre: 'CADINC, SRL', direccion: 'pagos@cadinc.com.ar' })
  })
  it('la dirección sale SIEMPRE del env; el nombre, del configurado o del que traía SMTP_FROM', () => {
    expect(armarFrom('CADINC SRL <pagos@cadinc.com.ar>', 'CADINC Pagos')).toEqual({ name: 'CADINC Pagos', address: 'pagos@cadinc.com.ar' })
    expect(armarFrom('CADINC SRL <pagos@cadinc.com.ar>', null)).toEqual({ name: 'CADINC SRL', address: 'pagos@cadinc.com.ar' })
    expect(armarFrom('pagos@cadinc.com.ar', undefined)).toEqual({ name: '', address: 'pagos@cadinc.com.ar' })
    expect(fromComoTexto(armarFrom('pagos@cadinc.com.ar', 'CADINC Pagos'))).toBe('"CADINC Pagos" <pagos@cadinc.com.ar>')
  })
  it('el nombre no puede inyectar encabezados ni cambiar la dirección', () => {
    const f = armarFrom('pagos@cadinc.com.ar', 'X\r\nBcc: robo@x.com "<otro@x.com>"')
    expect(f.address).toBe('pagos@cadinc.com.ar')
    expect(f.name).not.toMatch(/[\r\n<>"]/)
  })
})

describe('comprobantesDelAviso (20260929w)', () => {
  const ADJ = [
    { tipo: 'cheque', nombre_archivo: 'cheque-3079.pdf' },
    { tipo: 'recibo_proveedor', nombre_archivo: 'recibo.pdf' },
    { tipo: 'otro', nombre_archivo: 'otro.pdf' },
    { tipo: 'nota_credito', nombre_archivo: 'nc.pdf' },
  ]
  it('e-cheq pagado solo con el PDF del echeq (caso OP-0250): el mail lleva ese PDF como comprobante', () => {
    expect(comprobantesDelAviso('echeq', ADJ).map((a) => a.nombre_archivo)).toEqual(['cheque-3079.pdf'])
  })
  it('cheque físico: la foto del cheque también es la prueba del pago', () => {
    expect(comprobantesDelAviso('cheque', [...ADJ, { tipo: 'comprobante_pago', nombre_archivo: 'c.pdf' }]).map((a) => a.nombre_archivo))
      .toEqual(['cheque-3079.pdf', 'c.pdf'])
  })
  it('transferencia: solo el comprobante; nunca el recibo, la NC ni «otro»', () => {
    expect(comprobantesDelAviso('transferencia', [...ADJ, { tipo: 'comprobante_pago', nombre_archivo: 'c.pdf' }]).map((a) => a.nombre_archivo))
      .toEqual(['c.pdf'])
    expect(comprobantesDelAviso(null, ADJ)).toEqual([])
  })
})
