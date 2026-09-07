// Fechas válidas de verdad (z.iso.date) y sem_key/desde en viernes en los
// schemas de tarja. Antes el regex aceptaba 2026-13-45 y cualquier día.
import { describe, it, expect } from 'vitest'
import { UpsertHoraSchema } from '../../../src/modules/horas/horas.schema.js'
import { UpsertHsExtraSchema } from '../../../src/modules/hs-extras/hs-extras.schema.js'
import { CreateCierreSchema } from '../../../src/modules/cierres/cierres.schema.js'
import { CreateTarifaSchema } from '../../../src/modules/tarifas/tarifas.schema.js'
import { CreateEntregasLoteSchema } from '../../../src/modules/ropa/ropa.schema.js'

describe('fechas de tarja', () => {
  it('horas: la fecha tiene que existir en el calendario', () => {
    expect(UpsertHoraSchema.safeParse({ obra_cod: 'CC-001', fecha: '2026-09-04', leg: '001', horas: 8 }).success).toBe(true)
    expect(UpsertHoraSchema.safeParse({ obra_cod: 'CC-001', fecha: '2026-13-45', leg: '001', horas: 8 }).success).toBe(false)
    expect(UpsertHoraSchema.safeParse({ obra_cod: 'CC-001', fecha: '2026-02-30', leg: '001', horas: 8 }).success).toBe(false)
  })
  it('hs extras y cierres: sem_key es un viernes', () => {
    expect(UpsertHsExtraSchema.safeParse({ obra_cod: 'CC-001', leg: '001', sem_key: '2026-09-04', hs: 5 }).success).toBe(true)
    expect(UpsertHsExtraSchema.safeParse({ obra_cod: 'CC-001', leg: '001', sem_key: '2026-09-07', hs: 5 }).success).toBe(false)
    expect(CreateCierreSchema.safeParse({ obra_cod: 'CC-001', sem_key: '2026-09-04' }).success).toBe(true)
    expect(CreateCierreSchema.safeParse({ obra_cod: 'CC-001', sem_key: '2026-09-03' }).success).toBe(false)
  })
  it('tarifas: desde opcional pero, si viene, viernes', () => {
    expect(CreateTarifaSchema.safeParse({ obra_cod: 'CC-001', cat_id: 1, vh: 5000 }).success).toBe(true)
    expect(CreateTarifaSchema.safeParse({ obra_cod: 'CC-001', cat_id: 1, vh: 5000, desde: '2026-09-04' }).success).toBe(true)
    expect(CreateTarifaSchema.safeParse({ obra_cod: 'CC-001', cat_id: 1, vh: 5000, desde: '2026-09-02' }).success).toBe(false)
  })
  it('ropa en lote: al menos una prenda', () => {
    expect(CreateEntregasLoteSchema.safeParse({ leg: '001', categoria_ids: [1, 2], fecha_entrega: '2026-09-07' }).success).toBe(true)
    expect(CreateEntregasLoteSchema.safeParse({ leg: '001', categoria_ids: [], fecha_entrega: '2026-09-07' }).success).toBe(false)
  })
})
