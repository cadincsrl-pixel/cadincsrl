/**
 * Alcance de obras (src/lib/obras-usuario.ts): el override por módulo
 * `permisos.<modulo>.obras_scope` manda sobre `profiles.obras_scope`, y
 * hay UNA lista de obras por usuario (usuario_obras ya no tiene `modulo`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type Perfil = { rol: string; tipo_usuario: string | null; obras_scope: string | null; permisos: Record<string, unknown> | null }
const { estado } = vi.hoisted(() => ({
  estado: { perfil: null as Perfil | null, obras: [] as Array<{ obra_cod: string }>, consultas: [] as string[] },
}))

// Cliente de mentira: cada tabla devuelve su resultado fijo, sea que se
// termine en .maybeSingle() o que se haga await del builder directamente.
vi.mock('../../src/lib/supabase.js', () => {
  function builder(tabla: string) {
    estado.consultas.push(tabla)
    const resultado = tabla === 'profiles'
      ? { data: estado.perfil, error: null }
      : { data: estado.obras, error: null }
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'in']) b[m] = () => b
    b.maybeSingle = async () => resultado
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(resultado).then(res)
    return b
  }
  return { supabase: { from: builder }, createSupabaseClient: () => ({}) }
})

import { getObrasDelUsuario, getObrasDelUsuarioCached, invalidarCacheObrasUsuario } from '../../src/lib/obras-usuario.js'

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
