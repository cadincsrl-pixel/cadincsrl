/**
 * Contrato del alta/edición de una ficha de herramienta: el payload EXACTO que
 * arma `payloadFromForm` en HerrInventario.tsx contra el zod que lo valida.
 *
 * Existe porque los dos se escribieron por separado y nadie los confrontaba, que
 * es la lección que CLAUDE.md §8 ya dejó anotada (el bug de las fotos, 2026-05-19).
 * Los tres defectos que congelan estos tests son reales y estaban en producción
 * el 2026-09-15:
 *   - `tipo_id: null` (la opción "— Sin tipo —", que es el DEFAULT del modal)
 *     rebotaba con 400 y un volcado de JSON en el toast;
 *   - `fecha_ingreso: ''` (el campo vacío, que es opcional en la UI) llegaba a
 *     una columna `date` y reventaba con 22007, un 500 en inglés;
 *   - el `codigo` lo calculaba el cliente sobre las fichas ACTIVAS contra un
 *     UNIQUE global, así que la primera baja del número más alto trababa el alta.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/lib/supabase.js', () => ({ supabase: {}, createSupabaseClient: () => ({}) }))
vi.mock('../../../src/middleware/permission.js', () => ({
  requirePermiso: () => async (_c: any, next: any) => next(),
  requirePermisoOr: () => async (_c: any, next: any) => next(),
  requireTab: () => async (_c: any, next: any) => next(),
}))
vi.mock('../../../src/middleware/auth.js', () => ({ authMiddleware: async (_c: any, next: any) => next() }))

import { CreateSchema, UpdateSchema } from '../../../src/modules/herramientas/herramientas.routes.js'

/** Espejo literal de payloadFromForm(): si allá cambia, acá tiene que fallar. */
function payloadFromForm(data: Record<string, string>) {
  return {
    codigo:        data.codigo?.trim() || undefined,
    nom:           data.nom,
    tipo_id:       data.tipo_id   ? Number(data.tipo_id)   : null,
    marca_id:      data.marca_id  ? Number(data.marca_id)  : null,
    modelo_id:     data.modelo_id ? Number(data.modelo_id) : null,
    serie:         data.serie?.trim() || null,
    fecha_ingreso: data.fecha_ingreso || null,
    obs:           data.obs?.trim() || null,
  }
}

const FORM_VACIO = { codigo: '', nom: 'Taladro percutor', tipo_id: '', marca_id: '', modelo_id: '', serie: '', fecha_ingreso: '', obs: '' }

describe('CreateSchema contra el payload real del formulario', () => {
  it('acepta el formulario con TODO lo opcional vacío (el estado por defecto del modal)', () => {
    const r = CreateSchema.safeParse(payloadFromForm(FORM_VACIO))
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tipo_id).toBeNull()
      expect(r.data.codigo).toBeUndefined()   // lo asigna el backend
      expect(r.data.fecha_ingreso).toBeNull()
    }
  })

  it('acepta el formulario completo y no pierde ninguna clave por el camino', () => {
    const lleno = { ...FORM_VACIO, codigo: 'HER-099', tipo_id: '3', marca_id: '5', modelo_id: '7', serie: 'AB-1234', fecha_ingreso: '2026-09-15', obs: 'con maletín' }
    const payload = payloadFromForm(lleno)
    const r = CreateSchema.safeParse(payload)
    expect(r.success).toBe(true)
    if (r.success) {
      // El strip silencioso de una clave es el modo de falla que nadie ve.
      const enviadas = Object.keys(payload).filter(k => (payload as any)[k] !== undefined)
      expect(Object.keys(r.data).sort()).toEqual(enviadas.sort())
      expect(r.data.codigo).toBe('HER-099')
    }
  })

  it('tipo_id null es válido: "— Sin tipo —" es una opción, no un error', () => {
    expect(CreateSchema.safeParse({ nom: 'x', tipo_id: null }).success).toBe(true)
    expect(UpdateSchema.safeParse({ tipo_id: null }).success).toBe(true)
  })

  it('fecha_ingreso vacía es "sin fecha", no una fecha inválida', () => {
    for (const v of ['', null, undefined]) {
      expect(CreateSchema.safeParse({ nom: 'x', fecha_ingreso: v }).success).toBe(true)
      expect(UpdateSchema.safeParse({ fecha_ingreso: v }).success).toBe(true)
    }
  })

  it('una fecha con formato roto SÍ se rechaza (el campo sigue siendo una fecha)', () => {
    expect(CreateSchema.safeParse({ nom: 'x', fecha_ingreso: '15/09/2026' }).success).toBe(false)
    expect(CreateSchema.safeParse({ nom: 'x', fecha_ingreso: 'ayer' }).success).toBe(false)
  })

  it('el código es opcional pero, si viene, no puede ser vacío', () => {
    expect(CreateSchema.safeParse({ nom: 'x' }).success).toBe(true)
    expect(CreateSchema.safeParse({ nom: 'x', codigo: '   ' }).success).toBe(false)
  })

  it('el nombre sigue siendo obligatorio', () => {
    expect(CreateSchema.safeParse({ codigo: 'HER-001' }).success).toBe(false)
    expect(CreateSchema.safeParse({ nom: '' }).success).toBe(false)
  })
})
