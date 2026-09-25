/**
 * Copia del aviso de pago a Compras (20260929x). Dueño: «junto al contador
 * necesito que los comprobantes se envíen a compras».
 *
 *   · Compras recibe EXACTAMENTE el paquete del contador: comprobante, los
 *     archivos de los cheques/e-cheq y las facturas. El proveedor, solo el
 *     comprobante.
 *   · Es un mail propio (destinatario 'compras'), con su fila en el historial.
 *   · Sin dirección configurada queda «omitido», no se cae.
 *   · Tampoco a Compras le llega el CBU.
 *
 * El SMTP está mockeado: no sale ningún mail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
const { state, enviarMail } = vi.hoisted(() => ({
  enviarMail: vi.fn(async () => ({ messageId: 'm-1' })),
  state: {
    config: {} as Fila,
    avisos: [] as Fila[],
  },
}))

vi.mock('../../../src/lib/mail.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/mail.js')>()
  return { ...real, enviarMail, estaConfigurado: () => true, loQueFalta: () => [] }
})
vi.mock('../../../src/lib/empresa.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/empresa.js')>()
  return { ...real, getEmpresa: async () => ({ ...real.empresaDefault(), nombre_fantasia: 'CADINC' }) }
})

const ORDEN = {
  id: 20, numero: 250, numero_fmt: 'OP-0250', estado: 'emitida', fecha: '2026-09-25', forma_pago: 'echeq',
  monto_pagado: 1000, proveedor_id: 1, proveedor_nom: 'NORTE SRL', proveedor_cuit: '30714014346',
  proveedor_email: 'prov@norte.com', cbu_destino: '0070399520000003055000', alias_destino: 'norte.distrib',
}
const ADJ_ORDEN = [
  { id: 1, tipo: 'cheque', storage_path: 'ordenes/20/ch.pdf', nombre_archivo: 'cheque-3079.pdf', mime_type: 'application/pdf' },
  { id: 2, tipo: 'recibo_proveedor', storage_path: 'ordenes/20/rec.pdf', nombre_archivo: 'recibo.pdf', mime_type: 'application/pdf' },
]
const ADJ_FACTURA = [{ id: 9, tipo: 'factura', storage_path: 'facturas/5/f.pdf', nombre_archivo: 'factura-A-194.pdf', mime_type: 'application/pdf' }]

function chain(tabla: string) {
  const obj: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit']) obj[m] = () => obj
  obj.insert = (x: Fila) => { if (tabla === 'pagos_ordenes_avisos') state.avisos.push(x); return Promise.resolve({ error: null }) }
  const data = (): unknown => {
    switch (tabla) {
      case 'v_pagos_ordenes': return ORDEN
      case 'pagos_orden_lineas': return [{ factura_id: 5, tipo: 'factura', monto: 1000, factura: { tipo_comprobante: 'A', numero: '00011-00000194', fecha: '2026-09-01' } }]
      case 'pagos_cheques': return [{ numero: '3079', banco: 'Galicia', fecha_cobro: '2026-10-25', monto: 1000 }]
      case 'pagos_ordenes_adjuntos': return ADJ_ORDEN
      case 'pagos_facturas_adjuntos': return ADJ_FACTURA
      case 'pagos_proveedor_contactos': return []
      default: return []
    }
  }
  obj.maybeSingle = () => Promise.resolve({ data: data(), error: null })
  obj.then = (ok: any, ko: any) => Promise.resolve({ data: data(), error: null, count: 0 }).then(ok, ko)
  return obj
}

vi.mock('../../../src/lib/supabase.js', () => {
  const cliente = () => ({
    from: (t: string) => chain(t),
    rpc: async (fn: string) => (fn === 'pagos_config_json' ? { data: state.config, error: null } : { data: null, error: null }),
    storage: { from: () => ({ download: async () => ({ data: new Blob(['%PDF']), error: null }) }) },
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  })
  return { createSupabaseClient: () => cliente(), supabase: cliente() }
})

import { avisoPagoService } from '../../../src/modules/pagos/aviso-pago.service.js'
import { pagosConfigService } from '../../../src/modules/pagos/config.service.js'
import { AvisarPagoSchema } from '../../../src/modules/pagos/pagos.schema.js'

type Mail = { para: string; asunto: string; texto: string; html: string; adjuntos?: { filename: string }[] }
const mails = () => (enviarMail.mock.calls as unknown as [Mail][]).map((c) => c[0])

beforeEach(() => {
  enviarMail.mockClear()
  state.avisos = []
  state.config = { aviso_contador_email: 'estudio@contable.com.ar', aviso_compras_email: 'comprascadinc@gmail.com' }
  pagosConfigService.olvidarCache()
})

describe('aviso de pago → Compras', () => {
  it('Compras recibe el mismo paquete que el contador, en un mail propio', async () => {
    const r = await avisoPagoService.avisar(20, { a_proveedor: false, a_contador: true, a_compras: true }, 'u-1', 'jwt')
    expect(r.resultados.map((x) => [x.destinatario, x.estado, x.email])).toEqual([
      ['contador', 'enviado', 'estudio@contable.com.ar'],
      ['compras', 'enviado', 'comprascadinc@gmail.com'],
    ])
    const [contador, compras] = mails()
    expect(compras!.para).toBe('comprascadinc@gmail.com')
    const nombres = (m: Mail) => (m.adjuntos ?? []).map((a) => a.filename)
    expect(nombres(compras!)).toEqual(['cheque-3079.pdf', 'factura-A-194.pdf'])
    expect(nombres(compras!)).toEqual(nombres(contador!))
    // Nunca el recibo del proveedor.
    expect(nombres(compras!)).not.toContain('recibo.pdf')
    expect(state.avisos.map((a) => a.destinatario)).toEqual(['contador', 'compras'])
  })

  it('el mail a Compras no lleva el CBU ni el alias', async () => {
    await avisoPagoService.avisar(20, { a_proveedor: false, a_contador: false, a_compras: true }, 'u-1', 'jwt')
    const [m] = mails()
    for (const t of [m!.html, m!.texto, m!.asunto]) {
      expect(t).not.toContain('0070399520000003055000')
      expect(t).not.toContain('norte.distrib')
    }
  })

  it('sin tildar Compras no le llega nada', async () => {
    await avisoPagoService.avisar(20, { a_proveedor: true, a_contador: true }, 'u-1', 'jwt')
    expect(mails().map((m) => m.para)).not.toContain('comprascadinc@gmail.com')
    // El proveedor recibe solo lo que prueba el pago.
    const prov = mails().find((m) => m.para === 'prov@norte.com')!
    expect((prov.adjuntos ?? []).map((a) => a.filename)).toEqual(['cheque-3079.pdf'])
  })

  it('sin dirección de Compras configurada queda omitido, no se cae', async () => {
    state.config = { aviso_contador_email: 'estudio@contable.com.ar' }
    const r = await avisoPagoService.avisar(20, { a_proveedor: false, a_contador: false, a_compras: true }, 'u-1', 'jwt')
    expect(r.resultados).toEqual([expect.objectContaining({ destinatario: 'compras', estado: 'omitido', email: null })])
    expect(enviarMail).not.toHaveBeenCalled()
  })

  it('schema: a_compras solo ya es un destinatario; nada tildado sigue siendo SIN_DESTINATARIOS', () => {
    expect(AvisarPagoSchema.safeParse({ a_compras: true }).success).toBe(true)
    expect(AvisarPagoSchema.parse({ a_contador: true }).a_compras).toBe(false)
    expect(AvisarPagoSchema.safeParse({}).success).toBe(false)
  })

  it('config: compras_email viaja en GET', async () => {
    const c = await pagosConfigService.obtener()
    expect(c.aviso.compras_email).toBe('comprascadinc@gmail.com')
  })
})
