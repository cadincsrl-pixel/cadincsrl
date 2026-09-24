/**
 * Importación del plan de cuentas: el CSV (`;`, `,` o tab, comentarios `#`,
 * comillas) y la normalización de encabezados y valores que recibe
 * `cont_importar_plan`.
 */
import { describe, it, expect } from 'vitest'
import {
  parsearCsv, normalizarFila, normRubro, normImputable, normAuxiliar, campoDeEncabezado,
  detectarSeparador, partirLineaCsv, esFilaIgnorable, filasDeEntrada, mezclarErroresLocales, type ImportarFila,
} from '../../../src/modules/contabilidad/plan-import.js'

const SEED = `# PROVISORIO — propuesta para revisar con Mariana (decisión pendiente #2). No se aplica solo: importar desde Contabilidad › Plan › Importar (vista previa primero).
codigo;nombre;rubro;imputable;auxiliar
1;ACTIVO;activo;N;none
1.1;ACTIVO CORRIENTE;activo;N;none
1.1.01.001;Caja en pesos;activo;S;none
1.1.02.001;Deudores por ventas;activo;S;cliente
5.2.01.005;Servicios (luz, gas, agua, internet, teléfono);egreso;S;none
`

describe('parsearCsv', () => {
  it('lee el seed provisorio: saltea el comentario y respeta las comas dentro del nombre', () => {
    const filas = parsearCsv(SEED)
    expect(filas).toHaveLength(5)
    expect(filas[0]).toEqual({ codigo: '1', nombre: 'ACTIVO', rubro: 'activo', imputable: 'N', auxiliar: 'none' })
    expect(filas[4]!.nombre).toBe('Servicios (luz, gas, agua, internet, teléfono)')
  })

  it('separador coma con comillas, CRLF y BOM', () => {
    const csv = '﻿Código,Denominación,Tipo,Imp\r\n1.1,"Caja, bancos y ""valores""",A,si\r\n\r\n# nota\r\n2,PASIVO,P,no\r\n'
    const filas = parsearCsv(csv)
    expect(filas).toEqual([
      { 'Código': '1.1', 'Denominación': 'Caja, bancos y "valores"', Tipo: 'A', Imp: 'si' },
      { 'Código': '2', 'Denominación': 'PASIVO', Tipo: 'P', Imp: 'no' },
    ])
  })

  it('separador tab', () => {
    expect(parsearCsv('codigo\tnombre\n1\tACTIVO')).toEqual([{ codigo: '1', nombre: 'ACTIVO' }])
  })

  it('vacío o solo comentarios → sin filas', () => {
    expect(parsearCsv('')).toEqual([])
    expect(parsearCsv('# nada\n\n')).toEqual([])
  })

  it('detectarSeparador y partirLineaCsv', () => {
    expect(detectarSeparador('a;b;c')).toBe(';')
    expect(detectarSeparador('a,b,c')).toBe(',')
    expect(detectarSeparador('a\tb')).toBe('\t')
    expect(detectarSeparador('solo')).toBe(';')
    expect(partirLineaCsv('1; "a;b" ;c', ';')).toEqual(['1', 'a;b', 'c'])
  })
})

describe('encabezados', () => {
  it.each([
    ['codigo', 'codigo'], ['Código', 'codigo'], ['COD', 'codigo'], ['cuenta', 'codigo'],
    ['nombre', 'nombre'], ['Denominación', 'nombre'], ['descripcion', 'nombre'],
    ['rubro', 'rubro'], ['TIPO', 'rubro'], ['imputable', 'imputable'], ['imp', 'imputable'],
    ['Auxiliar', 'auxiliar'], ['aux', 'auxiliar'], ['otra cosa', null],
  ])('%s → %s', (h, campo) => {
    expect(campoDeEncabezado(h)).toBe(campo)
  })
})

describe('valores', () => {
  it.each([
    ['a', 'activo'], ['Activo', 'activo'], ['P', 'pasivo'], ['pasivo', 'pasivo'],
    ['PN', 'pn'], ['Patrimonio Neto', 'pn'], ['R+', 'ingreso'], ['ingresos', 'ingreso'], ['Resultado positivo', 'ingreso'],
    ['R-', 'egreso'], ['r -', 'egreso'], ['Egreso', 'egreso'], ['gastos', 'egreso'], ['resultado negativo', 'egreso'],
    ['', null], [null, null], ['cualquiera', 'cualquiera'],
  ])('rubro %j → %j', (v, esperado) => {
    expect(normRubro(v as string | null)).toBe(esperado)
  })

  it.each([
    ['S', true], ['si', true], ['Sí', true], ['true', true], ['1', true], [1, true], [true, true],
    ['N', false], ['no', false], ['false', false], ['0', false], [0, false], [false, false],
    ['', null], [null, null], ['quizás', undefined], [2, undefined],
  ])('imputable %j → %j', (v, esperado) => {
    expect(normImputable(v as string)).toBe(esperado)
  })

  it.each([
    ['none', 'none'], ['', null], ['Cliente', 'cliente'], ['proveedores', 'proveedor'], ['Tesorería', 'tesoreria'], ['xx', 'xx'],
  ])('auxiliar %j → %j', (v, esperado) => {
    expect(normAuxiliar(v)).toBe(esperado)
  })
})

describe('normalizarFila', () => {
  it('mapea encabezados y valores', () => {
    expect(normalizarFila({ 'Código': ' 1.1.01 ', 'Denominación': ' Caja y bancos ', Tipo: 'A', Imp: 'N', Aux: '' })).toEqual({
      fila: { codigo: '1.1.01', nombre: 'Caja y bancos', rubro: 'activo', imputable: false, auxiliar: null },
      error: null,
    })
  })

  it('código numérico del Excel → texto', () => {
    expect(normalizarFila({ codigo: 3, nombre: 'PATRIMONIO NETO' }).fila.codigo).toBe('3')
  })

  it('imputable ilegible → IMPUTABLE_INVALIDO y null para la RPC', () => {
    const r = normalizarFila({ codigo: '1.1', nombre: 'X', imputable: 'tal vez' })
    expect(r.fila.imputable).toBeNull()
    expect(r.error).toEqual({ code: 'IMPUTABLE_INVALIDO', detalle: { valor: 'tal vez' } })
  })

  it('sin columna de rubro/imputable/auxiliar → null (la RPC pone los defaults)', () => {
    expect(normalizarFila({ codigo: '1.1', nombre: 'X' }).fila).toEqual({ codigo: '1.1', nombre: 'X', rubro: null, imputable: null, auxiliar: null })
  })
})

describe('filasDeEntrada', () => {
  it('filas del xlsx: saltea renglones vacíos y comentarios', () => {
    const r = filasDeEntrada({ filas: [
      { codigo: '# PROVISORIO', nombre: null },
      { codigo: '1', nombre: 'ACTIVO', rubro: 'activo' },
      { codigo: '', nombre: '' },
    ] })
    expect(r).toHaveLength(1)
    expect(r[0]!.fila.codigo).toBe('1')
  })

  it('si vienen filas vacías usa el csv', () => {
    expect(filasDeEntrada({ filas: [], csv: SEED })).toHaveLength(5)
  })

  it('esFilaIgnorable', () => {
    expect(esFilaIgnorable({ a: '', b: null })).toBe(true)
    expect(esFilaIgnorable({ a: '#x' })).toBe(true)
    expect(esFilaIgnorable({ a: '1' })).toBe(false)
  })
})

describe('mezclarErroresLocales', () => {
  const fila = (indice: number, estado: ImportarFila['estado'] = 'nueva'): ImportarFila => ({
    indice, estado, error: estado === 'error' ? 'PADRE_NO_EXISTE' : null, detalle: null,
    codigo: String(indice), nombre: 'x', rubro: 'activo', imputable: true, auxiliar: 'none', nivel: 1, padre_codigo: null, cuenta_id: null,
  })

  it('marca la fila por posición (RPC que numera desde 1)', () => {
    const r = mezclarErroresLocales([fila(1), fila(2), fila(3)], [{ indice: 1, code: 'IMPUTABLE_INVALIDO', detalle: { valor: '?' } }])
    expect(r.map((f) => f.estado)).toEqual(['nueva', 'error', 'nueva'])
    expect(r[1]).toMatchObject({ error: 'IMPUTABLE_INVALIDO', detalle: { valor: '?' } })
  })

  it('RPC que numera desde 0; no pisa un error de la RPC', () => {
    const r = mezclarErroresLocales([fila(0, 'error'), fila(1)], [
      { indice: 0, code: 'IMPUTABLE_INVALIDO', detalle: {} }, { indice: 1, code: 'IMPUTABLE_INVALIDO', detalle: {} },
    ])
    expect(r[0]!.error).toBe('PADRE_NO_EXISTE')
    expect(r[1]!.error).toBe('IMPUTABLE_INVALIDO')
  })
})
