// Alta y edición de personal: lo que entra y lo que se rechaza. Hasta el
// 2026-09-06 el schema de alta descartaba condición, modalidad y talles.
import { describe, it, expect } from 'vitest'
import {
  CreatePersonalSchema, UpdatePersonalSchema,
  normalizarDni, dniValido, fechaNacimientoValida,
} from '../../../src/modules/personal/personal.schema.js'

const BASE = { leg: '112', nom: 'PEREZ JUAN', cat_id: 2 }

describe('CreatePersonalSchema', () => {
  it('conserva condición, modalidad y talles', () => {
    const r = CreatePersonalSchema.parse({
      ...BASE, condicion: 'asegurado', modalidad: 'mes',
      talle_pantalon: '44', talle_botines: '42', talle_camisa: 'L',
    })
    expect(r).toMatchObject({
      condicion: 'asegurado', modalidad: 'mes',
      talle_pantalon: '44', talle_botines: '42', talle_camisa: 'L',
    })
  })

  it('condición null se admite; modalidad y DNI tienen default', () => {
    const r = CreatePersonalSchema.parse({ ...BASE, condicion: null })
    expect(r.condicion).toBeNull()
    expect(r.modalidad).toBe('hora')
    expect(r.dni).toBe('')
  })

  it('el DNI se guarda solo con dígitos y se valida el largo', () => {
    expect(CreatePersonalSchema.parse({ ...BASE, dni: '36.890.735' }).dni).toBe('36890735')
    expect(CreatePersonalSchema.parse({ ...BASE, dni: null }).dni).toBe('')
    expect(CreatePersonalSchema.safeParse({ ...BASE, dni: '123' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, dni: '123456789' }).success).toBe(false)
  })

  it('fecha de nacimiento: ni de hace un siglo ni de un chico', () => {
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: '2022-02-07' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: '1193-08-03' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: '1993-08-03' }).success).toBe(true)
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: null }).success).toBe(true)
  })

  it('legajo y categoría son obligatorios', () => {
    expect(CreatePersonalSchema.safeParse({ nom: 'X', cat_id: 1 }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ leg: '1', nom: 'X' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ leg: '  ', nom: 'X', cat_id: 1 }).success).toBe(false)
  })
})

describe('UpdatePersonalSchema', () => {
  it('cat_desde tiene que ser un viernes', () => {
    expect(UpdatePersonalSchema.safeParse({ cat_id: 2, cat_desde: '2026-09-04' }).success).toBe(true)
    expect(UpdatePersonalSchema.safeParse({ cat_id: 2, cat_desde: '2026-09-03' }).success).toBe(false)
  })

  it('descarta claves desconocidas y acepta condición null', () => {
    expect(UpdatePersonalSchema.parse({ condicion: null, hackeo: 1 })).toEqual({ condicion: null })
  })

  it('normaliza el DNI también al editar', () => {
    expect(UpdatePersonalSchema.parse({ dni: ' 12.345.678 ' }).dni).toBe('12345678')
  })
})

describe('helpers', () => {
  it('normalizarDni / dniValido', () => {
    expect(normalizarDni(' 12.345.678 ')).toBe('12345678')
    expect(normalizarDni(null)).toBe('')
    expect(dniValido('')).toBe(true)
    expect(dniValido('1234567')).toBe(true)
    expect(dniValido('12345678')).toBe(true)
    expect(dniValido('123456789')).toBe(false)
  })

  it('fechaNacimientoValida: entre 100 y 14 años atrás, inclusive', () => {
    expect(fechaNacimientoValida('2012-09-06', '2026-09-06')).toBe(true)
    expect(fechaNacimientoValida('2012-09-07', '2026-09-06')).toBe(false)
    expect(fechaNacimientoValida('1926-09-06', '2026-09-06')).toBe(true)
    expect(fechaNacimientoValida('1926-09-05', '2026-09-06')).toBe(false)
  })
})
