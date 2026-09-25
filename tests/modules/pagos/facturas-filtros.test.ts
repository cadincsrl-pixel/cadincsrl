/**
 * Chips = lista (CLAUDE.md §5.9, 20260929o). La bandeja de Compras › Facturas
 * y sus chips/KPI (`GET /facturas/resumen`) tienen que filtrar EXACTAMENTE lo
 * mismo: el resumen junta los ids con `aplicarFiltrosFacturas` y la RPC solo
 * agrega. Hasta ese día el resumen recibía un subconjunto y, con «Sin
 * adjunto» tildado, la lista daba 0 y los chips seguían contando todo.
 *
 * Si alguien agrega un filtro a la lista y no llega al resumen (o al revés),
 * o agrega una clave al schema que la lista no aplica, esto falla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Llamada = [string, unknown[]]
const { state } = vi.hoisted(() => ({
  state: {
    profile: null as Record<string, unknown> | null,
    // Llamadas al query builder de v_pagos_facturas, por request.
    vista: [] as Llamada[][],
    rpcs: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
    filas: [] as Array<{ id: number }>,
  },
}))

vi.mock('../../../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-1', email: 'x@example.com', role: 'authenticated' })
    c.set('accessToken', 'jwt-mock')
    await next()
  },
}))
vi.mock('../../../src/modules/admin/audit.service.js', () => ({ auditService: { log: vi.fn() } }))

/** Query builder que anota cada método (menos `then`) y devuelve `data`. */
function grabador(data: unknown, log?: Llamada[]) {
  const obj: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (ok: any, ko: any) => Promise.resolve({
          data, error: null, count: Array.isArray(data) ? data.length : null,
        }).then(ok, ko)
      }
      const uno = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null })
      if (prop === 'single' || prop === 'maybeSingle') return uno
      return (...args: unknown[]) => { log?.push([prop, args]); return obj }
    },
  })
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => {
      if (t === 'profiles') return grabador(state.profile)
      if (t === 'v_pagos_facturas') {
        const log: Llamada[] = []
        state.vista.push(log)
        return grabador(state.filas, log)
      }
      return grabador([])
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      return { data: [], error: null }
    },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import pagos from '../../../src/modules/pagos/pagos.routes.js'
import { ListFacturasQuerySchema, FacturasResumenQuerySchema } from '../../../src/modules/pagos/pagos.schema.js'
import { aplicarFiltrosFacturas } from '../../../src/modules/pagos/pagos.service.js'

/**
 * Un valor de query string por filtro, que filtra. Una clave nueva en
 * `ListFacturasQuerySchema` sin muestra acá hace fallar el primer test: hay
 * que agregarla (y así se prueba que llega a la lista Y al resumen).
 */
const MUESTRA: Record<string, string> = {
  q: 'hierro',
  proveedor_id: '3',
  obra_cod: 'OB1',
  centro_costo: 'CC',
  estado: 'aprobada',
  tipo: 'A',
  forma_pago: 'transferencia',
  vencimiento: '30',
  desde: '2026-07-01',
  hasta: '2026-07-31',
  sin_adjunto: '1',
  sin_numero: '1',
  sin_revisar: '1',
  sin_desglose: '1',
  paga_cliente: '0',
  pagada_al_cargar: '1',
  cuenta_cambiada: '1',
  es_interna: '1',
  anuladas: '1',
  archivadas: '1',
  clase: 'factura',
  con_credito: '1',
  concepto_id: '2',
  periodo_iva: '2026-08',
  periodo_iva_distinto: '1',
  sin_imputar: '0',
  pago_a_reconstruir: '0',
  tributos_a_revisar: '1',
  origen_carga: 'arca_recibidos',
  importacion_id: '12',
}
const NO_SON_FILTROS = new Set(['orden', 'limit', 'offset'])
const FILTROS = Object.keys(ListFacturasQuerySchema.shape).filter((k) => !NO_SON_FILTROS.has(k))

/** Solo los filtros: se sacan select/order/range, que son propios de cada consulta. */
const soloFiltros = (log: Llamada[]) => log.filter(([m]) => !['select', 'order', 'range'].includes(m))

const PERFIL = { rol: 'operador', activo: true, rol_base: null, permisos: { pagos: { lectura: true, tabs: ['facturas'] } } }

beforeEach(() => {
  state.profile = PERFIL
  state.vista.length = 0
  state.rpcs.length = 0
  state.filas = []
})

describe('filtros de la bandeja de facturas', () => {
  it('cada clave del schema tiene muestra y el resumen acepta las mismas', () => {
    expect(FILTROS.filter((k) => !(k in MUESTRA))).toEqual([])
    const resumen = Object.keys(FacturasResumenQuerySchema.shape).filter((k) => k !== 'grupo').sort()
    expect(resumen).toEqual([...FILTROS].sort())
  })

  it.each(FILTROS)('«%s» cambia la consulta de la lista', (k) => {
    const sin: Llamada[] = []
    const con: Llamada[] = []
    aplicarFiltrosFacturas(grabador([], sin), ListFacturasQuerySchema.parse({}))
    aplicarFiltrosFacturas(grabador([], con), ListFacturasQuerySchema.parse({ [k]: MUESTRA[k] }))
    expect(con).not.toEqual(sin)
  })

  it.each(FILTROS)('«%s»: el resumen filtra igual que la lista', async (k) => {
    const qs = new URLSearchParams({ [k]: MUESTRA[k] ?? '' }).toString()
    expect((await pagos.request(`/facturas?${qs}`)).status).toBe(200)
    expect((await pagos.request(`/facturas/resumen?grupo=estado&${qs}`)).status).toBe(200)
    const [lista, resumen] = state.vista
    expect(lista).toBeDefined()
    expect(soloFiltros(resumen ?? [])).toEqual(soloFiltros(lista ?? []))
  })

  it('con todos los filtros juntos, lo mismo; y la RPC recibe los ids de esa consulta', async () => {
    state.filas = [{ id: 7 }, { id: 9 }]
    const qs = new URLSearchParams(MUESTRA).toString()
    await pagos.request(`/facturas?${qs}`)
    await pagos.request(`/facturas/resumen?grupo=proveedor&${qs}`)
    const [lista, resumen] = state.vista
    expect(soloFiltros(resumen ?? [])).toEqual(soloFiltros(lista ?? []))
    expect(state.rpcs.find((r) => r.fn === 'pagos_resumen')?.args).toEqual({ p_grupo: 'proveedor', p_ids: [7, 9], p_archivadas: true })
  })
})

describe('buscar por número de comprobante completo', () => {
  const buscar = (q: string) => {
    const log: Llamada[] = []
    aplicarFiltrosFacturas(grabador([], log), ListFacturasQuerySchema.parse({ q }))
    return {
      norm: log.filter(([m, a]) => m === 'eq' && a[0] === 'numero_norm').map(([, a]) => a[1]),
      busq: log.filter(([m, a]) => m === 'ilike' && a[0] === 'busq').map(([, a]) => a[1]),
    }
  }

  it('0005-… y 00005-… buscan exacto por numero_norm, no por substring', () => {
    expect(buscar('00005-00025267')).toEqual({ norm: ['5-25267'], busq: [] })
    expect(buscar('0005-00025267')).toEqual({ norm: ['5-25267'], busq: [] })
    expect(buscar('0005 00025267')).toEqual({ norm: ['5-25267'], busq: [] })
    expect(buscar('000500025267')).toEqual({ norm: ['5-25267'], busq: [] })
  })

  it('el número parcial y el texto siguen yendo a busq', () => {
    expect(buscar('25267')).toEqual({ norm: [], busq: ['%25267%'] })
    expect(buscar('voltaje 0005-00025267')).toEqual({ norm: ['5-25267'], busq: ['%voltaje%'] })
    // Un CUIT (con o sin guiones) no es un número de factura.
    expect(buscar('30-57742861-8').norm).toEqual([])
    expect(buscar('30577428618').norm).toEqual([])
  })

  it('llega igual al resumen', async () => {
    await pagos.request('/facturas?q=00005-00025267')
    await pagos.request('/facturas/resumen?q=00005-00025267')
    const [lista, resumen] = state.vista
    expect(soloFiltros(lista ?? [])).toContainEqual(['eq', ['numero_norm', '5-25267']])
    expect(soloFiltros(resumen ?? [])).toEqual(soloFiltros(lista ?? []))
  })
})
