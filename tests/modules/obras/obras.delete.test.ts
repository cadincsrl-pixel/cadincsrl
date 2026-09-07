// Eliminar una obra: solo si está vacía. Horas, extras, cierres, asignaciones
// y certificaciones cascadeaban en silencio; ahora frenan con 409 y el
// mensaje dice qué hay y que la salida es archivar.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'

const { estado } = vi.hoisted(() => ({
  estado: {
    counts: {} as Record<string, number>,
    deleteError: null as { code?: string; message: string } | null,
    borradas: [] as string[],
  },
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: { from: () => { throw new Error('no admin acá') } },
  createSupabaseClient: () => ({
    from(tabla: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        delete: () => { b._delete = true; return b },
        eq: () => b,
        then: (res: (v: unknown) => unknown) => {
          if (b._delete) { estado.borradas.push(tabla); return Promise.resolve({ error: estado.deleteError }).then(res) }
          return Promise.resolve({ count: estado.counts[tabla] ?? 0, error: null }).then(res)
        },
      }
      return b
    },
  }),
}))
vi.mock('../../../src/lib/obras-usuario.js', () => ({
  getObrasDelUsuarioCached: async () => null,
  invalidarCacheObrasUsuario: () => {},
}))

import { obrasService } from '../../../src/modules/obras/obras.service.js'

beforeEach(() => { estado.counts = {}; estado.deleteError = null; estado.borradas.length = 0 })

describe('obrasService.delete', () => {
  it('obra vacía: borra', async () => {
    expect(await obrasService.delete('CC-099', 'tok')).toEqual({ success: true })
    expect(estado.borradas).toEqual(['obras'])
  })
  it('con horas y cierres: 409 con el detalle y sin borrar', async () => {
    estado.counts = { horas: 120, cierres: 3 }
    try {
      await obrasService.delete('CC-001', 'tok'); throw new Error('no tiró')
    } catch (e) {
      expect(e).toBeInstanceOf(HTTPException)
      expect((e as HTTPException).status).toBe(409)
      expect((e as HTTPException).message).toMatch(/120 horas, 3 cierres.*Archivala/)
    }
    expect(estado.borradas).toEqual([])
  })
  it('FK de otro módulo (pedidos, stock): 409 legible', async () => {
    estado.deleteError = { code: '23503', message: 'violates foreign key constraint "solicitud_compra_obra_cod_fkey"' }
    await expect(obrasService.delete('CC-002', 'tok')).rejects.toMatchObject({ status: 409 })
  })
})
