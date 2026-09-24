/**
 * Importación del plan de cuentas: el CSV (`;`, `,` o tab, comentarios `#`,
 * comillas) y la normalización de encabezados y valores que recibe
 * `cont_importar_plan`.
 */
import { describe, it, expect } from 'vitest'
import {
  parsearCsv, normalizarFila, normRubro, normImputable, normAuxiliar, campoDeEncabezado,
  detectarSeparador, partirLineaCsv, esFilaIgnorable, filasDeEntrada, mezclarErroresLocales, type ImportarFila,
  esFormatoFinnegans, formatoDeEntrada, codigoFinnegans, rubroFinnegans, normalizarFilaFinnegans, armarVistaPrevia,
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

// ── Formato Finnegans (lo exporta el contador) ──────────────────────────────
// Filas del plan real (supabase/seeds/cont_plan_finnegans_2026.csv del
// frontend, que es la conversión hecha a mano) en el formato de Finnegans.
const FINNEGANS = `codigo;descripcion;nivel;cuenta_madre;imputable;capitulo;saldo_normal;habilitada
1000000;ACTIVO;1;;NO;ACTIVO;DEUDOR;SI
1100000;ACTIVO CORRIENTE;2;1000000;NO;ACTIVO;DEUDOR;SI
1110000;CAJA Y BANCOS;3;1100000;NO;ACTIVO;DEUDOR;SI
1110100;CAJAS;4;1110000;NO;ACTIVO;DEUDOR;SI
1110101;Caja;5;1110100;SI;ACTIVO;DEUDOR;SI
2000000;PASIVO;1;;NO;PASIVO;ACREEDOR;SI
2100000;PASIVO CORRIENTE;2;2000000;NO;PASIVO;ACREEDOR;SI
2130000;CARGAS FISCALES;3;2100000;NO;PASIVO;ACREEDOR;SI
2130300;IMPUESTO A LAS GANANCIAS;4;2130000;NO;PASIVO;ACREEDOR;SI
2130310;CHEQUE A PAGAR;5;2130300;SI;PASIVO;ACREEDOR;SI
3000000;PATRIMONIO NETO;1;;NO;PATRIMONIO NETO;ACREEDOR;SI
4000000;RESULTADO DEL PERIODO;1;;NO;RESULTADOS;;SI
4100000;INGRESOS;2;4000000;NO;RESULTADOS;ACREEDOR;SI
4110000;INGRESOS ORDINARIOS;3;4100000;NO;RESULTADOS;ACREEDOR;SI
4110100;VENTAS;4;4110000;NO;RESULTADOS;ACREEDOR;SI
4110101;Ventas Obras;5;4110100;SI;RESULTADOS;ACREEDOR;SI
4110400;OTROS INGRESOS ORDINARIOS;4;4110000;SI;RESULTADOS;ACREEDOR;SI
4200000;GASTOS;2;4000000;NO;RESULTADOS;DEUDOR;SI
4210101;Costo de Ventas;5;4210100;SI;RESULTADOS;DEUDOR;SI
`

describe('formato Finnegans', () => {
  it('se detecta por los encabezados', () => {
    expect(esFormatoFinnegans(['codigo', 'descripcion', 'nivel', 'cuenta_madre', 'imputable', 'capitulo', 'saldo_normal', 'habilitada'])).toBe(true)
    expect(esFormatoFinnegans(['Código', 'Descripción', 'Cuenta Madre', 'Capítulo'])).toBe(true)
    expect(esFormatoFinnegans(['codigo', 'nombre', 'rubro', 'imputable', 'auxiliar'])).toBe(false)
    expect(formatoDeEntrada({ csv: FINNEGANS })).toBe('finnegans')
    expect(formatoDeEntrada({ csv: SEED })).toBe('estandar')
  })

  it.each([
    ['1110101', 5, '1.1.1.01.01'], ['1110100', 4, '1.1.1.01'], ['2130310', 5, '2.1.3.03.10'], ['4000000', 1, '4'],
    ['4110400', 4, '4.1.1.04'], ['1100000', null, '1.1'], ['1110101', null, '1.1.1.01.01'], [2130310, null, '2.1.3.03.10'],
  ])('codigoFinnegans(%j, nivel %j) → %s', (v, nivel, esperado) => {
    expect(codigoFinnegans(v as string, nivel as number | null)).toBe(esperado)
  })

  it.each([
    ['111010', null], ['01110101', null], ['abc', null], ['1110100', 5], ['1110101', 4], ['1010000', 3], ['1110101', 6],
  ])('codigoFinnegans(%j, nivel %j) → inválido', (v, nivel) => {
    expect(codigoFinnegans(v, nivel as number | null)).toBeNull()
  })

  it.each([
    ['ACTIVO', 'DEUDOR', 'activo'], ['PASIVO', 'ACREEDOR', 'pasivo'], ['PATRIMONIO NETO', 'ACREEDOR', 'pn'],
    ['RESULTADOS', 'ACREEDOR', 'ingreso'], ['RESULTADOS', 'DEUDOR', 'egreso'], ['RESULTADOS', '', 'resultado'],
    ['', 'DEUDOR', null], ['OTRO', '', 'otro'],
  ])('rubro %s / %s → %s', (c, s, esperado) => {
    expect(rubroFinnegans(c, s)).toBe(esperado)
  })

  it('convierte las filas del plan real igual que la conversión a mano', () => {
    const r = filasDeEntrada({ csv: FINNEGANS })
    expect(r.every((n) => n.error === null && !n.omitida)).toBe(true)
    expect(r.map((n) => [n.codigoOriginal, n.fila.codigo, n.fila.rubro, n.fila.imputable])).toEqual([
      ['1000000', '1', 'activo', false], ['1100000', '1.1', 'activo', false], ['1110000', '1.1.1', 'activo', false],
      ['1110100', '1.1.1.01', 'activo', false], ['1110101', '1.1.1.01.01', 'activo', true],
      ['2000000', '2', 'pasivo', false], ['2100000', '2.1', 'pasivo', false], ['2130000', '2.1.3', 'pasivo', false],
      ['2130300', '2.1.3.03', 'pasivo', false], ['2130310', '2.1.3.03.10', 'pasivo', true],
      ['3000000', '3', 'pn', false],
      ['4000000', '4', 'resultado', false], ['4100000', '4.1', 'ingreso', false], ['4110000', '4.1.1', 'ingreso', false],
      ['4110100', '4.1.1.01', 'ingreso', false], ['4110101', '4.1.1.01.01', 'ingreso', true], ['4110400', '4.1.1.04', 'ingreso', true],
      ['4200000', '4.2', 'egreso', false], ['4210101', '4.2.1.01.01', 'egreso', true],
    ])
    expect(r[4]!.fila).toEqual({ codigo: '1.1.1.01.01', nombre: 'Caja', rubro: 'activo', imputable: true, auxiliar: null })
  })

  it('madre que no coincide → MADRE_NO_COINCIDE (pisa el error de la RPC)', () => {
    const r = normalizarFilaFinnegans({ codigo: '1110101', descripcion: 'Caja', nivel: '5', cuenta_madre: '1110200', imputable: 'SI', capitulo: 'ACTIVO', saldo_normal: 'DEUDOR', habilitada: 'SI' })
    expect(r.error).toEqual({ code: 'MADRE_NO_COINCIDE', detalle: { cuenta_madre: '1110200', madre_convertida: '1.1.1.02', padre_codigo: '1.1.1.01' } })
    expect(r.pisa).toBe(true)
    // Nivel 1 con madre, o nivel > 1 sin madre, también.
    expect(normalizarFilaFinnegans({ codigo: '1000000', descripcion: 'ACTIVO', nivel: '1', cuenta_madre: '9000000', capitulo: 'ACTIVO', habilitada: 'SI' }).error?.code).toBe('MADRE_NO_COINCIDE')
    expect(normalizarFilaFinnegans({ codigo: '1100000', descripcion: 'AC', nivel: '2', cuenta_madre: '', capitulo: 'ACTIVO', habilitada: 'SI' }).error?.code).toBe('MADRE_NO_COINCIDE')
    expect(normalizarFilaFinnegans({ codigo: '1000000', descripcion: 'ACTIVO', nivel: '1', cuenta_madre: '0', capitulo: 'ACTIVO', habilitada: 'SI' }).error).toBeNull()
  })

  it('código que no se puede convertir → CODIGO_FINNEGANS_INVALIDO con el código crudo', () => {
    const r = normalizarFilaFinnegans({ codigo: '1110100', descripcion: 'CAJAS', nivel: '5', cuenta_madre: '1110000', capitulo: 'ACTIVO', habilitada: 'SI' })
    expect(r.error).toEqual({ code: 'CODIGO_FINNEGANS_INVALIDO', detalle: { codigo: '1110100', nivel: '5' } })
    expect(r.fila.codigo).toBe('1110100')
  })

  it('habilitada = NO → omitida; valor raro → HABILITADA_INVALIDA', () => {
    expect(normalizarFilaFinnegans({ codigo: '1110102', descripcion: 'libre.', nivel: '5', cuenta_madre: '1110100', imputable: 'SI', capitulo: 'ACTIVO', habilitada: 'NO' }))
      .toMatchObject({ omitida: true, error: null, fila: { codigo: '1.1.1.01.02' } })
    expect(normalizarFilaFinnegans({ codigo: '1110102', descripcion: 'x', nivel: '5', cuenta_madre: '1110100', capitulo: 'ACTIVO', habilitada: 'quizás' }).error?.code)
      .toBe('HABILITADA_INVALIDA')
  })
})

describe('armarVistaPrevia', () => {
  const rpcFila = (indice: number, codigo: string, extra: Partial<ImportarFila> = {}): ImportarFila => ({
    indice, estado: 'duplicada', error: null, detalle: { motivo: 'ya_existe' }, codigo, nombre: 'x', rubro: 'activo', imputable: false,
    auxiliar: 'none', nivel: codigo.split('.').length, padre_codigo: null, cuenta_id: 1, ...extra,
  })

  it('reindexa por fila del archivo, agrega las omitidas y el código original', () => {
    const csv = `codigo;descripcion;nivel;cuenta_madre;imputable;capitulo;saldo_normal;habilitada
1000000;ACTIVO;1;;NO;ACTIVO;DEUDOR;SI
1100000;VIEJA;2;1000000;NO;ACTIVO;DEUDOR;NO
1110000;HIJA DE VIEJA;3;1100000;NO;ACTIVO;DEUDOR;SI
1200000;NO CORRIENTE;2;1000000;NO;ACTIVO;DEUDOR;SI`
    const n = filasDeEntrada({ csv })
    // La RPC solo vio 3 filas (1, 1.1.1, 1.2), numeradas 1..3.
    const rpc = [
      rpcFila(1, '1'),
      rpcFila(2, '1.1.1', { estado: 'error', error: 'PADRE_NO_EXISTE', detalle: { padre_codigo: '1.1' } }),
      rpcFila(3, '1.2', { estado: 'nueva', detalle: null }),
    ]
    const r = armarVistaPrevia(n, rpc)
    expect(r.map((f) => [f.indice, f.codigo, f.codigo_original, f.estado, f.error])).toEqual([
      [1, '1', '1000000', 'duplicada', null],
      [2, '1.1', '1100000', 'omitida', 'CUENTA_DESHABILITADA'],
      [3, '1.1.1', '1110000', 'error', 'PADRE_NO_EXISTE'],
      [4, '1.2', '1200000', 'nueva', null],
    ])
    expect(r[2]!.detalle).toEqual({ padre_codigo: '1.1', motivo: 'padre_deshabilitado' })
    expect(r[1]).toMatchObject({ nivel: 2, padre_codigo: '1' })
  })

  it('el error de Finnegans pisa el de la RPC; el formato estándar queda como antes', () => {
    const n = filasDeEntrada({ csv: `codigo;descripcion;nivel;cuenta_madre;imputable;capitulo;saldo_normal;habilitada
111;CORTO;;;SI;ACTIVO;;SI` })
    const r = armarVistaPrevia(n, [rpcFila(1, '111', { estado: 'error', error: 'CODIGO_INVALIDO' })])
    expect(r[0]).toMatchObject({ error: 'CODIGO_FINNEGANS_INVALIDO', codigo_original: '111' })

    const est = filasDeEntrada({ csv: 'codigo;nombre;imputable\n1;A;quizás' })
    const r2 = armarVistaPrevia(est, [rpcFila(1, '1', { estado: 'error', error: 'RUBRO_REQUERIDO' })])
    expect(r2[0]!.error).toBe('RUBRO_REQUERIDO')
    expect(r2[0]).not.toHaveProperty('codigo_original')
  })
})
