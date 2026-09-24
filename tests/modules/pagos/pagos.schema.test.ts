/**
 * Schemas del módulo Pagos: el PATCH es .strict() (nada de `estado`,
 * `aprobada_por`, `pagada_al_cargar`, `created_by` por la puerta de atrás),
 * las listas cerradas coinciden con el DDL, las líneas de OP son factura o
 * a cuenta, y la nota de crédito es un comprobante propio (20260925a).
 */
import { describe, it, expect } from 'vitest'
import {
  UpdateFacturaSchema, CreateFacturaSchema, CreateOrdenSchema, LineaOrdenSchema, UpdateOrdenSchema,
  DatosPagoSchema, UpdateProveedorSchema, CAMPOS_QUE_DESAPRUEBAN, CAMPOS_CONGELADOS,
  FORMAS_PAGO_OP, FORMAS_PAGO_OP_GUARDADAS, FORMAS_PREVISTAS, TIPOS_LINEA, TIPOS_LINEA_ENTRADA, TIPOS_ADJ_ORDEN, ListFacturasQuerySchema,
  AplicarNcSchema, CLASES, FacturasResumenQuerySchema,
} from '../../../src/modules/pagos/pagos.schema.js'
import * as schema from '../../../src/modules/pagos/pagos.schema.js'
import { CBTE_TIPOS_NC } from '../../../src/modules/pagos/lectura/arca.js'

// Lo que dice el trigger `fn_pagos_factura_desaprobar` (migración de pagos, §4.2 del diseño).
const DDL_DESAPRUEBAN = ['proveedor_id', 'fecha', 'total', 'neto', 'iva', 'percepciones', 'otros', 'no_gravado', 'exento', 'paga_cliente', 'vence_el', 'forma_pago_prevista']
// Lo que dice `trg_pagos_factura_congelada` (before update of …).
const DDL_CONGELADOS = ['proveedor_id', 'fecha', 'neto', 'iva', 'percepciones', 'otros', 'no_gravado', 'exento', 'total']

describe('listas cerradas = DDL', () => {
  it('CAMPOS_QUE_DESAPRUEBAN es exactamente la lista del trigger', () => {
    expect([...CAMPOS_QUE_DESAPRUEBAN].sort()).toEqual([...DDL_DESAPRUEBAN].sort())
  })
  it('CAMPOS_CONGELADOS es exactamente la lista del trigger de congelado', () => {
    expect([...CAMPOS_CONGELADOS].sort()).toEqual([...DDL_CONGELADOS].sort())
  })
  it('numero, tipo_comprobante, descripcion y obs NO desaprueban ni se congelan', () => {
    for (const k of ['numero', 'tipo_comprobante', 'descripcion', 'obs']) {
      expect(CAMPOS_QUE_DESAPRUEBAN as readonly string[]).not.toContain(k)
      expect(CAMPOS_CONGELADOS as readonly string[]).not.toContain(k)
    }
  })
  it('la forma real de una OP no admite cta_cte, nota_credito ni aplicacion_anticipo (decisión 7)', () => {
    expect(FORMAS_PAGO_OP as readonly string[]).not.toContain('cta_cte')
    expect(FORMAS_PAGO_OP as readonly string[]).not.toContain('nota_credito')
    expect(FORMAS_PAGO_OP as readonly string[]).not.toContain('aplicacion_anticipo')
    expect(FORMAS_PREVISTAS as readonly string[]).toContain('cta_cte')   // prevista sí: «quedó en cuenta corriente»
    // Lo guardado (CHECK de pagos_ordenes) sí incluye nota_credito: la pone el backend cuando no sale plata.
    expect([...FORMAS_PAGO_OP_GUARDADAS]).toEqual([...FORMAS_PAGO_OP, 'nota_credito'])
  })
  it('tipos de línea: guardadas incluyen la NC histórica; de entrada solo factura y a cuenta (20260925a)', () => {
    expect([...TIPOS_LINEA]).toEqual(['factura', 'a_cuenta', 'nota_credito'])
    expect([...TIPOS_LINEA_ENTRADA]).toEqual(['factura', 'a_cuenta'])
    expect([...CLASES]).toEqual(['factura', 'nota_credito'])
    // Los mismos códigos que el CHECK pagos_facturas_nc_chk.
    expect([...CBTE_TIPOS_NC]).toEqual([3, 8, 13, 53, 203, 208, 213])
    expect(TIPOS_ADJ_ORDEN as readonly string[]).toContain('nota_credito')
    expect(TIPOS_ADJ_ORDEN as readonly string[]).not.toContain('retencion')
  })
})

describe('UpdateFacturaSchema (.strict)', () => {
  it('acepta lo editable', () => {
    const r = UpdateFacturaSchema.safeParse({ numero: '0001-00000007', obs: 'x', vence_el: '2026-10-01', imputaciones: [{ obra_cod: 'CC 1', monto: 10 }], motivo: 'reclasifico' })
    expect(r.success).toBe(true)
  })
  it.each(['estado', 'aprobada_por', 'aprobada_at', 'pagada_al_cargar', 'created_by', 'numero_norm', 'imputable'])(
    'rechaza `%s` por la puerta de atrás', (k) => {
      const r = UpdateFacturaSchema.safeParse({ [k]: 'pagada' })
      expect(r.success).toBe(false)
    })
  it('un patch vacío es válido (el service no hace nada)', () => {
    expect(UpdateFacturaSchema.safeParse({}).success).toBe(true)
  })
})

describe('CreateFacturaSchema', () => {
  // `numero` entró al mínimo el 2026-09-21: cargar una factura sin número
  // dejó de estar permitido (decisión del dueño). La pantalla lo pide en dos
  // campos, punto de venta y comprobante, y manda el compuesto.
  const base = {
    proveedor_id: 1, tipo_comprobante: 'A', numero: '0013-00402141',
    fecha: '2026-09-18', total: 1210, descripcion: 'Hierro 8 mm',
    imputaciones: [{ obra_cod: 'CC 1', monto: 1210 }],
  }
  it('plan de cheques (20260923n): cantidad 1–24, primer cobro fecha, cada 1–365; null lo borra', () => {
    const ok = { cantidad: 6, primer_cobro: '2026-10-23', cada_dias: 30 }
    expect(CreateFacturaSchema.safeParse({ ...base, plan_cheques: ok }).success).toBe(true)
    expect(CreateFacturaSchema.safeParse({ ...base, plan_cheques: null }).success).toBe(true)
    expect(CreateFacturaSchema.safeParse({ ...base, plan_cheques: { ...ok, cantidad: 0 } }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, plan_cheques: { ...ok, cantidad: 25 } }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, plan_cheques: { ...ok, primer_cobro: '23/10/2026' } }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, plan_cheques: { ...ok, extra: 1 } }).success).toBe(false)
    expect(UpdateFacturaSchema.safeParse({ plan_cheques: ok }).success).toBe(true)
  })

  it('mínimo: proveedor, tipo, NÚMERO, fecha, total, descripción e imputaciones', () => {
    const r = CreateFacturaSchema.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.forma_pago_prevista).toBe('transferencia')
      expect(r.data.paga_cliente).toBe(false)
    }
  })
  it('descripción obligatoria (min 3) y total > 0', () => {
    expect(CreateFacturaSchema.safeParse({ ...base, descripcion: 'ab' }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, total: 0 }).success).toBe(false)
  })
  it('el número es OBLIGATORIO: sin él, vacío o null, no pasa', () => {
    const { numero: _, ...sinNumero } = base
    expect(CreateFacturaSchema.safeParse(sinNumero).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, numero: '' }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, numero: '   ' }).success).toBe(false)
    expect(CreateFacturaSchema.safeParse({ ...base, numero: null }).success).toBe(false)
  })
  it('al EDITAR no se puede borrar el número, pero se puede no mandarlo', () => {
    // Omitirlo = «no lo toques»: las viejas sin número se siguen editando.
    expect(UpdateFacturaSchema.safeParse({ descripcion: 'otra cosa' }).success).toBe(true)
    expect(UpdateFacturaSchema.safeParse({ numero: '0013-00402141' }).success).toBe(true)
    expect(UpdateFacturaSchema.safeParse({ numero: '' }).success).toBe(false)
    expect(UpdateFacturaSchema.safeParse({ numero: null }).success).toBe(false)
  })
  it('«Ya está pagada»: la orden lleva fecha y forma real; no admite cta_cte', () => {
    expect(CreateFacturaSchema.safeParse({ ...base, orden: { fecha: '2026-09-18', forma_pago: 'tarjeta' } }).success).toBe(true)
    expect(CreateFacturaSchema.safeParse({ ...base, orden: { fecha: '2026-09-18', forma_pago: 'cta_cte' } }).success).toBe(false)
  })
})

describe('líneas de OP (la NC ya no es línea, 20260925a)', () => {
  it('a_cuenta sin factura; factura con factura; nota_credito rechazada', () => {
    expect(LineaOrdenSchema.safeParse({ tipo: 'a_cuenta', monto: 100 }).success).toBe(true)
    expect(LineaOrdenSchema.safeParse({ tipo: 'a_cuenta', factura_id: 3, monto: 100 }).success).toBe(false)
    expect(LineaOrdenSchema.safeParse({ tipo: 'factura', monto: 100 }).success).toBe(false)
    expect(LineaOrdenSchema.safeParse({ factura_id: 3, monto: 100 }).success).toBe(true)   // default tipo = factura
    expect(LineaOrdenSchema.safeParse({ tipo: 'nota_credito', factura_id: 3, monto: 100, nc_numero: '0001-00000009', nc_fecha: '2026-09-10' }).success).toBe(false)
  })
  it('CreateOrdenSchema: la misma factura dos veces es LINEA_DUPLICADA', () => {
    const base = { proveedor_id: 1, fecha: '2026-09-18', forma_pago: 'transferencia' }
    const dup = CreateOrdenSchema.safeParse({ ...base, lineas: [{ factura_id: 3, monto: 10 }, { factura_id: 3, monto: 5 }] })
    expect(dup.success).toBe(false)
    if (!dup.success) expect(JSON.stringify(dup.error.issues)).toContain('LINEA_DUPLICADA')
  })
  it('CreateOrdenSchema: forma_pago null pasa el schema (el service responde FORMA_PAGO_REQUERIDA en el campo); adjuntos default []', () => {
    const r = CreateOrdenSchema.safeParse({ proveedor_id: 1, fecha: '2026-09-18', forma_pago: null, lineas: [{ factura_id: 3, monto: 5 }] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.adjuntos).toEqual([])
  })
  it('el schema de la devolución del proveedor ya no existe', () => {
    expect('DevolucionProveedorSchema' in schema).toBe(false)
  })
  it('UpdateOrdenSchema solo obs y referencia', () => {
    expect(UpdateOrdenSchema.safeParse({ obs: 'x', referencia: 'y' }).success).toBe(true)
    expect(UpdateOrdenSchema.safeParse({ monto: 1 }).success).toBe(false)
    expect(UpdateOrdenSchema.safeParse({ cbu_destino: '1' }).success).toBe(false)
  })
})

describe('nota de crédito como comprobante (20260925a)', () => {
  const NC = {
    proveedor_id: 1, tipo_comprobante: 'A', numero: '0001-00000012', fecha: '2026-09-18', total: 300,
    descripcion: 'Devolución de soga', imputaciones: [{ obra_cod: 'CC 1', monto: 300 }], clase: 'nota_credito', cbte_tipo_arca: 3,
  }
  const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
    (r.error?.issues ?? []).map((i) => `${i.path.join('.')}:${i.message}`)

  it('clase default factura; una NC mínima pasa (sin aplica_a = crédito a favor)', () => {
    const f = CreateFacturaSchema.parse({ ...NC, clase: undefined, cbte_tipo_arca: undefined })
    expect(f.clase).toBe('factura')
    expect(CreateFacturaSchema.safeParse(NC).success).toBe(true)
    expect(CreateFacturaSchema.safeParse({ ...NC, aplica_a: [] }).success).toBe(true)
    expect(CreateFacturaSchema.safeParse({ ...NC, cbte_tipo_arca: null }).success).toBe(true)   // la base lo deduce por la letra
  })
  it.each([3, 8, 13, 53, 203, 208, 213])('código de NC %i acepta', (cbte) => {
    const letra = [8, 208].includes(cbte) ? 'B' : [13, 213].includes(cbte) ? 'C' : 'A'
    expect(CreateFacturaSchema.safeParse({ ...NC, tipo_comprobante: letra, cbte_tipo_arca: cbte }).success).toBe(true)
  })
  it('NC con código de factura, o letra que no es A/B/C → NC_TIPO_INVALIDO', () => {
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, cbte_tipo_arca: 1 }))).toContain('cbte_tipo_arca:NC_TIPO_INVALIDO')
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, tipo_comprobante: 'recibo' }))).toContain('tipo_comprobante:NC_TIPO_INVALIDO')
  })
  it('una NC no lleva orden («ya está pagada»), vencimiento, plan de cheques ni «la paga el cliente»', () => {
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, orden: { fecha: '2026-09-18', forma_pago: 'efectivo' } }))).toContain('orden:NC_NO_SE_PAGA')
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, vence_el: '2026-10-01' }))).toContain('vence_el:NC_TIPO_INVALIDO')
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, plan_cheques: { cantidad: 1, primer_cobro: '2026-10-01', cada_dias: 30 } }))).toContain('plan_cheques:NC_TIPO_INVALIDO')
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, paga_cliente: true }))).toContain('paga_cliente:NC_TIPO_INVALIDO')
  })
  it('Σ aplica_a ≤ total (en centavos); igual al total pasa', () => {
    expect(CreateFacturaSchema.safeParse({ ...NC, aplica_a: [{ factura_id: 5, monto: 200 }, { factura_id: 6, monto: 100 }] }).success).toBe(true)
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, aplica_a: [{ factura_id: 5, monto: 200 }, { factura_id: 6, monto: 100.01 }] }))).toContain('aplica_a:NC_SUPERA_TOTAL')
    // 0,1 + 0,2 no es 0,30000000000000004 para la plata.
    expect(CreateFacturaSchema.safeParse({ ...NC, total: 0.3, imputaciones: [{ obra_cod: 'CC 1', monto: 0.3 }], aplica_a: [{ factura_id: 5, monto: 0.1 }, { factura_id: 6, monto: 0.2 }] }).success).toBe(true)
  })
  it('aplica_a: misma factura dos veces, monto 0 o más de 50 filas no pasan', () => {
    expect(issues(CreateFacturaSchema.safeParse({ ...NC, aplica_a: [{ factura_id: 5, monto: 1 }, { factura_id: 5, monto: 1 }] }))).toContain('aplica_a.1.factura_id:NC_APLICACION_INVALIDA')
    expect(CreateFacturaSchema.safeParse({ ...NC, aplica_a: [{ factura_id: 5, monto: 0 }] }).success).toBe(false)
    const muchas = Array.from({ length: 51 }, (_, i) => ({ factura_id: i + 1, monto: 1 }))
    expect(CreateFacturaSchema.safeParse({ ...NC, total: 51, imputaciones: [{ obra_cod: 'CC 1', monto: 51 }], aplica_a: muchas }).success).toBe(false)
  })
  it('una factura no lleva aplica_a ni código de NC', () => {
    const { clase: _c, cbte_tipo_arca: _t, ...fac } = NC
    expect(CreateFacturaSchema.safeParse(fac).success).toBe(true)
    expect(issues(CreateFacturaSchema.safeParse({ ...fac, aplica_a: [{ factura_id: 5, monto: 1 }] }))).toContain('aplica_a:NC_TIPO_INVALIDO')
    expect(issues(CreateFacturaSchema.safeParse({ ...fac, cbte_tipo_arca: 3 }))).toContain('cbte_tipo_arca:NC_TIPO_INVALIDO')
  })
  it('PATCH: aplica_a sí, clase no (.strict)', () => {
    expect(UpdateFacturaSchema.safeParse({ aplica_a: [{ factura_id: 5, monto: 10 }] }).success).toBe(true)
    expect(UpdateFacturaSchema.safeParse({ aplica_a: [] }).success).toBe(true)
    expect(UpdateFacturaSchema.safeParse({ clase: 'factura' }).success).toBe(false)
  })
  it('AplicarNcSchema: al menos una, sin repetir, estricto', () => {
    expect(AplicarNcSchema.safeParse({ aplica_a: [{ factura_id: 5, monto: 10 }] }).success).toBe(true)
    expect(AplicarNcSchema.safeParse({ aplica_a: [] }).success).toBe(false)
    expect(AplicarNcSchema.safeParse({ aplica_a: [{ factura_id: 5, monto: 10 }], extra: 1 }).success).toBe(false)
    expect(AplicarNcSchema.safeParse({ aplica_a: [{ factura_id: 5, monto: 10, nc_id: 1 }] }).success).toBe(false)
  })
  it('filtros: clase y con_credito en la bandeja y en el resumen', () => {
    expect(ListFacturasQuerySchema.parse({ clase: 'nota_credito', con_credito: '1' })).toMatchObject({ clase: 'nota_credito', con_credito: '1' })
    expect(ListFacturasQuerySchema.safeParse({ clase: 'recibo' }).success).toBe(false)
    expect(FacturasResumenQuerySchema.parse({ clase: 'factura' }).clase).toBe('factura')
  })
})

describe('proveedores', () => {
  it('DatosPagoSchema (la puerta del contador) rechaza razon_social y cuit', () => {
    expect(DatosPagoSchema.safeParse({ cbu: '0170099220000123456788', banco: 'Galicia' }).success).toBe(true)
    expect(DatosPagoSchema.safeParse({ razon_social: 'Otro' }).success).toBe(false)
    expect(DatosPagoSchema.safeParse({ cuit: '30577428618' }).success).toBe(false)
  })
  it('UpdateProveedorSchema rechaza activo/baja_*', () => {
    expect(UpdateProveedorSchema.safeParse({ activo: false }).success).toBe(false)
    expect(UpdateProveedorSchema.safeParse({ baja_motivo: 'x' }).success).toBe(false)
  })
})

describe('ListFacturasQuerySchema', () => {
  it('defaults: orden vencimiento, 50 por página; limit tope 500', () => {
    const r = ListFacturasQuerySchema.parse({})
    expect(r.orden).toBe('vencimiento'); expect(r.limit).toBe(50); expect(r.offset).toBe(0)
    expect(ListFacturasQuerySchema.safeParse({ limit: '501' }).success).toBe(false)
    expect(ListFacturasQuerySchema.parse({ limit: '500', proveedor_id: '7' }).proveedor_id).toBe(7)
  })
})
