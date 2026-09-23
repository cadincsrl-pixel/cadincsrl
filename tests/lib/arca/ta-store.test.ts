// TaStore de Supabase contra las RPC reales de 20260924c:
// arca_reclamar_renovacion devuelve jsonb { reclamado, ... } (NO un boolean),
// arca_guardar_token guarda y suelta el reclamo, arca_liberar_renovacion lo
// suelta sin TA nuevo. El cliente de Supabase está falseado.
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { crearTaStoreSupabase } from '../../../src/lib/arca/wsaa.js'

function dbFalsa(rpcRes: Record<string, { data: unknown; error: unknown }>, fila: unknown = null) {
  const rpc = vi.fn(async (fn: string, _args: unknown) => rpcRes[fn] ?? { data: null, error: null })
  const maybeSingle = vi.fn(async () => ({ data: fila, error: null }))
  const q = { select: () => q, eq: () => q, maybeSingle }
  const from = vi.fn(() => q)
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, from }
}

describe('crearTaStoreSupabase', () => {
  it('reclamarRenovacion lee `reclamado` del jsonb', async () => {
    const si = dbFalsa({ arca_reclamar_renovacion: { data: { reclamado: true, vigente: false }, error: null } })
    expect(await crearTaStoreSupabase(si.db).reclamarRenovacion('homo', 'wsfe')).toBe(true)
    expect(si.rpc).toHaveBeenCalledWith('arca_reclamar_renovacion', { p_ambiente: 'homo', p_servicio: 'wsfe', p_segundos: 120 })

    const no = dbFalsa({ arca_reclamar_renovacion: { data: { reclamado: false, vigente: true }, error: null } })
    expect(await crearTaStoreSupabase(no.db).reclamarRenovacion('homo', 'wsfe')).toBe(false)

    // Un boolean pelado (la forma vieja) ya no cuenta como reclamo.
    const vieja = dbFalsa({ arca_reclamar_renovacion: { data: true, error: null } })
    expect(await crearTaStoreSupabase(vieja.db).reclamarRenovacion('homo', 'wsfe')).toBe(false)
  })

  it('guardar va por arca_guardar_token con generado y vencimiento', async () => {
    const f = dbFalsa({})
    const expira = new Date('2026-09-24T09:22:14.000Z')
    const generado = new Date('2026-09-23T21:22:14.000Z')
    await crearTaStoreSupabase(f.db).guardar('homo', 'wsfe', { token: 'T', sign: 'S', expiraAt: expira, generadoAt: generado })
    expect(f.rpc).toHaveBeenCalledWith('arca_guardar_token', {
      p_ambiente: 'homo', p_servicio: 'wsfe', p_token: 'T', p_sign: 'S',
      p_generado_at: generado.toISOString(), p_expira_at: expira.toISOString(),
    })
    expect(f.from).not.toHaveBeenCalled()
  })

  it('liberar va por arca_liberar_renovacion', async () => {
    const f = dbFalsa({})
    await crearTaStoreSupabase(f.db).liberar!('prod', 'wsfe')
    expect(f.rpc).toHaveBeenCalledWith('arca_liberar_renovacion', { p_ambiente: 'prod', p_servicio: 'wsfe' })
  })

  it('un error de la RPC sale como ARCA_TA_STORE sin credenciales', async () => {
    const f = dbFalsa({ arca_guardar_token: { data: null, error: { message: 'TA_INVALIDO' } } })
    await expect(crearTaStoreSupabase(f.db).guardar('homo', 'wsfe', { token: 'SECRETO', sign: 'S', expiraAt: new Date() }))
      .rejects.toMatchObject({ codigo: 'ARCA_TA_STORE' })
    await crearTaStoreSupabase(f.db).guardar('homo', 'wsfe', { token: 'SECRETO', sign: 'S', expiraAt: new Date() }).catch((e: Error) => {
      expect(e.message).not.toContain('SECRETO')
    })
  })

  it('leer arma el TA con generado_at', async () => {
    const f = dbFalsa({}, { token: 'T', sign: 'S', expira_at: '2026-09-24T09:22:14Z', generado_at: '2026-09-23T21:22:14Z' })
    const ta = await crearTaStoreSupabase(f.db).leer('homo', 'wsfe')
    expect(ta?.expiraAt.toISOString()).toBe('2026-09-24T09:22:14.000Z')
    expect(ta?.generadoAt?.toISOString()).toBe('2026-09-23T21:22:14.000Z')
  })
})
