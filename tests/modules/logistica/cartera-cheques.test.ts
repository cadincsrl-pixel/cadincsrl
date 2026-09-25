/**
 * Cartera de cheques recibidos, fase 2 (20260930h): quién libró un cheque
 * leído del adjunto de un cobro de Logística.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/lib/supabase.js', () => ({ supabase: {}, createSupabaseClient: () => ({}) }))
vi.mock('../../../src/modules/pagos/lectura/cheque-ia.js', () => ({ leerChequeConIA: vi.fn() }))

import { libradorRecibido } from '../../../src/modules/logistica/cobros/adjuntos.service.js'

const CASILDA = { nombre: 'CASILDA COMBUSTIBLES SRL', cuit: '30-71567526-5' }
const CADINC = '33717191949'

describe('libradorRecibido', () => {
  it('sin librador en la lectura → la empresa del cobro', () => {
    expect(libradorRecibido({ librador: null, librador_cuit: null }, CASILDA, CADINC))
      .toEqual({ librador: 'CASILDA COMBUSTIBLES SRL', librador_cuit: '30-71567526-5' })
  })
  it('la lectura dice CADINC (el transportista de la liquidación) → la empresa del cobro', () => {
    expect(libradorRecibido({ librador: 'CADINC S.R.L.', librador_cuit: '33717191949' }, CASILDA, CADINC).librador).toBe('CASILDA COMBUSTIBLES SRL')
    expect(libradorRecibido({ librador: 'Cadinc SRL', librador_cuit: null }, CASILDA, CADINC).librador).toBe('CASILDA COMBUSTIBLES SRL')
  })
  it('un tercero que la empresa nos endosó → se respeta', () => {
    expect(libradorRecibido({ librador: 'AGRO CASA BOIX S. R. L.', librador_cuit: '30-12345678-9' }, CASILDA, CADINC))
      .toEqual({ librador: 'AGRO CASA BOIX S. R. L.', librador_cuit: '30123456789' })
  })
})
