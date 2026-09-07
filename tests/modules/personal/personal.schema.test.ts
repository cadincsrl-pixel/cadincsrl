// Alta y edición de personal: lo que entra y lo que se rechaza. Hasta el
// 2026-09-06 el schema de alta descartaba condición, modalidad y talles.
import { describe, it, expect } from 'vitest'
import {
  CreatePersonalSchema, UpdatePersonalSchema,
  normalizarDni, dniValido, fechaNacimientoValida,
  normalizarTelefono, telefonoValido, normalizarNombre, nombreValido, normalizarTalle, talleValido,
} from '../../../src/modules/personal/personal.schema.js'

const BASE = { leg: '112', nom: 'PEREZ JUAN', cat_id: 2, dni: '33333333' }

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

  it('condición null se admite; modalidad tiene default', () => {
    const r = CreatePersonalSchema.parse({ ...BASE, condicion: null })
    expect(r.condicion).toBeNull()
    expect(r.modalidad).toBe('hora')
  })

  it('el DNI es obligatorio al crear, se guarda solo con dígitos y se valida el largo', () => {
    expect(CreatePersonalSchema.parse({ ...BASE, dni: '36.890.735' }).dni).toBe('36890735')
    const sinDni = CreatePersonalSchema.safeParse({ ...BASE, dni: undefined })
    expect(sinDni.success).toBe(false)
    expect(sinDni.success ? '' : sinDni.error.issues[0]?.message).toBe('El DNI es obligatorio')
    expect(CreatePersonalSchema.safeParse({ ...BASE, dni: '' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, dni: '.' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, dni: '123' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, dni: '123456789' }).success).toBe(false)
  })

  it('legajo de 3 o 4 dígitos', () => {
    expect(CreatePersonalSchema.safeParse({ ...BASE, leg: '12' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, leg: 'A12' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, leg: ' 112 ' }).success).toBe(true)
    expect(CreatePersonalSchema.safeParse({ ...BASE, leg: '1000' }).success).toBe(true)
  })

  it('nombre: apellido y nombre, sin números; se normalizan los espacios', () => {
    expect(CreatePersonalSchema.parse({ ...BASE, nom: '  PEREZ   JUAN ' }).nom).toBe('PEREZ JUAN')
    expect(CreatePersonalSchema.safeParse({ ...BASE, nom: 'PEREZ' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, nom: 'PEREZ 2' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, nom: 'MOLINA, ESTEBAN GABRIEL' }).success).toBe(true)
    expect(CreatePersonalSchema.safeParse({ ...BASE, nom: "D'Angelo Ñandú-Pérez José" }).success).toBe(true)
  })

  it('teléfono solo dígitos, 8 a 13; "381" solo no es un teléfono', () => {
    expect(CreatePersonalSchema.parse({ ...BASE, tel: '381-555-1234' }).tel).toBe('3815551234')
    expect(CreatePersonalSchema.parse({ ...BASE }).tel).toBe('')
    expect(CreatePersonalSchema.safeParse({ ...BASE, tel: '381' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, tel: 'sin teléfono' }).success).toBe(false)
  })

  it('talles: número 30–60 o letra; se guardan en mayúsculas', () => {
    expect(CreatePersonalSchema.parse({ ...BASE, talle_camisa: ' xl ' }).talle_camisa).toBe('XL')
    expect(CreatePersonalSchema.parse({ ...BASE, talle_pantalon: '44' }).talle_pantalon).toBe('44')
    expect(CreatePersonalSchema.safeParse({ ...BASE, talle_botines: '4' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, talle_botines: '99' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, talle_camisa: 'grande' }).success).toBe(false)
  })

  it('fecha de nacimiento: ni de hace un siglo ni de un chico', () => {
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: '2022-02-07' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: '1193-08-03' }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: '1993-08-03' }).success).toBe(true)
    expect(CreatePersonalSchema.safeParse({ ...BASE, fecha_nacimiento: null }).success).toBe(true)
  })

  it('legajo y categoría son obligatorios', () => {
    expect(CreatePersonalSchema.safeParse({ ...BASE, leg: undefined }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, cat_id: undefined }).success).toBe(false)
    expect(CreatePersonalSchema.safeParse({ ...BASE, leg: '  ' }).success).toBe(false)
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

  it('un campo ausente sigue ausente (no se pisa con vacío)', () => {
    expect(UpdatePersonalSchema.parse({ condicion: 'blanco' })).toEqual({ condicion: 'blanco' })
    expect(UpdatePersonalSchema.parse({ tel: null }).tel).toBe('')
    expect(UpdatePersonalSchema.safeParse({ nom: 'SOLO' }).success).toBe(false)
    expect(UpdatePersonalSchema.safeParse({ tel: '381' }).success).toBe(false)
  })
})

describe('helpers', () => {
  it('normalizarDni / dniValido', () => {
    expect(normalizarDni(' 12.345.678 ')).toBe('12345678')
    expect(normalizarDni(null)).toBe('')
    expect(dniValido('')).toBe(true)
    expect(dniValido('1234567')).toBe(true)
    expect(dniValido('12.345.678')).toBe(true)
    expect(dniValido('123456789')).toBe(false)
    expect(dniValido('abc')).toBe(false)
  })

  it('teléfono, nombre y talle', () => {
    expect(normalizarTelefono('(381) 555-1234')).toBe('3815551234')
    expect(telefonoValido('')).toBe(true)
    expect(telefonoValido('3815551234')).toBe(true)
    expect(telefonoValido('381')).toBe(false)
    expect(telefonoValido('sin teléfono')).toBe(false)
    expect(normalizarNombre('  a   b ')).toBe('a b')
    expect(nombreValido('PEREZ JUAN')).toBe(true)
    expect(nombreValido('PEREZ')).toBe(false)
    expect(nombreValido('PEREZ J4')).toBe(false)
    expect(normalizarTalle(' l ')).toBe('L')
    expect(talleValido('L')).toBe(true)
    expect(talleValido('44')).toBe(true)
    expect(talleValido('29')).toBe(false)
  })

  it('fechaNacimientoValida: entre 100 y 14 años atrás, inclusive', () => {
    expect(fechaNacimientoValida('2012-09-06', '2026-09-06')).toBe(true)
    expect(fechaNacimientoValida('2012-09-07', '2026-09-06')).toBe(false)
    expect(fechaNacimientoValida('1926-09-06', '2026-09-06')).toBe(true)
    expect(fechaNacimientoValida('1926-09-05', '2026-09-06')).toBe(false)
  })
})
