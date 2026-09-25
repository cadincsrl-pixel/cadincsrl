/**
 * «Soltá acá los comprobantes del cobro» en Ventas › Cobranzas (2026-09-25):
 * el saneo de la lectura (cheque, transferencia, orden de pago), el cliente
 * por el pagador, la cuenta de CADINC de una transferencia y los avisos de
 * cheque ya cobrado o en cartera. La IA y el bucket van mockeados.
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
vi.mock('../../../src/modules/facturacion/comprobante-cobro-ia.js', () => ({
  leerComprobanteCobroConIA: vi.fn(async () => ia.res),
}))

import {
  clienteDelPagador, comprobantesCobroService, cuentaDeTransferencia, documentoDeLectura,
} from '../../../src/modules/facturacion/comprobantes-cobro.service.js'

const CLIENTES = [
  { id: 1, razon_social: 'MAGHREB S.A.', doc_nro: '30716871009' },
  { id: 2, razon_social: 'PROSAL SA', doc_nro: null },
  { id: 3, razon_social: 'Norte Constructora', doc_nro: null },
  { id: 4, razon_social: 'NORTE OBRAS SRL', doc_nro: null },
]
const CUENTAS = [
  { id: 1, banco: 'Banco Galicia', cbu: '0070397820000000473657', alias: 'CADINC.GALICIA' },
  { id: 3, banco: 'Banco Macro', cbu: '2850140230094250465501', alias: 'SEDANTE.ATRIO.REBAJO' },
]

const lectura = (o: Record<string, unknown> = {}) => ({
  legible: true, tipo_documento: 'cheque', fecha: '2026-09-20', pagador_nombre: null, pagador_cuit: null,
  medios: [{ forma: 'cheque', importe: 150000, numero: '00012345', banco: 'Banco Macro', fecha_cobro: '2026-10-20',
    librador: 'MAGHREB SA', librador_cuit: '30716871009', cuenta_destino: null }],
  retenciones: [], comprobantes: [], total: null, notas: null, ...o,
})

describe('el cliente por el pagador (clienteDelPagador)', () => {
  it('por CUIT manda aunque el nombre no se parezca', () => {
    expect(clienteDelPagador('otro', '30716871009', CLIENTES)).toMatchObject({ id: 1, por: 'cuit' })
  })
  it('por nombre, sin la forma societaria', () => {
    expect(clienteDelPagador('Prosal S.A.', null, CLIENTES)).toMatchObject({ id: 2, por: 'nombre' })
  })
  it('con dos candidatos o sin nombre no adivina', () => {
    expect(clienteDelPagador('Norte', null, CLIENTES)).toBeNull()
    expect(clienteDelPagador(null, null, CLIENTES)).toBeNull()
  })
})

describe('la cuenta de CADINC de una transferencia (cuentaDeTransferencia)', () => {
  it('por CBU, por alias o por banco si hay una sola', () => {
    expect(cuentaDeTransferencia('CBU 2850140230094250465501', CUENTAS)).toBe(3)
    expect(cuentaDeTransferencia('alias cadinc.galicia', CUENTAS)).toBe(1)
    expect(cuentaDeTransferencia('Banco de Galicia', CUENTAS)).toBe(1)
    expect(cuentaDeTransferencia('Banco Nación', CUENTAS)).toBeNull()
    expect(cuentaDeTransferencia(null, CUENTAS)).toBeNull()
  })
})

describe('el saneo de la lectura (documentoDeLectura)', () => {
  it('foto de cheque: el cliente sale del librador si no hay pagador', () => {
    const d = documentoDeLectura(lectura(), CLIENTES, CUENTAS)
    expect(d.tipo_documento).toBe('cheque')
    expect(d.medios[0]).toMatchObject({ forma: 'cheque', numero: '00012345', importe: 150000, fecha_cobro: '2026-10-20' })
    expect(d.cliente).toMatchObject({ id: 1, por: 'cuit' })
  })

  it('transferencia: reconoce la cuenta de CADINC; si no, avisa', () => {
    const ok = documentoDeLectura(lectura({ tipo_documento: 'transferencia', pagador_nombre: 'Prosal S.A.',
      medios: [{ forma: 'transferencia', importe: 500000, numero: 'OP 998877', banco: 'Santander', fecha_cobro: '2026-09-20',
        librador: null, librador_cuit: null, cuenta_destino: 'CBU 0070397820000000473657' }] }), CLIENTES, CUENTAS)
    expect(ok.medios[0]).toMatchObject({ forma: 'transferencia', importe: 500000, cuenta_bancaria_id: 1, librador: null })
    expect(ok.cliente).toMatchObject({ id: 2 })
    const sin = documentoDeLectura(lectura({ tipo_documento: 'deposito',
      medios: [{ forma: 'deposito', importe: 1000, numero: null, banco: null, fecha_cobro: null, librador: null, librador_cuit: null, cuenta_destino: 'Banco Nación' }] }), CLIENTES, CUENTAS)
    expect(sin.medios[0]).toMatchObject({ forma: 'transferencia', cuenta_bancaria_id: null })
    expect(sin.medios[0]!.avisos.map((a) => a.codigo)).toContain('CUENTA_NO_RECONOCIDA')
    const noDice = documentoDeLectura(lectura({ tipo_documento: 'orden_pago',
      medios: [{ forma: 'transferencia', importe: 1000, numero: null, banco: 'BANCO MACRO', fecha_cobro: null, librador: null, librador_cuit: null, cuenta_destino: null }] }), CLIENTES, CUENTAS)
    expect(noDice.medios[0]!.avisos).toEqual([expect.objectContaining({ codigo: 'CUENTA_NO_INFORMADA', severidad: 'info' })])
  })

  it('orden de pago: medios, retenciones con su tipo y las facturas que paga; avisa si el total no cierra', () => {
    const d = documentoDeLectura(lectura({
      tipo_documento: 'orden_pago', pagador_nombre: 'MAGHREB S.A.', pagador_cuit: '30-71687100-9', total: 1000000,
      medios: [{ forma: 'Transferencia', importe: 950000, numero: null, banco: null, fecha_cobro: '2026-09-20', librador: null, librador_cuit: null, cuenta_destino: 'CADINC.GALICIA' }],
      retenciones: [{ tipo: 'Ingresos Brutos', jurisdiccion: 'Tucumán', certificado_numero: 'A-123', fecha: '2026-09-20', importe: 30000 },
        { tipo: 'ganancias', jurisdiccion: null, certificado_numero: null, fecha: null, importe: -15000 },
        { tipo: 'SUSS', jurisdiccion: null, certificado_numero: null, fecha: null, importe: null }],
      comprobantes: [{ tipo: 'FA', pto_vta: 4, numero: 123, importe: 700000 }, { tipo: 'FA', pto_vta: null, numero: 124, importe: 300000 }],
    }), CLIENTES, CUENTAS)
    expect(d.cliente).toMatchObject({ id: 1, por: 'cuit' })
    expect(d.retenciones).toEqual([
      { tipo: 'iibb', jurisdiccion: 'Tucumán', certificado_numero: 'A-123', fecha: '2026-09-20', importe: 30000 },
      { tipo: 'ganancias', jurisdiccion: null, certificado_numero: null, fecha: null, importe: 15000 },
    ])
    expect(d.comprobantes).toEqual([{ tipo: 'FA', pto_vta: 4, numero: 123, importe: 700000 }])
    expect(d.avisos.map((a) => a.codigo)).toContain('TOTAL_NO_CIERRA') // 950.000 + 45.000 ≠ 1.000.000
  })

  it('el total de la orden de pago puede ser el neto transferido (caso Bradel): no avisa', () => {
    const d = documentoDeLectura(lectura({
      tipo_documento: 'orden_pago', pagador_nombre: 'Prosal', total: 3114487.5,
      medios: [{ forma: 'transferencia', importe: 3114487.5, numero: '70911887', banco: 'BANCO MACRO', fecha_cobro: '2026-09-25', librador: null, librador_cuit: null, cuenta_destino: null }],
      retenciones: [{ tipo: 'iibb', jurisdiccion: null, certificado_numero: '38089', fecha: null, importe: 33062.5 },
        { tipo: 'ganancias', jurisdiccion: null, certificado_numero: '18220', fecha: null, importe: 52900 }],
      comprobantes: [{ tipo: 'FAC A', pto_vta: 2, numero: 1283, importe: 3200450 }],
    }), CLIENTES, CUENTAS)
    expect(d.avisos.map((a) => a.codigo)).not.toContain('TOTAL_NO_CIERRA')
  })
})

const DTO = { storage_path: 'cobros/pendientes/x.pdf', nombre_archivo: 'pago.pdf', mime: 'application/pdf' as const }

describe('POST /cobros/comprobantes/leer (comprobantesCobroService.leer)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tablas)) delete tablas[k]
    tablas.ventas_clientes = CLIENTES
    tablas.ventas_cuentas_bancarias = CUENTAS
  })

  it('avisa si el cheque ya está en otro cobro vigente, o si ya está en la cartera', async () => {
    ia.res = { ok: true, modelo: 'm', lectura: lectura({ medios: [
      { forma: 'cheque', importe: 150000, numero: '00012345', banco: 'Macro', fecha_cobro: '2026-10-20', librador: 'MAGHREB SA', librador_cuit: '30716871009', cuenta_destino: null },
      { forma: 'echeq', importe: 20000, numero: '777', banco: 'Galicia', fecha_cobro: '2026-10-01', librador: 'MAGHREB SA', librador_cuit: null, cuenta_destino: null },
    ] }) }
    tablas.ventas_cobro_medios = [{ cobro_id: 9, cheque_numero: '12345', importe: '150000.00' }]
    tablas.ventas_cobros = [{ id: 9 }]
    tablas.cheques_recibidos = [{ numero_norm: '777', importe: 20000 }]
    const r = await comprobantesCobroService.leer(DTO)
    expect(r.medios[0]).toMatchObject({ cobro_existente_id: 9 })
    expect(r.medios[0]!.avisos[0]).toMatchObject({ codigo: 'CHEQUE_YA_COBRADO', severidad: 'error' })
    expect(r.medios[1]!.avisos.map((a) => a.codigo)).toContain('CHEQUE_EN_CARTERA')
    expect(r.adjunto).toMatchObject({ storage_path: 'cobros/pendientes/x.pdf', size: 1 })
  })

  it('ilegible o sin IA: 422 COMPROBANTE_ILEGIBLE', async () => {
    ia.res = { ok: true, modelo: 'm', lectura: lectura({ legible: false, notas: 'borroso' }) }
    await expect(comprobantesCobroService.leer(DTO)).rejects.toMatchObject({ status: 422, code: 'COMPROBANTE_ILEGIBLE' })
    ia.res = { ok: false, motivo: 'SIN_API_KEY', modelo: null }
    await expect(comprobantesCobroService.leer(DTO)).rejects.toMatchObject({ code: 'COMPROBANTE_ILEGIBLE' })
  })
})

describe('auditoría', () => {
  it('POST /cobros/comprobantes/leer se registra como lectura, no como alta de cobro', async () => {
    const { parseRoute } = await import('../../../src/middleware/audit.js')
    expect(parseRoute('/api/facturacion/cobros/comprobantes/leer', 'POST'))
      .toEqual({ modulo: 'facturacion', entidad: 'comprobante de pago del cliente', accion: 'leer comprobante' })
  })
})
