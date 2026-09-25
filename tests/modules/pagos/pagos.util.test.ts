/**
 * Normalizadores del módulo Pagos (src/modules/pagos/pagos.util.ts).
 * Espejo de lo que valida la base: `cbu_valido()`, los CHECK de CUIT/alias,
 * `hoy_ar()`. Si cambia acá, cambia allá.
 */
import { describe, it, expect } from 'vitest'
import {
  hoyAR, normNumeroFactura, normCuit, cuitValido, normCbu, cbuValido, normAlias, aliasValido,
  enmascarar, enmascararTexto, cuadra, sumaCentavos, separarNumerosFactura,
} from '../../../src/modules/pagos/pagos.util.js'

// CBU construido con los dos verificadores (bloque 1 pesos 7,1,3,9,7,1,3; bloque 2 pesos 3,9,7,1,3,9,7,1,3,9,7,1,3).
const CBU_OK = '0170099220000123456788'

describe('hoyAR', () => {
  it('devuelve YYYY-MM-DD', () => {
    expect(hoyAR()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('normNumeroFactura', () => {
  it('extrae punto de venta y número ignorando prefijos, espacios y ceros', () => {
    expect(normNumeroFactura('FC A 0025-00024789')).toBe('25-24789')
    expect(normNumeroFactura('Nº 25-24789')).toBe('25-24789')
    expect(normNumeroFactura('0025 00024305')).toBe('25-24305')
    expect(normNumeroFactura('002500024305')).toBe('25-24305')
  })
  it('sin dígitos: lower(trim) con espacios colapsados; vacío o null: null', () => {
    expect(normNumeroFactura('S/N')).toBe('s/n')
    expect(normNumeroFactura('  Sin   Numero ')).toBe('sin numero')
    expect(normNumeroFactura('')).toBeNull()
    expect(normNumeroFactura('   ')).toBeNull()
    expect(normNumeroFactura(null)).toBeNull()
    expect(normNumeroFactura(undefined)).toBeNull()
  })
  it('un solo grupo corto es solo número', () => {
    expect(normNumeroFactura('7526')).toBe('7526')
    expect(normNumeroFactura('00000000')).toBe('0')
  })
})

describe('CUIT', () => {
  it('normCuit deja solo dígitos y vacío → null', () => {
    expect(normCuit('30-57742861-8')).toBe('30577428618')
    expect(normCuit('')).toBeNull()
    expect(normCuit('  ')).toBeNull()
    expect(normCuit(null)).toBeNull()
  })
  it('cuitValido: uno real pasa, un dígito cambiado no, largo distinto no', () => {
    expect(cuitValido('30577428618')).toBe(true)
    expect(cuitValido('30577428617')).toBe(false)
    expect(cuitValido('3057742861')).toBe(false)
    expect(cuitValido('305774286181')).toBe(false)
    expect(cuitValido('20123456786')).toBe(true)
  })
})

describe('CBU', () => {
  it('normCbu deja solo dígitos', () => {
    expect(normCbu('0170 0992 2000 0123 4567 88')).toBe(CBU_OK)
    expect(normCbu('')).toBeNull()
  })
  it('cbuValido: real pasa; 21 dígitos no; 22 con un dígito cambiado no', () => {
    expect(cbuValido(CBU_OK)).toBe(true)
    expect(cbuValido(CBU_OK.slice(0, 21))).toBe(false)
    expect(cbuValido(CBU_OK.slice(0, 10) + '9' + CBU_OK.slice(11))).toBe(false)
    expect(cbuValido('0170099220000123456789')).toBe(false)   // verificador del bloque 2 mal
    expect(cbuValido('0170099320000123456788')).toBe(false)   // verificador del bloque 1 mal
    expect(cbuValido(null)).toBe(false)
    expect(cbuValido('abc')).toBe(false)
  })
})

describe('alias', () => {
  it('normAlias baja a minúsculas: JUAN.PEREZ y juan.perez son la misma cuenta', () => {
    expect(normAlias('JUAN.PEREZ')).toBe('juan.perez')
    expect(normAlias(' juan.perez ')).toBe('juan.perez')
    expect(normAlias('')).toBeNull()
  })
  it('aliasValido: 6 a 20 de letras, dígitos, punto y guion', () => {
    expect(aliasValido('juan.perez')).toBe(true)
    expect(aliasValido('silva-hnos.mp')).toBe(true)
    expect(aliasValido('corto')).toBe(false)
    expect(aliasValido('con espacio.x')).toBe(false)
    expect(aliasValido('a'.repeat(21))).toBe(false)
    expect(aliasValido('Mayus.Cula')).toBe(false)   // se normaliza antes; el formato exige minúsculas
  })
})

describe('enmascarar', () => {
  it('sin ver_pii deja ***últimos4; con ver_pii el valor entero; null se respeta', () => {
    expect(enmascarar(CBU_OK, false)).toBe('***6788')
    expect(enmascarar(CBU_OK, true)).toBe(CBU_OK)
    expect(enmascarar('juan.perez', false)).toBe('***erez')
    expect(enmascarar(null, false)).toBeNull()
    expect(enmascarar('', false)).toBeNull()
  })
  it('enmascararTexto tapa CBU y alias adentro del detalle de audit_log', () => {
    const det = `cbu: 0170099220000123456788 → 0170099220000123456700 · alias_cbu: juan.perez → silva.hnos · banco: x → y`
    const m = enmascararTexto(det, false)
    expect(m).not.toContain('0170099220000123456788')
    expect(m).toContain('***6788')
    expect(m).toContain('***6700')
    expect(m).not.toContain('juan.perez')
    expect(m).toContain('***erez')
    expect(m).toContain('banco: x → y')
    expect(enmascararTexto(det, true)).toBe(det)
  })
})

describe('tolerancia única de $0,01', () => {
  it('cuadra acepta hasta un centavo y suma sin arrastre binario', () => {
    expect(cuadra(100, 100.01)).toBe(true)
    expect(cuadra(100, 100.02)).toBe(false)
    expect(sumaCentavos([0.1, 0.2])).toBe(0.3)
  })
})

describe('separarNumerosFactura', () => {
  it('saca los números completos y deja el resto', () => {
    expect(separarNumerosFactura('00005-00025267')).toEqual({ numeros: ['5-25267'], resto: '' })
    expect(separarNumerosFactura('5-25267 hierro')).toEqual({ numeros: ['5-25267'], resto: 'hierro' })
    expect(separarNumerosFactura('0005 00025267')).toEqual({ numeros: ['5-25267'], resto: '' })
    expect(separarNumerosFactura('0000500025267')).toEqual({ numeros: ['5-25267'], resto: '' })
  })
  it('lo parcial, los CUIT y el texto no son números de factura', () => {
    expect(separarNumerosFactura('25267')).toEqual({ numeros: [], resto: '25267' })
    expect(separarNumerosFactura('30-57742861-8')).toEqual({ numeros: [], resto: '30-57742861-8' })
    expect(separarNumerosFactura('30577428618')).toEqual({ numeros: [], resto: '30577428618' })
    expect(separarNumerosFactura('5 25267')).toEqual({ numeros: [], resto: '5 25267' })
    expect(separarNumerosFactura(undefined)).toEqual({ numeros: [], resto: '' })
  })
})
