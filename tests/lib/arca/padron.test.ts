// Padrón A5 (getPersona_v2), fase 7. Los fixtures son respuestas REALES de
// homologación del 2026-09-23 (scripts/arca-completar-domicilios.ts
// --cuit=… --fixtures). En homologación ARCA ya devuelve los nombres
// desfigurados; se recortaron las actividades (ARCOR trae 30).
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parsearGetPersona, sobreGetPersona, deducirCondicionIva, domicilioEnLinea, nombrePropio,
  type PadronImpuesto,
} from '../../../src/lib/arca/padron.js'
import { ArcaError } from '../../../src/lib/arca/errores.js'
import { cambiosDesdePadron, domicilioDePadron, errorPadron, precargaDe, provinciaDePadron } from '../../../src/modules/facturacion/padron.service.js'

// padron.service importa lib/supabase, que exige las env vars al importarse.
vi.mock('../../../src/lib/supabase.js', () => ({ supabase: {}, createSupabaseClient: () => ({}) }))

const fx = (cuit: string) => readFileSync(path.join(__dirname, 'fixtures', `getPersona_v2-homo-${cuit}.xml`), 'utf8')

function capturar(fn: () => unknown): ArcaError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ArcaError) return e
    throw e
  }
  throw new Error('no lanzó')
}

const imp = (id: number, estado = 'AC'): PadronImpuesto => ({ id, descripcion: '', estado, periodo: null })

describe('sobreGetPersona', () => {
  it('raíz con namespace, hijos sin prefijo, CUIT de CADINC como representada', () => {
    const s = sobreGetPersona({ token: 'T<', sign: 'S', expiraAt: new Date() }, '33-71719194-9', '30-50279317-5')
    expect(s).toContain('<a5:getPersona_v2>')
    expect(s).toContain('xmlns:a5="http://a5.soap.ws.server.puc.sr/"')
    expect(s).toContain('<token>T&lt;</token><sign>S</sign>')
    expect(s).toContain('<cuitRepresentada>33717191949</cuitRepresentada>')
    expect(s).toContain('<idPersona>30502793175</idPersona>')
  })

  it('CUIT que no tiene 11 dígitos → ARCA_PADRON_CUIT_INVALIDO', () => {
    const e = capturar(() => sobreGetPersona({ token: 'T', sign: 'S', expiraAt: new Date() }, '33717191949', '123'))
    expect(e.codigo).toBe('ARCA_PADRON_CUIT_INVALIDO')
  })
})

describe('parsearGetPersona', () => {
  it('persona jurídica RI: razón social, domicilio fiscal, IVA activo → 1', () => {
    const p = parsearGetPersona(fx('30502793175'), '30502793175')
    expect(p).toMatchObject({
      cuit: '30502793175', tipo_persona: 'JURIDICA', estado_clave: 'ACTIVO',
      domicilio_fiscal: { direccion: 'AV FULVIO S PAGANI 844', localidad: 'ARROYITO', cod_postal: '2434', provincia: 'CORDOBA', id_provincia: 3 },
      condicion_iva_id: 1, condicion_iva_dudosa: false, es_monotributo: false, es_exento: false,
    })
    expect(p.razon_social.length).toBeGreaterThan(2)
    expect(p.impuestos.some((i) => i.id === 30 && i.estado === 'AC')).toBe(true)
    expect(p.actividades.map((a) => a.orden)).toEqual([...p.actividades.map((a) => a.orden)].sort((a, b) => (a ?? 0) - (b ?? 0)))
    expect(p.actividades.length).toBeGreaterThan(0)
    expect(p.avisos).toEqual([])
    expect(domicilioDePadron(p)).toEqual({ domicilio: 'AV FULVIO S PAGANI 844 - ARROYITO (CP 2434)', provincia: 'Cordoba' })
  })

  it('CABA: sin localidad', () => {
    const p = parsearGetPersona(fx('30500010084'), '30500010084')
    expect(domicilioDePadron(p)).toEqual({ domicilio: 'SARMIENTO 441 (CP 1041)', provincia: 'Capital Federal' })
  })

  it('persona física con monotributo social E IVA: sugiere 1 pero dudosa; razón social = apellido y nombre', () => {
    const p = parsearGetPersona(fx('20000000001'), '20000000001')
    expect(p.tipo_persona).toBe('FISICA')
    expect(p.razon_social).toBe('SKRORPIOPRP SPRAGI')
    expect(p.es_monotributo).toBe(true)
    expect(p.categoria_monotributo).toContain('SOCIAL')
    expect(p.condicion_iva_id).toBe(1)
    expect(p.condicion_iva_dudosa).toBe(true)
    expect(p.actividades[0]?.id).toBe(772099)
  })

  it('persona física sin ningún régimen (respuesta REAL de producción, redactada) → 5 dudosa', () => {
    const xml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn>' +
      '<datosGenerales><apellido>APELLIDO</apellido><domicilioFiscal><codPostal>4000</codPostal><descripcionProvincia>TUCUMAN</descripcionProvincia>' +
      '<direccion>CALLE 123</direccion><idProvincia>14</idProvincia><localidad>SAN MIGUEL DE TUCUMAN</localidad><tipoDomicilio>FISCAL</tipoDomicilio></domicilioFiscal>' +
      '<esSucesion>NO</esSucesion><estadoClave>ACTIVO</estadoClave><idPersona>20000000001</idPersona><mesCierre>12</mesCierre><nombre>NOMBRE</nombre>' +
      '<tipoClave>CUIT</tipoClave><tipoPersona>FISICA</tipoPersona></datosGenerales><metadata><fechaHora>2026-09-23T21:47:24.395-03:00</fechaHora>' +
      '<servidor>x</servidor></metadata></personaReturn></ns2:getPersona_v2Response></soap:Body></soap:Envelope>'
    const p = parsearGetPersona(xml, '20000000001')
    expect(p).toMatchObject({ razon_social: 'APELLIDO NOMBRE', condicion_iva_id: 5, condicion_iva_dudosa: true, impuestos: [] })
    expect(domicilioDePadron(p)).toEqual({ domicilio: 'CALLE 123 - SAN MIGUEL DE TUCUMAN (CP 4000)', provincia: 'Tucuman' })
  })

  it('CUIT inexistente (SOAP Fault) → ARCA_PADRON_CUIT_INEXISTENTE', () => {
    const e = capturar(() => parsearGetPersona(fx('33717191949'), '33717191949', 500))
    expect(e.codigo).toBe('ARCA_PADRON_CUIT_INEXISTENTE')
    expect(e.quizasLlego).toBe(false)
    expect(e.errores[0]?.msg).toBe('No existe persona con ese Id')
  })

  it('sin constancia por actividades fuera del nomenclador → ARCA_PADRON_SIN_DATOS con el texto de ARCA', () => {
    const e = capturar(() => parsearGetPersona(fx('20111111112'), '20111111112'))
    expect(e.codigo).toBe('ARCA_PADRON_SIN_DATOS')
    expect(e.message).toContain('nomenclador')
  })

  it('CUIT cancelada → ARCA_PADRON_CLAVE_INACTIVA', () => {
    expect(capturar(() => parsearGetPersona(fx('20000000028'), '20000000028')).codigo).toBe('ARCA_PADRON_CLAVE_INACTIVA')
  })
})

describe('deducirCondicionIva', () => {
  it('IVA activo → 1', () => {
    expect(deducirCondicionIva({ impuestos: [imp(30)], tieneMonotributo: false })).toMatchObject({ id: 1, dudosa: false })
  })
  it('IVA dado de baja no cuenta', () => {
    expect(deducirCondicionIva({ impuestos: [imp(30, 'BD')], tieneMonotributo: false })).toMatchObject({ id: 5, dudosa: true })
  })
  it('monotributo → 6; social → 13 dudosa; promovido → 16 dudosa', () => {
    expect(deducirCondicionIva({ impuestos: [imp(20)], tieneMonotributo: true })).toMatchObject({ id: 6, dudosa: false, es_monotributo: true })
    expect(deducirCondicionIva({ impuestos: [], tieneMonotributo: true, categoriaMonotributo: 'A MONOTRIBUTO SOCIAL' })).toMatchObject({ id: 13, dudosa: true })
    expect(deducirCondicionIva({ impuestos: [], tieneMonotributo: true, categoriaMonotributo: 'PROMOVIDO' })).toMatchObject({ id: 16, dudosa: true })
  })
  it('IVA exento → 4; no alcanzado → 15 dudosa; nada → 5 dudosa', () => {
    expect(deducirCondicionIva({ impuestos: [imp(32), imp(10)], tieneMonotributo: false })).toMatchObject({ id: 4, dudosa: false, es_exento: true })
    expect(deducirCondicionIva({ impuestos: [imp(34)], tieneMonotributo: false })).toMatchObject({ id: 15, dudosa: true })
    expect(deducirCondicionIva({ impuestos: [imp(10)], tieneMonotributo: false })).toMatchObject({ id: 5, dudosa: true })
  })
  it('clave no ACTIVA → dudosa aunque tenga IVA', () => {
    const r = deducirCondicionIva({ impuestos: [imp(30)], tieneMonotributo: false, estadoClave: 'INACTIVO' })
    expect(r).toMatchObject({ id: 1, dudosa: true })
    expect(r.motivo).toContain('INACTIVO')
  })
})

describe('formato', () => {
  it('nombrePropio', () => {
    expect(nombrePropio('TUCUMAN')).toBe('Tucuman')
    expect(nombrePropio('CIUDAD AUTONOMA BUENOS AIRES')).toBe('Ciudad Autonoma Buenos Aires')
    expect(nombrePropio('SANTIAGO DEL ESTERO')).toBe('Santiago del Estero')
    expect(nombrePropio('  LA PAMPA ')).toBe('La Pampa')
  })
  it('domicilioEnLinea', () => {
    expect(domicilioEnLinea(null)).toBe('')
    expect(domicilioEnLinea({ direccion: 'SAN MARTIN 100', localidad: '', cod_postal: '', provincia: 'TUCUMAN', id_provincia: 24 })).toBe('SAN MARTIN 100')
    expect(domicilioEnLinea({ direccion: 'AV.  LEANDRO ALEM 199', localidad: 'SAN MIGUEL DE TUCUMAN', cod_postal: '4000', provincia: '', id_provincia: null }))
      .toBe('AV. LEANDRO ALEM 199 - SAN MIGUEL DE TUCUMAN (CP 4000)')
  })
})

describe('provinciaDePadron', () => {
  it('lleva la provincia de ARCA a la lista del selector', () => {
    expect(provinciaDePadron('CIUDAD AUTONOMA BUENOS AIRES')).toBe('Capital Federal')
    expect(provinciaDePadron('SANTIAGO DEL ESTERO')).toBe('Santiago del Estero')
    expect(provinciaDePadron('TIERRA DEL FUEGO')).toBe('Tierra del Fuego')
    expect(provinciaDePadron('TUCUMAN')).toBe('Tucuman')
    expect(provinciaDePadron('ENTRE RÍOS')).toBe('Entre Rios')
    expect(provinciaDePadron('')).toBe('')
  })
})

describe('cambiosDesdePadron', () => {
  const p = parsearGetPersona(fx('30502793175'), '30502793175')
  it('pisa domicilio y provincia; no toca razón social ni condición cargadas', () => {
    const { upd, diferencias } = cambiosDesdePadron({ razon_social: 'ARCOR S A I C', condicion_iva_id: 4, domicilio: '', provincia: '', doc_tipo: 80 }, p, false)
    expect(upd).toEqual({ domicilio: 'AV FULVIO S PAGANI 844 - ARROYITO (CP 2434)', provincia: 'Cordoba' })
    expect(diferencias.find((d) => d.campo === 'condicion_iva_id')).toMatchObject({ actual: 4, arca: 1, aplicado: false })
    expect(diferencias.find((d) => d.campo === 'razon_social')?.aplicado).toBe(false)
  })
  it('con todo: también razón social y condición', () => {
    const { upd } = cambiosDesdePadron({ razon_social: 'ARCOR', condicion_iva_id: 4, domicilio: 'x', provincia: 'y', doc_tipo: 80 }, p, true)
    expect(upd).toMatchObject({ razon_social: p.razon_social, condicion_iva_id: 1 })
  })
  it('precarga', () => {
    expect(precargaDe(p)).toMatchObject({ condicion_iva_id: 1, provincia: 'Cordoba' })
  })
})

describe('errorPadron', () => {
  it('traduce los códigos del padrón a errores del módulo', () => {
    const e = errorPadron(capturar(() => parsearGetPersona(fx('33717191949'), '33717191949')), '33717191949')
    expect(e.status).toBe(404)
    expect(e.code).toBe('PADRON_CUIT_INEXISTENTE')
    const e2 = errorPadron(capturar(() => parsearGetPersona(fx('20111111112'), '20111111112')), '20111111112')
    expect([e2.status, e2.code]).toEqual([422, 'PADRON_SIN_DATOS'])
  })
})
