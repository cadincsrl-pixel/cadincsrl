/**
 * «Soltá acá los cheques» en Ventas › Cobranzas (2026-09-25): el cliente por
 * el librador y la lectura de POST /cobros/cheques/leer (avisos de cheque ya
 * cobrado o en cartera). La IA y el bucket van mockeados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { tablas, ia } = vi.hoisted(() => ({
  tablas: {} as Record<string, unknown[]>,
  ia: { res: null as unknown },
}))

function chain(data: unknown) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit', 'gte', 'lte', 'ilike']) obj[m] = () => obj
  obj.then = (ok: any, ko: any) => Promise.resolve({ data, error: null }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: { from: (t: string) => chain(tablas[t] ?? []), rpc: vi.fn(), storage: { from: vi.fn() } },
  createSupabaseClient: vi.fn(),
}))
vi.mock('../../../src/modules/facturacion/cobros.service.js', () => ({
  descargarAdjuntoPendiente: vi.fn(async () => ({ buf: Buffer.from('x'), hash: 'a'.repeat(64), size: 1 })),
}))
vi.mock('../../../src/modules/pagos/lectura/cheque-ia.js', () => ({
  leerChequeConIA: vi.fn(async () => ia.res),
}))

import { chequesCobroService, clienteDelCheque } from '../../../src/modules/facturacion/cheques-cobro.service.js'

const CLIENTES = [
  { id: 1, razon_social: 'MAGHREB S.A.', doc_nro: '30716871009' },
  { id: 2, razon_social: 'PROSAL SA', doc_nro: null },
  { id: 3, razon_social: 'Norte Constructora', doc_nro: null },
  { id: 4, razon_social: 'NORTE OBRAS SRL', doc_nro: null },
]

describe('el cliente que dio el cheque (clienteDelCheque)', () => {
  it('por CUIT manda aunque el nombre no se parezca', () => {
    expect(clienteDelCheque({ librador: 'otro', librador_cuit: '30716871009' }, CLIENTES)).toMatchObject({ id: 1, por: 'cuit' })
  })
  it('por nombre, sin la forma societaria', () => {
    expect(clienteDelCheque({ librador: 'Prosal S.A.', librador_cuit: null }, CLIENTES)).toMatchObject({ id: 2, por: 'nombre' })
  })
  it('con dos candidatos o sin librador no adivina', () => {
    expect(clienteDelCheque({ librador: 'Norte', librador_cuit: null }, CLIENTES)).toBeNull()
    expect(clienteDelCheque({ librador: null, librador_cuit: null }, CLIENTES)).toBeNull()
  })
})

const lectura = (o: Record<string, unknown> = {}) => ({
  legible: true, numero: '00012345', banco: 'Banco Macro', sucursal: null, fecha_emision: '2026-09-20', fecha_pago: '2026-10-20',
  importe: 150000, importe_en_letras: null, importe_letras_coincide: true, librador: 'MAGHREB SA', librador_cuit: '30716871009',
  es_echeq: false, es_diferido: true, es_endoso: false, a_la_orden_de: 'CADINC SRL', entregado_a: 'CADINC SRL', entregado_a_cuit: null,
  notas: null, ...o,
})
const DTO = { storage_path: 'cobros/pendientes/x.pdf', nombre_archivo: 'cheques.pdf', mime: 'application/pdf' as const }

describe('POST /cobros/cheques/leer (chequesCobroService.leer)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tablas)) delete tablas[k]
    tablas.ventas_clientes = CLIENTES
  })

  it('lee cada cheque del archivo y reconoce al cliente', async () => {
    ia.res = { ok: true, modelo: 'm', lecturas: [lectura(), lectura({ numero: '999', librador: 'Tercero SA', librador_cuit: null, importe: 5000 })] }
    const r = await chequesCobroService.leer(DTO)
    expect(r.cheques).toHaveLength(2)
    expect(r.cheques[0]).toMatchObject({ propuesta: { numero: '00012345', importe: 150000, fecha_cobro: '2026-10-20' }, cliente: { id: 1, por: 'cuit' } })
    expect(r.cheques[1]!.cliente).toBeNull()
    expect(r.adjunto).toMatchObject({ storage_path: 'cobros/pendientes/x.pdf', size: 1 })
  })

  it('avisa si el cheque ya está en otro cobro vigente, o si ya está en la cartera', async () => {
    ia.res = { ok: true, modelo: 'm', lecturas: [lectura(), lectura({ numero: '777', importe: 20000 })] }
    tablas.ventas_cobro_medios = [{ cobro_id: 9, cheque_numero: '12345', importe: '150000.00' }]
    tablas.ventas_cobros = [{ id: 9 }]
    tablas.cheques_recibidos = [{ numero_norm: '777', importe: 20000, estado: 'en_cartera' }]
    const r = await chequesCobroService.leer(DTO)
    expect(r.cheques[0]).toMatchObject({ cobro_existente_id: 9 })
    expect(r.cheques[0]!.avisos[0]).toMatchObject({ codigo: 'CHEQUE_YA_COBRADO', severidad: 'error' })
    expect(r.cheques[1]!.avisos.map((a) => a.codigo)).toContain('CHEQUE_EN_CARTERA')
  })

  it('sin nada legible: 422 CHEQUE_ILEGIBLE', async () => {
    ia.res = { ok: true, modelo: 'm', lecturas: [lectura({ legible: false, notas: 'borroso' })] }
    await expect(chequesCobroService.leer(DTO)).rejects.toMatchObject({ status: 422, code: 'CHEQUE_ILEGIBLE' })
    ia.res = { ok: false, motivo: 'SIN_API_KEY', modelo: null }
    await expect(chequesCobroService.leer(DTO)).rejects.toMatchObject({ code: 'CHEQUE_ILEGIBLE' })
  })
})

describe('auditoría', () => {
  it('POST /cobros/cheques/leer se registra como lectura, no como alta de cobro', async () => {
    const { parseRoute } = await import('../../../src/middleware/audit.js')
    expect(parseRoute('/api/facturacion/cobros/cheques/leer', 'POST'))
      .toEqual({ modulo: 'facturacion', entidad: 'cheques del cliente', accion: 'leer comprobante' })
  })
})
