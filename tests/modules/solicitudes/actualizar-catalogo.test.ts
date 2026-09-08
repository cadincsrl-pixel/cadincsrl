// La regla de "poner el precio de esta compra en el catalogo" (20260911).
// Pura: sin base ni mocks. Lo que fija:
//   · sin ficha no hay catalogo que actualizar
//   · precio 0 no es un precio
//   · unidad distinta se rechaza (la compatibilidad la decide la base)
//   · una factura vieja cargada tarde no pisa un precio mas nuevo
import { describe, it, expect } from 'vitest'
import { validarActualizacionCatalogo, fechaART } from '../../../src/modules/solicitudes/actualizar-catalogo.js'

const ok = {
  material_id: 7, unidad_renglon: 'bolsa', unidad_ficha: 'bolsa', unidad_compatible: true,
  precio_unit: 12500, fecha_precio: '2026-09-08', precio_actualizado_en: '2026-08-01T10:00:00+00:00',
  precio_vigente: 10000,
}

describe('validarActualizacionCatalogo', () => {
  it('deja pasar el caso normal', () => {
    expect(validarActualizacionCatalogo(ok)).toBeNull()
  })
  it('sin ficha no hay nada que actualizar', () => {
    expect(validarActualizacionCatalogo({ ...ok, material_id: null })?.code).toBe('SIN_FICHA')
  })
  it('precio 0 no es un precio', () => {
    expect(validarActualizacionCatalogo({ ...ok, precio_unit: 0 })?.code).toBe('PRECIO_INVALIDO')
  })
  it('unidad distinta se rechaza con las dos unidades a la vista', () => {
    const r = validarActualizacionCatalogo({ ...ok, unidad_renglon: 'lt', unidad_ficha: 'lata', unidad_compatible: false })
    expect(r?.code).toBe('UNIDAD_DISTINTA')
    expect(r?.detalle).toEqual({ unidad_renglon: 'lt', unidad_ficha: 'lata' })
  })
  it('una factura anterior al precio vigente no lo pisa', () => {
    const r = validarActualizacionCatalogo({ ...ok, fecha_precio: '2026-07-15' })
    expect(r?.code).toBe('FACTURA_ANTERIOR_AL_PRECIO')
    expect(r?.detalle).toEqual({ fecha_factura: '2026-07-15', precio_vigente_desde: '2026-08-01' })
  })
  it('la factura del mismo dia que el precio vigente si pasa', () => {
    expect(validarActualizacionCatalogo({ ...ok, fecha_precio: '2026-08-01' })).toBeNull()
  })
  it('sin fecha de precio vigente (ficha nunca tasada) no hay comparacion', () => {
    expect(validarActualizacionCatalogo({ ...ok, fecha_precio: '2026-01-01', precio_actualizado_en: null })).toBeNull()
  })

  // Un precio fijado a las 22:30 de Argentina queda en la base como 01:30 UTC del
  // dia siguiente. Comparar en UTC rechazaba la factura del mismo dia.
  it('compara en fecha argentina, no en UTC', () => {
    expect(fechaART('2026-09-09T01:30:00+00:00')).toBe('2026-09-08')
    expect(validarActualizacionCatalogo({ ...ok, fecha_precio: '2026-09-08', precio_actualizado_en: '2026-09-09T01:30:00+00:00' })).toBeNull()
  })

  it('una ficha en $0 con fecha seteada no bloquea nada: no hay precio que proteger', () => {
    expect(validarActualizacionCatalogo({ ...ok, precio_vigente: 0, fecha_precio: '2026-01-01', precio_actualizado_en: '2026-09-01T10:00:00+00:00' })).toBeNull()
  })
})
