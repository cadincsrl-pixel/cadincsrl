import { z } from 'zod'

export const CreateCobroSchema = z.object({
  empresa_id:        z.number().int().positive(),
  fecha_desde:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_hasta:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toneladas_totales: z.number().nonnegative(),
  total:             z.number().nonnegative(),
  obs:               z.string().optional().default(''),
  // Factura emitida por CADINC — obligatorios (validado en el service) cuando
  // la empresa tiene modalidad_cobro='facturacion'; ignorados para el resto.
  factura_nro:       z.string().max(50).optional(),
  factura_fecha:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tramo_ids:         z.array(z.number().int().positive()).optional().default([]),
}).refine(d => d.fecha_desde <= d.fecha_hasta, {
  message: 'fecha_desde debe ser <= fecha_hasta',
  path: ['fecha_hasta'],
})

export type CreateCobroDto = z.infer<typeof CreateCobroSchema>

// Contra factura del intermediario (2026-09-02). La empresa intermediaria
// (empresas_transportistas.contra_factura = true) emite UNA contra factura por
// cada factura de CADINC, con su comisión. El documento (nº + fecha) vive en el
// cobro; el importe se carga POR VIAJE en tramos.comision_intermediario porque
// el % varía viaje a viaje. Los montos vienen CON IVA (convención del sistema).
//
// `monto: null` NO es "sin cambios": es un borrado explícito de la comisión de
// ese viaje (el usuario tiene que poder corregir un monto mal cargado). Los
// viajes que no vengan en el array quedan como estaban.
export const ContraFacturaSchema = z.object({
  contra_factura_nro:   z.string().trim().max(50).nullable().optional(),
  contra_factura_fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  comisiones: z.array(z.object({
    tramo_id: z.number().int().positive(),
    monto:    z.number().nonnegative().nullable(),
  })).optional().default([]),
})

export type ContraFacturaDto = z.infer<typeof ContraFacturaSchema>
