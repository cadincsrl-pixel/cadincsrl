/** Contactos del cliente: la lista que valida el PUT /clientes/:id/contactos. */
import { describe, it, expect } from 'vitest'
import { ContactosSchema } from '../../../src/modules/facturacion/facturacion.schema.js'

describe('ContactosSchema', () => {
  it('acepta vendedor y administración, normaliza el email y pone defaults', () => {
    const r = ContactosSchema.parse({ contactos: [
      { nombre: 'Juan', rol: 'vendedor', email: ' Juan@Proveedor.com ', recibe_avisos: false },
      { rol: 'administracion', email: 'adm@proveedor.com' },
    ] })
    expect(r.contactos[0]).toMatchObject({ email: 'juan@proveedor.com', recibe_avisos: false })
    expect(r.contactos[1]).toMatchObject({ rol: 'administracion', recibe_avisos: true })
  })
  it('rechaza email mal formado, contacto vacío, rol desconocido y emails repetidos', () => {
    expect(ContactosSchema.safeParse({ contactos: [{ email: 'no-es-mail' }] }).success).toBe(false)
    expect(ContactosSchema.safeParse({ contactos: [{ nombre: ' ', email: '' }] }).success).toBe(false)
    expect(ContactosSchema.safeParse({ contactos: [{ nombre: 'X', rol: 'jefe' }] }).success).toBe(false)
    expect(ContactosSchema.safeParse({ contactos: [{ email: 'a@x.com' }, { email: 'A@x.com' }] }).success).toBe(false)
  })
  it('lista vacía = sacar todos', () => {
    expect(ContactosSchema.parse({ contactos: [] }).contactos).toEqual([])
  })
})
