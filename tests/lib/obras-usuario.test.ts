/**
 * Alcance de obras (src/lib/obras-usuario.ts): el override por módulo
 * `permisos.<modulo>.obras_scope` manda sobre `profiles.obras_scope`, y
 * hay UNA lista de obras por usuario (usuario_obras ya no tiene `modulo`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type Perfil = { rol: string; tipo_usuario: string | null; obras_scope: string | null; permisos: Record<string, unknown> | null }
const { estado } = vi.hoisted(() => ({
  estado: {
    perfil: null as Perfil | null,
    obras: [] as Array<{ obra_cod: string }>,
    consultas: [] as string[],
    // filas por tabla para validarObraDeRegistro (maybeSingle)
    filas: {} as Record<string, unknown>,
  },
}))

// Cliente de mentira: cada tabla devuelve su resultado fijo, sea que se
// termine en .maybeSingle() o que se haga await del builder directamente.
vi.mock('../../src/lib/supabase.js', () => {
  function builder(tabla: string) {
    estado.consultas.push(tabla)
    const resultado = tabla === 'profiles'
      ? { data: estado.perfil, error: null }
      : tabla === 'usuario_obras'
        ? { data: estado.obras, error: null }
        : { data: estado.filas[tabla] ?? null, error: null }
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'in']) b[m] = () => b
    b.maybeSingle = async () => resultado
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(resultado).then(res)
    return b
  }
  return { supabase: { from: builder }, createSupabaseClient: () => ({}) }
})

import { getObrasDelUsuario, getObrasDelUsuarioCached, invalidarCacheObrasUsuario, validarObraDeRegistro, sinObras } from '../../src/lib/obras-usuario.js'
import { HTTPException } from 'hono/http-exception'

const perfil = (obras_scope: string | null, permisos: Record<string, unknown> | null = null, rol = 'operador'): Perfil =>
  ({ rol, tipo_usuario: null, obras_scope, permisos })

describe('getObrasDelUsuario', () => {
  beforeEach(() => {
    estado.perfil = null
    estado.obras = [{ obra_cod: 'CC-001' }, { obra_cod: 'CC-002' }, { obra_cod: 'CC-001' }]
    estado.consultas.length = 0
    invalidarCacheObrasUsuario('u-1')
  })

  it('admin ve todo', async () => {
    estado.perfil = perfil('asignadas', null, 'admin')
    expect(await getObrasDelUsuario('u-1', 'tarja')).toBeNull()
  })

  it('scope global "todas" → null; "asignadas" → la lista sin duplicados', async () => {
    estado.perfil = perfil('todas')
    expect(await getObrasDelUsuario('u-1')).toBeNull()
    estado.perfil = perfil('asignadas')
    expect(await getObrasDelUsuario('u-1')).toEqual(['CC-001', 'CC-002'])
  })

  it('el override del módulo manda sobre el global, en ambos sentidos', async () => {
    estado.perfil = perfil('todas', { tarja: { lectura: true, obras_scope: 'asignadas' } })
    expect(await getObrasDelUsuario('u-1', 'tarja')).toEqual(['CC-001', 'CC-002'])
    expect(await getObrasDelUsuario('u-1', 'certificaciones')).toBeNull()
    expect(await getObrasDelUsuario('u-1')).toBeNull()

    estado.perfil = perfil('asignadas', { herramientas: { obras_scope: 'todas' } })
    expect(await getObrasDelUsuario('u-1', 'herramientas')).toBeNull()
    expect(await getObrasDelUsuario('u-1', 'tarja')).toEqual(['CC-001', 'CC-002'])
  })

  it('un módulo inexistente se ignora y vale el global', async () => {
    estado.perfil = perfil('asignadas', { 'no-existe': { obras_scope: 'todas' } })
    expect(await getObrasDelUsuario('u-1', 'no-existe')).toEqual(['CC-001', 'CC-002'])
  })

  it('la cache es por usuario+módulo y se invalida entera', async () => {
    estado.perfil = perfil('asignadas')
    expect(await getObrasDelUsuarioCached('u-1', 'tarja')).toEqual(['CC-001', 'CC-002'])
    const antes = estado.consultas.length
    await getObrasDelUsuarioCached('u-1', 'tarja')
    expect(estado.consultas.length).toBe(antes) // hit
    invalidarCacheObrasUsuario('u-1')
    await getObrasDelUsuarioCached('u-1', 'tarja')
    expect(estado.consultas.length).toBeGreaterThan(antes)
  })
})

describe('validarObraDeRegistro', () => {
  beforeEach(() => {
    estado.perfil = perfil('asignadas')
    estado.obras = [{ obra_cod: 'CC-001' }]
    estado.filas = {}
    invalidarCacheObrasUsuario('u-1')
  })

  async function codigo(p: Promise<unknown>): Promise<number | 'ok'> {
    try { await p; return 'ok' } catch (e) { return e instanceof HTTPException ? e.status : 500 }
  }

  it('pasa si la fila es de una obra del usuario, 403 si no, 404 si no existe', async () => {
    estado.filas = { cert_materiales: { obra_cod: 'CC-001' } }
    expect(await codigo(validarObraDeRegistro('u-1', 'certificaciones', 'cert_materiales', 5))).toBe('ok')
    estado.filas = { cert_materiales: { obra_cod: 'CC-009' } }
    expect(await codigo(validarObraDeRegistro('u-1', 'certificaciones', 'cert_materiales', 5))).toBe(403)
    estado.filas = {}
    expect(await codigo(validarObraDeRegistro('u-1', 'certificaciones', 'cert_materiales', 5))).toBe(404)
  })

  it('viaSolicitud lee la obra de la solicitud del ítem', async () => {
    estado.filas = { solicitud_compra_item: { solicitud_compra: { obra_cod: 'CC-001' } } }
    expect(await codigo(validarObraDeRegistro('u-1', 'certificaciones', 'solicitud_compra_item', 3396, { viaSolicitud: true }))).toBe('ok')
    estado.filas = { solicitud_compra_item: { solicitud_compra: { obra_cod: 'CC-025' } } }
    expect(await codigo(validarObraDeRegistro('u-1', 'certificaciones', 'solicitud_compra_item', 3396, { viaSolicitud: true }))).toBe(403)
  })

  it('con scope "todas" o admin no consulta la tabla', async () => {
    estado.perfil = perfil('todas')
    const antes = estado.consultas.length
    expect(await codigo(validarObraDeRegistro('u-1', 'certificaciones', 'cert_materiales', 5))).toBe('ok')
    expect(estado.consultas.slice(antes)).not.toContain('cert_materiales')
  })

  it('sinObras solo es true con alcance y lista vacía', () => {
    expect(sinObras(null)).toBe(false)
    expect(sinObras([])).toBe(true)
    expect(sinObras(['CC-001'])).toBe(false)
  })
})
