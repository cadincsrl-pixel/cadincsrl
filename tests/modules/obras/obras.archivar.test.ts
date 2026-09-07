// Antes de archivar: si la semana en curso tiene horas reales o hay semanas
// reabiertas sin cerrar, el service arma el motivo y la ruta responde 409
// (salvo ?forzar=1).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { estado } = vi.hoisted(() => ({
  estado: { horas: [] as Array<{ leg: string; horas: number }>, cierres: [] as Array<{ sem_key: string }> },
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: () => { throw new Error('no per-request acá') },
  supabase: {
    from(tabla: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      for (const m of ['select', 'eq', 'gte', 'lte', 'gt', 'lt']) b[m] = () => b
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: tabla === 'horas' ? estado.horas : estado.cierres, error: null }).then(res)
      return b
    },
  },
}))
vi.mock('../../../src/lib/obras-usuario.js', () => ({
  getObrasDelUsuarioCached: async () => null,
  invalidarCacheObrasUsuario: () => {},
}))

import { obrasService } from '../../../src/modules/obras/obras.service.js'

beforeEach(() => { estado.horas = []; estado.cierres = [] })

describe('obrasService.motivoNoArchivar', () => {
  it('sin horas esta semana ni semanas reabiertas: null', async () => {
    expect(await obrasService.motivoNoArchivar('CC-001')).toBeNull()
  })
  it('horas reales en la semana en curso', async () => {
    estado.horas = [{ leg: '001', horas: 8 }, { leg: '001', horas: 9 }, { leg: '002', horas: 4 }]
    expect(await obrasService.motivoNoArchivar('CC-001')).toMatch(/^21 horas de 2 trabajadores en la semana en curso/)
  })
  it('semanas reabiertas sin volver a cerrar', async () => {
    estado.cierres = [{ sem_key: '2026-08-21' }, { sem_key: '2026-08-14' }]
    expect(await obrasService.motivoNoArchivar('CC-001')).toBe('2 semanas reabiertas sin volver a cerrar (2026-08-14, 2026-08-21)')
  })
  it('las dos cosas se juntan con "y"', async () => {
    estado.horas = [{ leg: '001', horas: 8 }]
    estado.cierres = [{ sem_key: '2026-08-21' }]
    expect(await obrasService.motivoNoArchivar('CC-001')).toMatch(/8 horas de 1 trabajador .* y 1 semana reabierta/)
  })
})
