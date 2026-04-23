/**
 * Tests del service de solicitudes — camino RPC vs legacy y mapeo de errores.
 *
 * Estrategia:
 * - Mockeamos `createSupabaseClient` (de `src/lib/supabase.ts`) para que
 *   devuelva un doble que expone:
 *     - `rpc(name, payload)` como `vi.fn()`.
 *     - `from(table)` como chainable (.select/.update/.insert/.eq/...),
 *       con `.maybeSingle()` / `.single()` retornando el {data, error}
 *       que configuramos por test.
 * - Manejamos `process.env.USE_RPC_RESOLVER` vía beforeEach/afterEach
 *   para evitar leaks entre tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock del módulo supabase antes de importar el service ─────
// `vi.hoisted` garantiza que las fns existen cuando vi.mock (hoisteado) las usa.
const { rpcMock, fromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  createSupabaseClient: (_token: string) => ({
    rpc: rpcMock,
    from: fromMock,
  }),
  supabase: {
    from: fromMock,
  },
}))

// Importamos el service DESPUES del mock.
import { solicitudesService, HttpError, mapRpcError } from '../../../src/modules/solicitudes/solicitudes.service.js'
import type { PostgrestError } from '@supabase/supabase-js'

// ── Helpers para armar un chainable de Supabase ───────────────
function chainable(resolved: { data: any; error: any }) {
  const obj: any = {
    select:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    delete:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    order:       vi.fn(() => obj),
    maybeSingle: vi.fn(() => Promise.resolve(resolved)),
    single:      vi.fn(() => Promise.resolve(resolved)),
    then:        (onFulfilled: any) => Promise.resolve(resolved).then(onFulfilled),
  }
  return obj
}

beforeEach(() => {
  rpcMock.mockReset()
  fromMock.mockReset()
  delete process.env.USE_RPC_RESOLVER
})

afterEach(() => {
  delete process.env.USE_RPC_RESOLVER
})

// ── comprarItem: dispatcher según flag ────────────────────────
describe('comprarItem dispatcher', () => {
  const itemId = 42
  const userId = 'user-uuid'
  const token  = 'jwt-token'
  const dto    = { proveedor_id: 7, precio_unit: 100.5, factura_id: null }

  it('con flag off (default) llama al camino legacy y NO invoca rpc()', async () => {
    const itemRow = {
      id: itemId,
      solicitud_id: 10,
      estado: 'comprado',
      material_id: null,
      cantidad: 2,
      unidad: 'unid',
      descripcion: 'Tornillos',
      precio_unit: 100.5,
      proveedor_id: 7,
      factura_id: null,
      fecha_resolucion: '2026-04-22',
      solicitud_compra: { id: 10, obra_cod: 'OBRA-1' },
    }

    // Secuencia esperada en legacy:
    //  1) update solicitud_compra_item → itemRow
    //  2) _registrarMaterialCliente: select item → itemRow
    //  3) select solicitud_compra → { obra_cod }
    //  4) select obras → { es_deposito: false }
    //  5) select materiales_a_cuenta_cliente existing → null
    //  6) insert materiales_a_cuenta_cliente
    fromMock
      .mockReturnValueOnce(chainable({ data: itemRow, error: null }))
      .mockReturnValueOnce(chainable({ data: { ...itemRow, estado: 'comprado' }, error: null }))
      .mockReturnValueOnce(chainable({ data: { obra_cod: 'OBRA-1' }, error: null }))
      .mockReturnValueOnce(chainable({ data: { es_deposito: false }, error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }))

    const res = await solicitudesService.comprarItem(itemId, dto as any, token, userId)

    expect(rpcMock).not.toHaveBeenCalled()
    expect(res).toEqual(itemRow)
  })

  it('con flag on invoca rpc("resolver_item_compra") con los params correctos', async () => {
    process.env.USE_RPC_RESOLVER = 'true'

    rpcMock.mockResolvedValueOnce({ data: [{ item_id: itemId, estado: 'comprado' }], error: null })
    fromMock.mockReturnValueOnce(chainable({
      data: { id: itemId, estado: 'comprado', solicitud_compra: { id: 10, obra_cod: 'OBRA-1' } },
      error: null,
    }))

    const res = await solicitudesService.comprarItem(itemId, dto as any, token, userId)

    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('resolver_item_compra', {
      p_item_id:      itemId,
      p_proveedor_id: 7,
      p_precio_unit:  100.5,
      p_factura_id:   null,
      p_user_id:      userId,
    })
    expect(res).toMatchObject({ id: itemId, estado: 'comprado' })
  })
})

// ── despacharItem dispatcher: flag off → legacy ────────────────
describe('despacharItem dispatcher', () => {
  const itemId = 55
  const userId = 'user-uuid'
  const token  = 'jwt-token'

  it('con flag off (default) llama al camino legacy y NO invoca rpc()', async () => {
    // Item sin material_id → legacy salta el bloque de stock y va
    // directo a _registrarMaterialCliente. Secuencia esperada:
    //   1) update solicitud_compra_item → itemRow
    //   2) select solicitud_compra_item (dentro de _registrar)
    //   3) select solicitud_compra → { obra_cod }
    //   4) select obras → { es_deposito: false }
    //   5) select materiales_a_cuenta_cliente existing → null
    //   6) insert materiales_a_cuenta_cliente
    const itemRow = {
      id: itemId,
      solicitud_id: 10,
      estado: 'de_deposito',
      material_id: null,
      cantidad: 2,
      unidad: 'unid',
      descripcion: 'Material X',
      precio_unit: 50,
      fecha_resolucion: '2026-04-22',
      solicitud_compra: { id: 10, obra_cod: 'OBRA-1' },
    }

    fromMock
      .mockReturnValueOnce(chainable({ data: itemRow, error: null }))
      .mockReturnValueOnce(chainable({ data: { ...itemRow }, error: null }))
      .mockReturnValueOnce(chainable({ data: { obra_cod: 'OBRA-1' }, error: null }))
      .mockReturnValueOnce(chainable({ data: { es_deposito: false }, error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }))

    const res = await solicitudesService.despacharItem(itemId, { precio_unit: 50 } as any, token, userId)

    expect(rpcMock).not.toHaveBeenCalled()
    expect(res).toEqual(itemRow)
  })
})

// ── despacharItem con flag RPC ─────────────────────────────────
describe('despacharItem (RPC)', () => {
  const itemId = 55
  const userId = 'user-uuid'
  const token  = 'jwt-token'

  beforeEach(() => {
    process.env.USE_RPC_RESOLVER = 'true'
  })

  it('sin forzar_sin_stock pasa p_forzar_sin_stock: false', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ item_id: itemId }], error: null })
    fromMock.mockReturnValueOnce(chainable({
      data: { id: itemId, estado: 'de_deposito', solicitud_compra: { id: 1, obra_cod: 'O-1' } },
      error: null,
    }))

    await solicitudesService.despacharItem(itemId, { precio_unit: 50 } as any, token, userId)

    expect(rpcMock).toHaveBeenCalledWith('resolver_item_despacho', {
      p_item_id:          itemId,
      p_precio_unit:      50,
      p_user_id:          userId,
      p_forzar_sin_stock: false,
    })
  })

  it('con forzarSinStock=true (param explícito) pasa p_forzar_sin_stock: true a la RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ item_id: itemId }], error: null })
    fromMock.mockReturnValueOnce(chainable({
      data: { id: itemId, estado: 'de_deposito', solicitud_compra: { id: 1, obra_cod: 'O-1' } },
      error: null,
    }))

    // forzarSinStock ahora es 5to parámetro explícito, NO campo del dto.
    await solicitudesService.despacharItem(
      itemId,
      { precio_unit: 50 } as any,
      token,
      userId,
      true,
    )

    expect(rpcMock).toHaveBeenCalledWith('resolver_item_despacho', {
      p_item_id:          itemId,
      p_precio_unit:      50,
      p_user_id:          userId,
      p_forzar_sin_stock: true,
    })
  })

  it('dto con forzar_sin_stock:true pero sin el 5to arg explícito → p_forzar_sin_stock:false', async () => {
    // Defensa en profundidad: el service ignora `dto.forzar_sin_stock`.
    // Si un caller directo pasa el flag en el dto pero no como parámetro
    // explícito, NO se propaga el forzado (comportamiento seguro por default).
    rpcMock.mockResolvedValueOnce({ data: [{ item_id: itemId }], error: null })
    fromMock.mockReturnValueOnce(chainable({
      data: { id: itemId, estado: 'de_deposito', solicitud_compra: { id: 1, obra_cod: 'O-1' } },
      error: null,
    }))

    await solicitudesService.despacharItem(
      itemId,
      { precio_unit: 50, forzar_sin_stock: true } as any,
      token,
      userId,
      // sin 5to param → default false
    )

    expect(rpcMock).toHaveBeenCalledWith('resolver_item_despacho', {
      p_item_id:          itemId,
      p_precio_unit:      50,
      p_user_id:          userId,
      p_forzar_sin_stock: false,
    })
  })
})

// ── Mapeo de errores de RPC a HttpError ───────────────────────
describe('mapRpcError', () => {
  function mkErr(message: string, code?: string, details?: string): PostgrestError {
    return { message, code: code ?? '', details: details ?? '', hint: '', name: 'PostgrestError' } as unknown as PostgrestError
  }

  it('ITEM_NO_EXISTE → 404', () => {
    const e = mapRpcError(mkErr('ITEM_NO_EXISTE'))
    expect(e).toBeInstanceOf(HttpError)
    expect(e.status).toBe(404)
    expect(e.code).toBe('ITEM_NO_EXISTE')
  })

  it('ITEM_NO_DISPONIBLE → 404 (no 409)', () => {
    const e = mapRpcError(mkErr('ITEM_NO_DISPONIBLE'))
    expect(e.status).toBe(404)
    expect(e.code).toBe('ITEM_NO_DISPONIBLE')
  })

  it('PROVEEDOR_INVALIDO → 400', () => {
    const e = mapRpcError(mkErr('PROVEEDOR_INVALIDO'))
    expect(e.status).toBe(400)
    expect(e.code).toBe('PROVEEDOR_INVALIDO')
  })

  it('STOCK_INSUFICIENTE → 400 con detail JSON parseado', () => {
    // Shape real del detail que arma la RPC (ver migración 20260422):
    //   json_build_object('material_id', ..., 'stock_actual', ..., 'cantidad_solicitada', ...)
    const detailStr = JSON.stringify({ material_id: 9, stock_actual: 3, cantidad_solicitada: 10 })
    const e = mapRpcError(mkErr('STOCK_INSUFICIENTE', '', detailStr))
    expect(e.status).toBe(400)
    expect(e.code).toBe('STOCK_INSUFICIENTE')
    expect(e.detail).toEqual({ material_id: 9, stock_actual: 3, cantidad_solicitada: 10 })
  })

  it('STOCK_INSUFICIENTE con details no-JSON → detail string', () => {
    const e = mapRpcError(mkErr('STOCK_INSUFICIENTE', '', 'texto plano no json'))
    expect(e.detail).toBe('texto plano no json')
  })

  it('ITEM_YA_REGISTRADO → 409', () => {
    const e = mapRpcError(mkErr('ITEM_YA_REGISTRADO'))
    expect(e.status).toBe(409)
    expect(e.code).toBe('ITEM_YA_REGISTRADO')
  })

  it('error.code 23503 → 500 INTEGRIDAD_REFERENCIAL', () => {
    const e = mapRpcError(mkErr('foreign key violation...', '23503'))
    expect(e.status).toBe(500)
    expect(e.code).toBe('INTEGRIDAD_REFERENCIAL')
  })

  it('mensaje random sin code conocido → 500 DB_ERROR con dbMessage', () => {
    const e = mapRpcError(mkErr('algo raro pasó'))
    expect(e.status).toBe(500)
    expect(e.code).toBe('DB_ERROR')
    expect(e.detail).toEqual({ dbMessage: 'algo raro pasó' })
  })
})

// ── El service propaga HttpError cuando la RPC devuelve error ─
describe('comprarItemViaRPC propaga HttpError', () => {
  const itemId = 99
  const userId = 'user-uuid'
  const token  = 'jwt-token'
  const dto    = { proveedor_id: 1, precio_unit: 10, factura_id: null }

  beforeEach(() => {
    process.env.USE_RPC_RESOLVER = 'true'
  })

  it('ITEM_NO_EXISTE → lanza HttpError 404', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'ITEM_NO_EXISTE', code: '', details: '', hint: '', name: 'PostgrestError' },
    })

    await expect(
      solicitudesService.comprarItem(itemId, dto as any, token, userId),
    ).rejects.toMatchObject({ status: 404, code: 'ITEM_NO_EXISTE' })
  })

  it('ITEM_YA_REGISTRADO → lanza HttpError 409', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'ITEM_YA_REGISTRADO', code: '', details: '', hint: '', name: 'PostgrestError' },
    })

    await expect(
      solicitudesService.comprarItem(itemId, dto as any, token, userId),
    ).rejects.toMatchObject({ status: 409, code: 'ITEM_YA_REGISTRADO' })
  })

  it('STOCK_INSUFICIENTE → 400 con detail JSON', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'STOCK_INSUFICIENTE',
        code: '',
        details: JSON.stringify({ material_id: 3, stock_actual: 1, cantidad_solicitada: 5 }),
        hint: '',
        name: 'PostgrestError',
      },
    })

    try {
      await solicitudesService.comprarItem(itemId, dto as any, token, userId)
      expect.fail('debería haber lanzado')
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpError)
      expect(err.status).toBe(400)
      expect(err.code).toBe('STOCK_INSUFICIENTE')
      expect(err.detail).toEqual({ material_id: 3, stock_actual: 1, cantidad_solicitada: 5 })
    }
  })
})

// ── Propagación de errores en el despacho ─────────────────────
// Simétrico con comprarItemViaRPC: confirmamos que mapRpcError se
// aplica al camino RPC de despachar también.
describe('despacharItemViaRPC propaga HttpError', () => {
  const itemId = 77
  const userId = 'user-uuid'
  const token  = 'jwt-token'
  const dto    = { precio_unit: 50 }

  beforeEach(() => {
    process.env.USE_RPC_RESOLVER = 'true'
  })

  it('STOCK_INSUFICIENTE → 400 con detail JSON {material_id, stock_actual, cantidad_solicitada}', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'STOCK_INSUFICIENTE',
        code: '',
        details: JSON.stringify({ material_id: 3, stock_actual: 1, cantidad_solicitada: 5 }),
        hint: '',
        name: 'PostgrestError',
      },
    })

    try {
      await solicitudesService.despacharItem(itemId, dto as any, token, userId)
      expect.fail('debería haber lanzado')
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpError)
      expect(err.status).toBe(400)
      expect(err.code).toBe('STOCK_INSUFICIENTE')
      expect(err.detail).toEqual({ material_id: 3, stock_actual: 1, cantidad_solicitada: 5 })
    }
  })

  it('ITEM_NO_DISPONIBLE → lanza HttpError 404', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'ITEM_NO_DISPONIBLE', code: '', details: '', hint: '', name: 'PostgrestError' },
    })

    await expect(
      solicitudesService.despacharItem(itemId, dto as any, token, userId),
    ).rejects.toMatchObject({ status: 404, code: 'ITEM_NO_DISPONIBLE' })
  })
})
