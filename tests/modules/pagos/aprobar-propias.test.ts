/**
 * `aprobar_propias` (20260921f): el flag que levanta la doble firma.
 *
 * Normalmente quien carga una factura NO la aprueba. Con el flag, sí — y
 * además la factura que carga nace aprobada, sin pasar por nadie.
 *
 * Lo que estos tests cuidan:
 *  - que sin el flag el bloqueo siga intacto (es la regla de siempre);
 *  - que la auto-aprobación necesite LOS DOS flags, no uno;
 *  - y sobre todo que si la aprobación falla, la factura recién creada NO se
 *    caiga: ya está guardada y es válida.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock, fromMock, state } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  state: { perfil: null as any },
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_t: string) => ({ rpc: rpcMock, from: fromMock }),
  supabase: { rpc: rpcMock, from: fromMock },
}))

vi.mock('../../../src/lib/paginar.js', () => ({ todasLasFilas: async () => [] }))

import { pagosService, PagosHttpError } from '../../../src/modules/pagos/pagos.service.js'

const DIEGO = 'diego-uuid'
const OTRO  = 'otro-uuid'

/** Perfil con los flags de pagos que se le pasen. */
const perfil = (flags: Record<string, boolean>) => ({
  rol: 'operador', activo: true, permisos: { pagos: { lectura: true, creacion: true, ...flags } },
})

/** La fila que devuelve el select de la factura antes de aprobar. */
function facturaDe(created_by: string) {
  const obj: any = {
    select: () => obj, eq: () => obj,
    maybeSingle: () => Promise.resolve({ data: { id: 7, created_by, estado: 'pendiente' }, error: null }),
  }
  return obj
}

beforeEach(() => {
  rpcMock.mockReset()
  fromMock.mockReset()
  state.perfil = null
})

describe('aprobarFactura — la doble firma', () => {
  it('sin el flag, no se aprueba la propia', async () => {
    fromMock.mockReturnValue(facturaDe(DIEGO))
    await expect(pagosService.aprobarFactura(7, DIEGO, perfil({ aprobar_facturas: true }) as any))
      .rejects.toMatchObject({ status: 403, code: 'NO_PUEDE_APROBAR_PROPIA' })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('con el flag, la propia se aprueba', async () => {
    fromMock.mockReturnValue(facturaDe(DIEGO))
    rpcMock.mockResolvedValue({ data: { id: 7, estado: 'aprobada' }, error: null })
    await pagosService.aprobarFactura(7, DIEGO, perfil({ aprobar_facturas: true, aprobar_propias: true }) as any)
    expect(rpcMock).toHaveBeenCalledWith('pagos_aprobar_factura', { p_factura_id: 7, p_user_id: DIEGO })
  })

  it('la de otro se aprueba siempre, con flag o sin flag', async () => {
    fromMock.mockReturnValue(facturaDe(OTRO))
    rpcMock.mockResolvedValue({ data: { id: 7, estado: 'aprobada' }, error: null })
    await pagosService.aprobarFactura(7, DIEGO, perfil({ aprobar_facturas: true }) as any)
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('el admin nunca estuvo bloqueado', async () => {
    fromMock.mockReturnValue(facturaDe(DIEGO))
    rpcMock.mockResolvedValue({ data: { id: 7, estado: 'aprobada' }, error: null })
    await pagosService.aprobarFactura(7, DIEGO, { rol: 'admin', activo: true, permisos: {} } as any)
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })
})

describe('crearFactura — la factura nace aprobada', () => {
  /** Mocks del camino feliz de crearFactura: la RPC que crea, y el select de parecidas. */
  function armarCreacion() {
    const parecidas: any = {
      select: () => parecidas, eq: () => parecidas, neq: () => parecidas,
      limit: () => Promise.resolve({ data: [], error: null }),
    }
    fromMock.mockReturnValue(parecidas)
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'pagos_crear_factura') {
        return Promise.resolve({ data: { factura: { id: 7, estado: 'pendiente' }, orden: null }, error: null })
      }
      if (fn === 'pagos_aprobar_factura') {
        return Promise.resolve({ data: { id: 7, estado: 'aprobada', aprobada_por: DIEGO }, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })
  }

  const dto = {
    proveedor_id: 9, tipo_comprobante: 'A', numero: '0001-1', fecha: '2026-01-01',
    total: 1000, descripcion: 'materiales de obra', forma_pago_prevista: 'transferencia',
    paga_cliente: false, imputaciones: [{ obra_cod: 'CC-018', monto: 1000 }],
  } as any

  const llamadas = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).length

  it('con los dos flags, se aprueba sola y vuelve ya aprobada', async () => {
    armarCreacion()
    const r: any = await pagosService.crearFactura(
      dto, DIEGO, perfil({ aprobar_facturas: true, aprobar_propias: true }) as any)
    expect(llamadas('pagos_aprobar_factura')).toBe(1)
    expect(r.factura).toMatchObject({ estado: 'aprobada', aprobada_por: DIEGO })
  })

  it('sin aprobar_propias no se aprueba sola, aunque pueda aprobar', async () => {
    armarCreacion()
    const r: any = await pagosService.crearFactura(dto, DIEGO, perfil({ aprobar_facturas: true }) as any)
    expect(llamadas('pagos_aprobar_factura')).toBe(0)
    expect(r.factura).toMatchObject({ estado: 'pendiente' })
  })

  it('sin aprobar_facturas tampoco, aunque tenga el flag suelto', async () => {
    armarCreacion()
    await pagosService.crearFactura(dto, DIEGO, perfil({ aprobar_propias: true }) as any)
    expect(llamadas('pagos_aprobar_factura')).toBe(0)
  })

  it('si la aprobación falla, la factura creada NO se pierde', async () => {
    armarCreacion()
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'pagos_crear_factura') {
        return Promise.resolve({ data: { factura: { id: 7, estado: 'pendiente' }, orden: null }, error: null })
      }
      // La paga el cliente, el proveedor quedó inactivo, lo que sea.
      return Promise.resolve({ data: null, error: { message: 'FACTURA_PAGA_CLIENTE' } })
    })
    const r: any = await pagosService.crearFactura(
      dto, DIEGO, perfil({ aprobar_facturas: true, aprobar_propias: true }) as any)
    expect(r.factura).toMatchObject({ id: 7, estado: 'pendiente' })
  })
})
