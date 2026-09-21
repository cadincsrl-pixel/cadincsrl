/**
 * Schemas del módulo Pagos: el PATCH es .strict() (nada de `estado`,
 * `aprobada_por`, `pagada_al_cargar`, `created_by` por la puerta de atrás),
 * las listas cerradas coinciden con el DDL, y las líneas de OP siguen la
 * decisión 7 (nota de crédito como línea, con factura).
 */
import { describe, it, expect } from 'vitest'
import {
  UpdateFacturaSchema, CreateFacturaSchema, CreateOrdenSchema, LineaOrdenSchema, UpdateOrdenSchema,
  DatosPagoSchema, UpdateProveedorSchema, CAMPOS_QUE_DESAPRUEBAN, CAMPOS_CONGELADOS,
  FORMAS_PAGO_OP, FORMAS_PAGO_OP_GUARDADAS, FORMAS_PREVISTAS, TIPOS_LINEA, TIPOS_ADJ_ORDEN, ListFacturasQuerySchema,
} from '../../../src/modules/pagos/pagos.schema.js'

// Lo que dice el trigger `fn_pagos_factura_desaprobar` (migración de pagos, §4.2 del diseño).
const DDL_DESAPRUEBAN = ['proveedor_id', 'fecha', 'total', 'neto', 'iva', 'percepciones', 'otros', 'paga_cliente', 'vence_el', 'forma_pago_prevista']
// Lo que dice `trg_pagos_factura_congelada` (before update of …).
const DDL_CONGELADOS = ['proveedor_id', 'fecha', 'neto', 'iva', 'percepciones', 'otros', 'total']

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
  it('tipos de línea y de adjunto de OP: NC como línea, sin retención (decisiones 6 y 7)', () => {
    expect([...TIPOS_LINEA]).toEqual(['factura', 'a_cuenta', 'nota_credito'])
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

describe('líneas de OP (decisión 7)', () => {
  it('a_cuenta sin factura; factura y nota_credito con factura', () => {
    expect(LineaOrdenSchema.safeParse({ tipo: 'a_cuenta', monto: 100 }).success).toBe(true)
    expect(LineaOrdenSchema.safeParse({ tipo: 'a_cuenta', factura_id: 3, monto: 100 }).success).toBe(false)
    expect(LineaOrdenSchema.safeParse({ tipo: 'factura', monto: 100 }).success).toBe(false)
    expect(LineaOrdenSchema.safeParse({ factura_id: 3, monto: 100 }).success).toBe(true)   // default tipo = factura
    expect(LineaOrdenSchema.safeParse({ tipo: 'nota_credito', monto: 100 }).success).toBe(false)
    expect(LineaOrdenSchema.safeParse({ tipo: 'nota_credito', factura_id: 3, monto: 100, nc_numero: '0001-00000009', nc_fecha: '2026-09-10' }).success).toBe(true)
  })
  it('una NC lleva número Y fecha (CHECK pagos_orden_lineas_nc_chk)', () => {
    expect(LineaOrdenSchema.safeParse({ tipo: 'nota_credito', factura_id: 3, monto: 100, nc_numero: 'NC 1' }).success).toBe(false)
    expect(LineaOrdenSchema.safeParse({ tipo: 'nota_credito', factura_id: 3, monto: 100, nc_fecha: '2026-09-10' }).success).toBe(false)
  })
  it('nc_numero/nc_fecha solo en nota_credito', () => {
    expect(LineaOrdenSchema.safeParse({ factura_id: 3, monto: 100, nc_numero: 'x' }).success).toBe(false)
  })
  it('CreateOrdenSchema: la misma factura dos veces con el mismo tipo es LINEA_DUPLICADA; factura + NC de la misma factura es válido', () => {
    const base = { proveedor_id: 1, fecha: '2026-09-18', forma_pago: 'transferencia' }
    const dup = CreateOrdenSchema.safeParse({ ...base, lineas: [{ factura_id: 3, monto: 10 }, { factura_id: 3, monto: 5 }] })
    expect(dup.success).toBe(false)
    if (!dup.success) expect(JSON.stringify(dup.error.issues)).toContain('LINEA_DUPLICADA')
    const ok = CreateOrdenSchema.safeParse({ ...base, lineas: [{ factura_id: 3, monto: 10 }, { tipo: 'nota_credito', factura_id: 3, monto: 5, nc_numero: 'NC 1', nc_fecha: '2026-09-10' }] })
    expect(ok.success).toBe(true)
  })
  it('CreateOrdenSchema: forma_pago puede ser null (solo NC); adjuntos default []', () => {
    const r = CreateOrdenSchema.safeParse({ proveedor_id: 1, fecha: '2026-09-18', forma_pago: null, lineas: [{ tipo: 'nota_credito', factura_id: 3, monto: 5, nc_numero: 'NC 1', nc_fecha: '2026-09-10' }] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.adjuntos).toEqual([])
  })
  it('UpdateOrdenSchema solo obs y referencia', () => {
    expect(UpdateOrdenSchema.safeParse({ obs: 'x', referencia: 'y' }).success).toBe(true)
    expect(UpdateOrdenSchema.safeParse({ monto: 1 }).success).toBe(false)
    expect(UpdateOrdenSchema.safeParse({ cbu_destino: '1' }).success).toBe(false)
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
