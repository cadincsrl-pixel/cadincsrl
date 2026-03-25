import { z } from 'zod'

export const CreateViajeSchema = z.object({
  chofer_id: z.number(),
  camion_id: z.number(),
  obs:       z.string().optional().default(''),
})

export const CargaSchema = z.object({
  viaje_id:   z.number(),
  fecha:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cantera_id: z.number(),
  toneladas:  z.number().optional(),
  remito_num: z.string().optional().default(''),
  remito_url: z.string().optional(),
  obs:        z.string().optional().default(''),
})

export const DescargaSchema = z.object({
  viaje_id:    z.number(),
  fecha:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deposito_id: z.number(),
  toneladas:   z.number().optional(),
  remito_num:  z.string().optional().default(''),
  remito_url:  z.string().optional(),
  obs:         z.string().optional().default(''),
})

export type CreateViajeDto = z.infer<typeof CreateViajeSchema>
export type CargaDto       = z.infer<typeof CargaSchema>
export type DescargaDto    = z.infer<typeof DescargaSchema>